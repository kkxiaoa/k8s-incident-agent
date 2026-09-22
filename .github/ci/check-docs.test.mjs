import assert from "node:assert/strict";
import test from "node:test";
import { checkLinks, inspectMarkdown } from "./check-docs.mjs";

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
