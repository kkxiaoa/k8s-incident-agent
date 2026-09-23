import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { loadRelease, ReleaseError } from "./release.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function matchesCandidateConfig(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  if (!Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual[key], value))) return false;
  // Docker container.Config (including API 1.48) adds zero values absent from
  // OCI config. Ignore inspection metadata, but not added launch behavior.
  const defaults = {
    Hostname: "", Domainname: "", User: "", WorkingDir: "", StopSignal: "", MacAddress: "",
    AttachStdin: false, AttachStdout: false, AttachStderr: false,
    Tty: false, OpenStdin: false, StdinOnce: false, ArgsEscaped: false, NetworkDisabled: false,
    Env: [], Cmd: [], Entrypoint: [], Shell: [], OnBuild: [], ExposedPorts: {}, Volumes: {},
    Healthcheck: null, StopTimeout: null,
  };
  return Object.entries(defaults).every(([key, value]) =>
    Object.hasOwn(expected, key) || actual[key] == null || isDeepStrictEqual(actual[key], value));
}

async function command(program, args, timeout = 120_000, step = program) {
  try {
    return (await exec(program, args, { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout;
  } catch (error) {
    const status = error.killed ? `stopped after ${timeout / 1000} s` : `exit ${error.code ?? error.signal}`;
    // One JSON line: candidate output cannot start a line with a workflow command.
    const tail = String(error.stderr ?? "").trim().slice(-4000);
    throw new ReleaseError("release_smoke_failed",
      `${step} failed during isolated candidate smoke (${status})${tail ? `: ${JSON.stringify(tail)}` : ""}`);
  }
}

async function container(args, scratch, timeout, step) {
  const cidFile = path.join(scratch, `${randomUUID()}.cid`);
  try {
    return await command("docker", ["run", "--rm", "--cidfile", cidFile,
      "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", ...args], timeout, step);
  } finally {
    const id = await readFile(cidFile, "utf8").catch(() => "");
    if (/^[a-f0-9]{64}$/.test(id.trim())) {
      // Only this invocation's daemon-issued container ID, including timeout cleanup.
      await command("docker", ["container", "rm", "--force", id.trim()]).catch(() => {});
    }
  }
}

async function main() {
  const [option, filename, ...extra] = process.argv.slice(2);
  if (option !== "--release" || !filename || extra.length) {
    throw new ReleaseError("invalid_arguments", "Use release-smoke.mjs --release <release.json>");
  }
  const release = await loadRelease(filename, root);
  const bundle = await realpath(path.dirname(path.resolve(filename)));
  const tools = JSON.parse(await readFile(path.join(root, ".github/ci/release-tools.json"), "utf8"));
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "incident-release-smoke-")));
  try {
    if ([bundle, root, scratch].some(value => /[:,\r\n]/.test(value))) {
      throw new ReleaseError("invalid_arguments", "Smoke paths cannot contain mount separators");
    }
    const tls = path.join(scratch, "tls");
    await mkdir(tls, { mode: 0o755 });
    await chmod(tls, 0o755);
    await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", path.join(tls, "key.pem"), "-out", path.join(tls, "ca.crt")]);
    await writeFile(path.join(tls, "token"), "isolated-smoke-with-no-cluster-authority", { mode: 0o644 });
    // These ephemeral test-only credentials have no external authority. The
    // candidate's non-root UID must read them even under a private host umask.
    for (const name of ["key.pem", "ca.crt", "token"]) await chmod(path.join(tls, name), 0o644);
    await command("docker", ["pull", tools.skopeo], 5 * 60_000);
    const results = [];
    for (const [component, identity] of Object.entries(release.images)) {
      const layout = path.join(bundle, `${component}-oci`);
      for (const [platform, digest] of Object.entries(identity.platforms)) {
        const architecture = platform.split("/")[1];
        const manifest = JSON.parse(await readFile(path.join(layout, "blobs/sha256", digest.slice(7)), "utf8"));
        const configId = manifest.config.digest;
        const config = JSON.parse(await readFile(path.join(layout, "blobs/sha256", configId.slice(7)), "utf8"));
        const check = `${component} ${platform}`;
        const archiveName = `${component}-${architecture}.tar`;
        const localReference = `k8s-incident-agent-smoke:${component}-${architecture}-${configId.slice(7)}`;
        await container(["--user", `${process.getuid()}:${process.getgid()}`, "--read-only",
          "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777",
          "--tmpfs", "/var/tmp:rw,nosuid,nodev,mode=1777",
          "--volume", `${layout}:/input:ro`, "--volume", `${scratch}:/output:rw`,
          tools.skopeo, "--override-os", "linux", "--override-arch", architecture, "copy",
          "oci:/input", `docker-archive:/output/${archiveName}:${localReference}`], scratch, 10 * 60_000, `${check} conversion`);
        await command("docker", ["load", "--input", path.join(scratch, archiveName)], 10 * 60_000, `${check} import`);
        await rm(path.join(scratch, archiveName));
        const [image] = JSON.parse(await command("docker", ["image", "inspect", localReference], 120_000, `${check} inspection`));
        if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id) || image?.Os !== "linux" || image?.Architecture !== architecture ||
            !Array.isArray(config?.config?.Cmd) || config.config.Cmd.length === 0 ||
            !matchesCandidateConfig(image?.Config, config.config) ||
            !isDeepStrictEqual(image?.RootFS, { Type: config?.rootfs?.type, Layers: config?.rootfs?.diff_ids })) {
          throw new ReleaseError("release_smoke_failed", `${check} imported image differs from the verified candidate config`);
        }
        const args = ["--platform", platform, "--pull=never", "--read-only", "--pids-limit=128", "--memory=1g",
          "--tmpfs", "/tmp:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700"];
        if (component === "runtime") {
          args.push("--tmpfs", "/var/lib/k8s-incident-agent/runtime:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700",
            "--volume", `${tls}:/smoke/tls:ro`,
            "--volume", `${tls}:/var/run/secrets/kubernetes.io/serviceaccount:ro`,
            "--volume", `${path.join(root, ".github/ci/smoke-runtime.py")}:/smoke/runtime.py:ro`,
            "--entrypoint", "python", image.Id, "/smoke/runtime.py");
        } else {
          args.push("--volume", `${path.join(root, ".github/ci/smoke-console.mjs")}:/smoke/console.mjs:ro`,
            "--entrypoint", "node", image.Id, "/smoke/console.mjs");
        }
        // Exceeds the in-container startup deadline, which reports its own failure.
        await container([...args, architecture, JSON.stringify(image.Config.Cmd)], scratch, 7 * 60_000, `${check} startup`);
        results.push({ component, platform, status: "passed" });
      }
    }
    // Detect modifications to the bundle or source during image execution.
    await loadRelease(filename, root);
    console.log(JSON.stringify({ sourceRevision: release.sourceRevision, checks: results }, null, 2));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof ReleaseError ? `FAIL ${error.code}: ${error.message}` : "FAIL release_smoke_failed: Candidate smoke failed");
  process.exitCode = 1;
});
