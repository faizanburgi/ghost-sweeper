import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findUnreferencedMarkdown } from "../src/markdown.js";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("Markdown cleanup candidates", () => {
  it("follows local links from recognized guides and reports unreferenced docs with a caveat", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ghost-sweeper-markdown-test-"));
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, ".github", "ISSUE_TEMPLATE"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "[Getting started](docs/start.md)\n");
    await writeFile(path.join(root, "docs", "start.md"), "[Setup](setup)\n");
    await writeFile(path.join(root, "docs", "setup.md"), "# Setup\n");
    await writeFile(path.join(root, "docs", "old-runbook.md"), "# Old runbook\n");
    await writeFile(path.join(root, "AGENTS.md"), "# Project instructions\n");
    await writeFile(path.join(root, ".github", "ISSUE_TEMPLATE", "bug.md"), "# Bug report\n");

    const findings = await findUnreferencedMarkdown(root);
    expect(findings.map((finding) => finding.name)).toEqual(["docs/old-runbook.md"]);
    expect(findings[0]).toMatchObject({
      kind: "markdown",
      risk: "uncertain",
      action: "delete-file"
    });
    expect(findings[0].reason).toContain("No path from a recognized project guide");
    expect(findings[0].reason).toContain("standalone guides may not be detected");
  });

  it("does not treat an outside-project link as a reference", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ghost-sweeper-markdown-outside-test-"));
    await writeFile(path.join(root, "README.md"), "[Outside](../../private-guide.md)\n");
    await writeFile(path.join(root, "guide.md"), "# Local guide\n");
    const findings = await findUnreferencedMarkdown(root);
    expect(findings.map((finding) => finding.name)).toEqual(["guide.md"]);
  });
});
