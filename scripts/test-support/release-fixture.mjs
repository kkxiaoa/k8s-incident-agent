import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

// Reduced captured Buildx layout. The opaque layer tests transport integrity,
// not container execution; no production code consumes this fixture.
export function createReleaseFixture(bundle, revision, options = {}) {
  const type = name => `application/vnd.oci.image.${name}.v1+json`;
  const manifest = { schemaVersion: 1, sourceRevision: revision, images: {} };
  const files = {};
  for (const component of ["console", "runtime"]) {
    const layout = path.join(bundle, `${component}-oci`);
    const blobs = path.join(layout, "blobs", "sha256");
    mkdirSync(blobs, { recursive: true });
    function blob(value, mediaType) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const filename = path.join(blobs, digest.slice(7));
      writeFileSync(filename, bytes);
      return { descriptor: { mediaType, digest, size: bytes.length }, filename };
    }
    const layerContent = Buffer.from(`synthetic ${component} layer`);
    const layer = blob(gzipSync(layerContent), "application/vnd.oci.image.layer.v1.tar+gzip");
    const diffId = `sha256:${createHash("sha256").update(layerContent).digest("hex")}`;
    files[`${component}Layer`] = layer.filename;
    const children = [];
    const platforms = {};
    for (const architecture of options.platforms ?? ["amd64", "arm64"]) {
      const config = blob({ architecture: options.configArchitecture ?? architecture, os: "linux",
        config: { User: options.user ?? "10001:10001", Cmd: component === "console" ? ["node", "server.js"] : ["uvicorn", "k8s_incident_agent.api:create_runtime_app", "--factory"], Labels: {
          "org.opencontainers.image.revision": component === "runtime" ? (options.runtimeRevision ?? revision) : revision,
        } }, rootfs: { type: "layers", diff_ids: [diffId] } }, type("config"));
      const child = blob({ schemaVersion: 2, mediaType: type("manifest"),
        config: config.descriptor, layers: [layer.descriptor] }, type("manifest"));
      children.push({ ...child.descriptor, platform: { architecture, os: "linux" } });
      platforms[`linux/${architecture}`] = child.descriptor.digest;
    }
    const index = blob({ schemaVersion: 2, mediaType: type("index"), manifests: children }, type("index"));
    files[`${component}Index`] = index.filename;
    writeFileSync(path.join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, mediaType: type("index"), manifests: [index.descriptor] }));
    writeFileSync(path.join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
    manifest.images[component] = { repository: `ghcr.io/kkxiaoa/k8s-incident-agent-${component}`, indexDigest: index.descriptor.digest, platforms };
  }
  const release = path.join(bundle, "release.json");
  const save = () => writeFileSync(release, JSON.stringify(manifest));
  save();
  return { bundle, release, manifest, files, save };
}

// CLI integration tests isolate the Git producer as they isolate kubectl.
// release.test.mjs separately exercises source identity against a real checkout.
export function gitFixtureEnvironment(directory, revision, dirty = false) {
  const bin = path.join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === 'rev-parse --show-toplevel') console.log(process.cwd());
else if (args.join(' ') === 'rev-parse HEAD') console.log(${JSON.stringify(revision)});
else if (args[0] === 'status') process.stdout.write(${JSON.stringify(dirty ? " M source-file\n" : "")});
else process.exit(1);
`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

export function releaseImages(manifest) {
  return Object.entries(manifest.images).map(([component, image]) => ({
    name: `k8s-incident-agent-${component}`, newName: image.repository, digest: image.indexDigest,
  }));
}
