import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMarkdownMatchGroups, findUnreferencedMarkdown } from "../src/markdown.js";

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

describe("local Markdown comparisons", () => {
  it("finds normalized duplicates and marks protected guides as comparison-only", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ghost-sweeper-md-duplicate-"));
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Setup\n\nInstall the package and configure the application.\n");
    await writeFile(path.join(root, "docs", "setup-copy.md"), " # Setup \n\nInstall the package and configure the application. \n");
    const groups = await findMarkdownMatchGroups(root);
    expect(groups).toHaveLength(1);
    expect(groups[0].relationship).toBe("duplicate");
    expect(groups[0].files.find((file) => file.path === "README.md")?.protected).toBe(true);
  });

  it("distinguishes overlapping/related documents and skips unrelated documents", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ghost-sweeper-md-similarity-"));
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "install.md"), "# Install Guide\n\nInstall the package with npm install. Configure the application using the settings file.\n");
    await writeFile(path.join(root, "docs", "upgrade.md"), "# Upgrade Guide\n\nInstall the package with npm install. Configure the application using the settings file. Back up your database first.\n");
    await writeFile(path.join(root, "docs", "deployment.md"), "# Deployment Operations\n\nDeploy containers to production clusters. Monitor availability and review incident alerts.\n");
    await writeFile(path.join(root, "docs", "gardening.md"), "# Tomato Gardening\n\nWater seedlings and add compost to the raised garden bed.\n");
    await writeFile(path.join(root, "docs", "api-reference.md"), "# API Overview\n\nThe request endpoint accepts a token, validates the caller, and returns a paginated result.\n");
    await writeFile(path.join(root, "docs", "api-operations.md"), "# API Overview\n\nMonitor latency, rotate service credentials, and investigate gateway errors during incidents.\n");
    const groups = await findMarkdownMatchGroups(root);
    expect(groups.some((group) => group.relationship === "overlapping" && group.files.some((file) => file.path.endsWith("install.md")) && group.files.some((file) => file.path.endsWith("upgrade.md")))).toBe(true);
    expect(groups.some((group) => group.files.some((file) => file.path.endsWith("gardening.md")))).toBe(false);
    expect(groups.some((group) => group.relationship === "related" && group.files.some((file) => file.path.endsWith("api-reference.md")) && group.files.some((file) => file.path.endsWith("api-operations.md")))).toBe(true);
  });
});
