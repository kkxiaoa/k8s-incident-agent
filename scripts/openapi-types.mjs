import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const OPENAPI_ARTIFACT = path.join(
  REPOSITORY_ROOT,
  "contracts/agent-runtime.openapi.json",
);
const GENERATED_TYPES = path.join(
  REPOSITORY_ROOT,
  "src/lib/agent-runtime/generated.ts",
);
const PYTHON_EXPORTER = path.join(
  REPOSITORY_ROOT,
  "services/agent-runtime/.venv/bin/agent-runtime-openapi",
);
const OPENAPI_TYPESCRIPT = path.join(
  REPOSITORY_ROOT,
  "node_modules/.bin/openapi-typescript",
);

function temporaryPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.tmp`,
  );
}

async function runCommand(command, arguments_) {
  await execFileAsync(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function sameBytes(left, right) {
  return existsSync(right) && readFileSync(left).equals(readFileSync(right));
}

async function replaceIfChanged(source, target) {
  if (sameBytes(source, target)) {
    await rm(source, { force: true });
    return;
  }
  renameSync(source, target);
}

async function run(action) {
  mkdirSync(path.dirname(OPENAPI_ARTIFACT), { recursive: true });
  mkdirSync(path.dirname(GENERATED_TYPES), { recursive: true });
  const temporaryArtifact = temporaryPath(OPENAPI_ARTIFACT);
  const temporaryTypes = temporaryPath(GENERATED_TYPES);

  try {
    await runCommand(PYTHON_EXPORTER, [
      "export",
      "--output",
      temporaryArtifact,
    ]);
    await runCommand(OPENAPI_TYPESCRIPT, [
      temporaryArtifact,
      "--output",
      temporaryTypes,
    ]);

    if (action === "check") {
      if (
        !sameBytes(temporaryArtifact, OPENAPI_ARTIFACT) ||
        !sameBytes(temporaryTypes, GENERATED_TYPES)
      ) {
        throw new Error("OpenAPI artifact or generated types are out of date");
      }
      return;
    }

    await replaceIfChanged(temporaryArtifact, OPENAPI_ARTIFACT);
    await replaceIfChanged(temporaryTypes, GENERATED_TYPES);
  } finally {
    await rm(temporaryArtifact, { force: true });
    await rm(temporaryTypes, { force: true });
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMainModule) {
  const [action, ...extraArguments] = process.argv.slice(2);
  if (
    extraArguments.length !== 0 ||
    (action !== "generate" && action !== "check")
  ) {
    console.error("FAIL invalid_arguments expected exactly one action: generate or check");
    process.exitCode = 1;
  } else {
    try {
      await run(action);
    } catch {
      console.error("FAIL openapi_types_failed OpenAPI artifacts could not be generated or verified");
      process.exitCode = 1;
    }
  }
}
