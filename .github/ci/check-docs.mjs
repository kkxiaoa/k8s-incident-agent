import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import GithubSlugger from "github-slugger";

const markdown = new MarkdownIt({ html: true });
const privatePath = /^(?:docs|\.runtime|\.codex|\.codex-log|\.ssh)(?:\/|$)/;
// Plan, task and decision-record identifiers point into the ignored internal records;
// the published tree describes capabilities, contracts and procedures only.
const internalIdentifier = /\b(?:Stage ?\d+(?:\.\d+)*|Tasks? ?\d+|Milestone [A-Z\d]\b|(?:DC|OS)-\d+[A-Z]?\b|ADR-\d{4}\b)/g;

export function inspectMarkdown(source) {
  const tokens = markdown.parse(source, {});
  const slugger = new GithubSlugger();
  const anchors = new Set();
  const links = [];
  const diagrams = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "heading_open") {
      const text = (tokens[i + 1].children ?? []).map(t => {
        if (["text", "code_inline", "image"].includes(t.type)) return t.content;
        return t.type === "softbreak" ? " " : "";
      }).join("");
      anchors.add(slugger.slug(text));
    }
    if (token.type === "fence" && token.info.trim() === "mermaid") diagrams.push(token.content);
    for (const child of token.children ?? []) {
      if (child.type === "link_open") links.push(child.attrGet("href"));
      if (child.type === "image") links.push(child.attrGet("src"));
    }
    if (token.type === "html_block" || token.children?.some(t => t.type === "html_inline")) {
      for (const match of token.content.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) links.push(match[1]);
      for (const match of token.content.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);
    }
  }
  return { anchors, links, diagrams };
}

export function checkLinks(documents, publicFiles) {
  const failures = [];
  for (const [file, document] of documents) {
    for (const href of document.links) {
      if (/^(?:https?:|mailto:)/i.test(href)) continue;
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) {
        failures.push(`${file}: non-public link scheme`);
        continue;
      }
      let target, fragment;
      try {
        const parts = href.split("#");
        const pathname = decodeURIComponent(parts[0].split("?")[0]);
        fragment = decodeURIComponent(parts.slice(1).join("#"));
        target = pathname ? path.posix.normalize(path.posix.join(path.posix.dirname(file), pathname)) : file;
        if (pathname.startsWith("/")) target = "../";
      } catch {
        failures.push(`${file}: invalid URL encoding`);
        continue;
      }
      if (target.startsWith("../") || privatePath.test(target)) {
        failures.push(`${file}: link leaves public repository: ${target}`);
      } else if (!publicFiles.has(target) && ![...publicFiles].some(f => f.startsWith(`${target.replace(/\/$/, "")}/`))) {
        failures.push(`${file}: missing public target ${target}`);
      } else if (fragment && documents.has(target) && !documents.get(target).anchors.has(fragment)) {
        failures.push(`${file}: missing anchor ${target}#${fragment}`);
      }
    }
  }
  return failures;
}

// Release Please writes the changelog from merged pull request titles, and this
// check's own tests must spell out the identifiers it rejects.
const identifierExemptions = new Set(["CHANGELOG.md", ".github/ci/check-docs.test.mjs"]);

export function findInternalIdentifiers(file, source) {
  if (identifierExemptions.has(file)) return [];
  return source.split("\n").flatMap((line, index) =>
    [...line.matchAll(internalIdentifier)].map(match => `${file}:${index + 1}: internal identifier "${match[0]}"`));
}

async function main() {
  // Git's public surface excludes local ignored docs, databases and credentials.
  const files = new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean));
  const privateFiles = [...files].filter(f => privatePath.test(f));
  if (privateFiles.length) throw new Error(`Private paths in publication surface: ${privateFiles.join(", ")}`);
  const documents = new Map();
  const failures = [];
  let textFiles = 0;
  for (const file of files) {
    const content = await readFile(file);
    if (content.includes(0)) continue;
    const source = content.toString("utf8");
    textFiles++;
    failures.push(...findInternalIdentifiers(file, source));
    if (file.endsWith(".md")) documents.set(file, inspectMarkdown(source));
  }
  failures.push(...checkLinks(documents, files));
  const en = documents.get("README.md")?.diagrams[0];
  const zh = documents.get("README.zh-CN.md")?.diagrams[0];
  if (!en || en !== zh) failures.push("README component diagrams must be present and identical");
  if (failures.length) throw new Error(failures.join("\n"));
  const diagrams = [...documents.values()].flatMap(doc => doc.diagrams);
  if (process.argv.includes("--render")) {
    const { default: puppeteer } = await import("puppeteer");
    const { renderMermaid } = await import("@mermaid-js/mermaid-cli");
    const directory = await mkdtemp(path.join(os.tmpdir(), "incident-mermaid-"));
    const browser = await puppeteer.launch({ channel: "chrome", headless: true, userDataDir: directory });
    try {
      for (const diagram of diagrams) {
        const { data } = await renderMermaid(browser, diagram, "svg", { viewport: { width: 2400, height: 1800 } });
        if (!data.length) throw new Error("Mermaid produced an empty SVG");
      }
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  console.log(`Public docs: ${documents.size} files, ${[...documents.values()].reduce((n, d) => n + d.links.length, 0)} links, ${diagrams.length} Mermaid blocks${process.argv.includes("--render") ? " rendered" : " (render not requested)"}; ${textFiles} text files checked for internal identifiers`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
