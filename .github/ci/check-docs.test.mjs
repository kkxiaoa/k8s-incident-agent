import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkLinks, findInternalIdentifiers, inspectMarkdown } from "./check-docs.mjs";

test("Markdown semantics cover repeated headings, inline formatting, references and images", () => {
  const doc = inspectMarkdown('# Hello `API`\n\n## 重复\n\n## 重复\n\n[reference][r]\n\n![image](assets/ui.png)\n\n[r]: guide.md#details\n\n```mermaid\nflowchart LR\n A-->B\n```\n');
  assert.deepEqual([...doc.anchors], ["hello-api", "重复", "重复-1"]);
  assert.deepEqual(doc.links, ["guide.md#details", "assets/ui.png"]);
  assert.equal(doc.diagrams.length, 1);
});

test("valid relative, fragment, encoded and external links pass without network access", () => {
  const docs = new Map([
    ["README.md", inspectMarkdown('# Start\n\n[here](#start) [guide](documentation/guide.md#details) [asset](assets/a%20b.svg) [web](https://example.org)')],
    ["documentation/guide.md", inspectMarkdown('## Details\n\n[back](../README.md#start)')],
  ]);
  assert.deepEqual(checkLinks(docs, new Set([...docs.keys(), "assets/a b.svg"])), []);
});

for (const [href, expected] of [
  ["missing.md", /missing public target/],
  ["#absent", /missing anchor/],
  ["docs/README.md", /leaves public/],
  ["%2e%2e/credentials", /leaves public/],
  [".runtime/file.json", /leaves public/],
  ["file:///private/file", /non-public link scheme/],
  ["%ZZ", /invalid URL/],
]) {
  test(`rejects broken or private link ${href}`, () => {
    const doc = inspectMarkdown("# Start\n");
    doc.links.push(href);
    assert.match(checkLinks(new Map([["README.md", doc]]), new Set(["README.md", "docs/README.md"])).join("\n"), expected);
  });
}

test("public docs reject internal plan, task and decision-record identifiers", () => {
  const source = [
    "Stage 2 Task 2 renders the monitoring stack for Stage 1.5 profiles.",
    "| OOM | DC-4A rule | Live pending DC-8 |",
    "Milestone B covers OS-8; Tasks 1–12 follow ADR-0011.",
  ].join("\n");
  assert.deepEqual(findInternalIdentifiers("scripts/README.md", source), [
    'scripts/README.md:1: internal identifier "Stage 2"',
    'scripts/README.md:1: internal identifier "Task 2"',
    'scripts/README.md:1: internal identifier "Stage 1.5"',
    'scripts/README.md:2: internal identifier "DC-4A"',
    'scripts/README.md:2: internal identifier "DC-8"',
    'scripts/README.md:3: internal identifier "Milestone B"',
    'scripts/README.md:3: internal identifier "OS-8"',
    'scripts/README.md:3: internal identifier "Tasks 1"',
    'scripts/README.md:3: internal identifier "ADR-0011"',
  ]);
});

test("product states, result semantics, domain wording and release history pass", () => {
  const source = [
    "`doctor` 使用逐项 `PASS` / `FAIL` 输出；`pending_manual_review` is not semantic PASS.",
    "Execution statuses are `PENDING` and `UNKNOWN`; the merged PR keeps `autorelease: pending`.",
    "`runtime reset-stage-one-data` also runs on macOS-15; live pending alerts use a live pass-through.",
    "live 通过 port-forward 访问；A multi-stage build retries the task 3 times; see the ADRs.",
  ].join("\n");
  assert.deepEqual(findInternalIdentifiers("documentation/guide.md", source), []);
  assert.deepEqual(findInternalIdentifiers("CHANGELOG.md", "* **deploy:** finish Task 3"), []);
  assert.deepEqual(findInternalIdentifiers(".github/ci/check-docs.test.mjs", "Task 3"), []);
});

test("the publication check reports internal identifiers in tracked text and skips binaries", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "check-docs-"));
  try {
    const diagram = "```mermaid\nflowchart LR\n A-->B\n```\n";
    writeFileSync(path.join(directory, "README.md"), `# Start\n\n${diagram}`);
    writeFileSync(path.join(directory, "README.zh-CN.md"), `# 开始\n\n${diagram}`);
    writeFileSync(path.join(directory, "guide.md"), "# Guide\n\nShipped in Task 3.\n");
    writeFileSync(path.join(directory, "tool.js"), "// Added for DC-4.\n");
    writeFileSync(path.join(directory, "logo.png"), Buffer.from("\u0089PNG\u0000Task 5"));
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-docs.mjs", import.meta.url))], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.stderr.trim().split("\n").sort(), [
      'guide.md:3: internal identifier "Task 3"',
      'tool.js:1: internal identifier "DC-4"',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
