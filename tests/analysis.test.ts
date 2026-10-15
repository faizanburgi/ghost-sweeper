import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { normalizeKnipReport } from "../src/analysis.ts";
import { analyze } from "../src/analysis.ts";

let scratch = "";

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("Knip result normalization", () => {
  it("makes only in-project unused files eligible for deletion", () => {
    const root = path.resolve("/fixture");
    const report = {
      issues: [
        { file: "src/legacy.ts", files: [{ name: "src/legacy.ts" }] },
        { file: "src/api.ts", exports: [{ name: "oldApi", line: 8 }] },
        { file: "../../outside.ts", files: [{ name: "../../outside.ts" }] }
      ]
    };
    const findings = normalizeKnipReport(report, root);
    expect(findings).toHaveLength(3);
    expect(findings[0].action).toBe("delete-file");
    expect(findings[0].path).toBe(path.join(root, "src", "legacy.ts"));
    expect(findings[1].action).toBe("view-only");
    expect(findings[2].action).toBe("view-only");
    expect(findings[2].path).toBeUndefined();
  });

  it("scans a basic TypeScript project through the bundled Knip JSON boundary", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "ghost-sweeper-knip-test-"));
    await mkdir(path.join(scratch, "src"), { recursive: true });
    await writeFile(path.join(scratch, "package.json"), JSON.stringify({ name: "knip-fixture", type: "module" }));
    await writeFile(path.join(scratch, "README.md"), "# Fixture\n");
    await writeFile(path.join(scratch, "src", "index.ts"), "export const live = 1;\n");
    await writeFile(path.join(scratch, "src", "legacy.ts"), "export const abandoned = 2;\n");
    await writeFile(path.join(scratch, "old-guide.md"), "# Unlinked guide\n");
    const result = await analyze(scratch);
    expect(result.knipVersion).toMatch(/^6\./);
    expect(result.findings.some((item) => item.kind === "file" && item.path === path.join(scratch, "src", "legacy.ts"))).toBe(true);
    expect(result.findings.some((item) => item.kind === "markdown" && item.path === path.join(scratch, "old-guide.md"))).toBe(true);
  });
});
