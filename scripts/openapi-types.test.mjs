import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_SCRIPT = path.join(REPOSITORY_ROOT, "scripts/openapi-types.mjs");

function createFixture(t) {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "k8s-incident-agent-openapi-test-"),
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const script = path.join(root, "scripts/openapi-types.mjs");
  mkdirSync(path.dirname(script), { recursive: true });
  copyFileSync(SOURCE_SCRIPT, script);
  symlinkSync(path.join(REPOSITORY_ROOT, "node_modules"), path.join(root, "node_modules"));

  const sourceSchema = path.join(root, "stub-schema.json");
  const canonicalSchema = `${JSON.stringify(
    {
      components: {
        schemas: {
          HealthResponse: {
            properties: { status: { const: "ok", type: "string" } },
            required: ["status"],
            type: "object",
          },
        },
      },
      info: { title: "Fixture Runtime", version: "0.1.0" },
      openapi: "3.1.0",
      paths: {
        "/healthz": {
          get: {
            responses: {
              200: {
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/HealthResponse",
                    },
                  },
                },
                description: "Successful Response",
              },
            },
          },
        },
      },
    },
    null,
    2,
  )}\n`;
  writeFileSync(sourceSchema, canonicalSchema);

  const exporter = path.join(
    root,
    "services/agent-runtime/.venv/bin/agent-runtime-openapi",
  );
  mkdirSync(path.dirname(exporter), { recursive: true });
  writeFileSync(
    exporter,
    `#!/usr/bin/env node
import { copyFileSync } from "node:fs";
const [action, flag, output, ...extra] = process.argv.slice(2);
if (action !== "export" || flag !== "--output" || output === undefined || extra.length !== 0) {
  process.exit(2);
}
copyFileSync(${JSON.stringify(sourceSchema)}, output);
`,
  );
  chmodSync(exporter, 0o755);

  return {
    root,
    script,
    artifact: path.join(root, "contracts/agent-runtime.openapi.json"),
    generated: path.join(root, "src/lib/agent-runtime/generated.ts"),
    canonicalSchema,
  };
}

function run(fixture, ...args) {
  return execFileAsync(process.execPath, [fixture.script, ...args], {
    cwd: fixture.root,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

async function rejectsCommand(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 1);
    return true;
  });
}

test("importing the generator does not run the command", async (t) => {
  const fixture = createFixture(t);

  await import(pathToFileURL(fixture.script).href);

  assert.equal(existsSync(path.dirname(fixture.artifact)), false);
  assert.equal(existsSync(path.dirname(fixture.generated)), false);
});

test("generate and check use only the fixed local artifact and output", async (t) => {
  const fixture = createFixture(t);

  await rejectsCommand(run(fixture, "check"));
  assert.equal(existsSync(fixture.artifact), false);
  assert.equal(existsSync(fixture.generated), false);

  await run(fixture, "generate");
  assert.equal(readFileSync(fixture.artifact, "utf8"), fixture.canonicalSchema);
  assert.match(
    readFileSync(fixture.generated, "utf8"),
    /export interface paths/,
  );
  await run(fixture, "check");

  const artifactDrift = `${fixture.canonicalSchema} `;
  writeFileSync(fixture.artifact, artifactDrift);
  await rejectsCommand(run(fixture, "check"));
  assert.equal(readFileSync(fixture.artifact, "utf8"), artifactDrift);

  await run(fixture, "generate");
  const generatedDrift = `${readFileSync(fixture.generated, "utf8")}\n`;
  writeFileSync(fixture.generated, generatedDrift);
  await rejectsCommand(run(fixture, "check"));
  assert.equal(readFileSync(fixture.generated, "utf8"), generatedDrift);

  await run(fixture, "generate");
  await rm(fixture.artifact);
  await rejectsCommand(run(fixture, "check"));
  assert.equal(existsSync(fixture.artifact), false);

  await run(fixture, "generate");
  await rm(fixture.generated);
  await rejectsCommand(run(fixture, "check"));
  assert.equal(existsSync(fixture.generated), false);
});

test("the CLI rejects path and URL inputs", async (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.root, "outside.ts");
  writeFileSync(outside, "sentinel");

  await rejectsCommand(run(fixture, "generate", "../outside.ts"));
  await rejectsCommand(
    run(fixture, "generate", "https://example.invalid/openapi.json"),
  );

  assert.equal(readFileSync(outside, "utf8"), "sentinel");
  assert.equal(existsSync(fixture.artifact), false);
  assert.equal(existsSync(fixture.generated), false);
});
