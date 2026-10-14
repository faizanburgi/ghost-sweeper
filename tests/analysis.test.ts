import { describe, expect, it } from "vitest";
import path from "node:path";
import { normalizeKnipReport } from "../src/analysis.ts";

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
});
