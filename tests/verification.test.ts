import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStagedCleanup, preview, removeStagedCleanup } from "../src/safety.js";
import type { Finding, ScanResult, StagedCleanup } from "../src/model.js";
import { listVerificationScripts, runVerificationScript } from "../src/verification.js";

let scratch = "";
const stages: StagedCleanup[] = [];

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "ghost-sweeper-verify-test-"));
});

afterAll(async () => {
  for (const stage of stages) await removeStagedCleanup(stage);
  await rm(scratch, { recursive: true, force: true });
});

async function makeStage(name: string, script: string, extraFiles: Record<string, string> = {}): Promise<{ root: string; stage: StagedCleanup }> {
  const root = path.join(scratch, name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name, type: "module", scripts: { test: script } }));
  await writeFile(path.join(root, "old.ts"), "export const oldValue = 1;\n");
  for (const [file, contents] of Object.entries(extraFiles)) await writeFile(path.join(root, file), contents);
  const scan = { root } as ScanResult;
  const finding = { id: name, kind: "file", name: "old.ts", path: path.join(root, "old.ts"), risk: "review-recommended", action: "delete-file" } as Finding;
  const stage = await createStagedCleanup(root, await preview(scan, [finding]));
  stages.push(stage);
  return { root, stage };
}

describe("approved staged verification", () => {
  it("lists supported scripts and runs them only in the staged copy", async () => {
    const { root, stage } = await makeStage("success", "node verify.js", {
      "verify.js": 'import { writeFile } from "node:fs/promises"; await writeFile("verified.txt", "ok");\n'
    });
    expect(await listVerificationScripts(root)).toEqual([{ name: "test", command: ["npm", "run", "test"] }]);
    const result = await runVerificationScript(stage, "test");
    expect(result.result.status).toBe("passed");
    expect(await readFile(path.join(stage.tempRoot, "project", "verified.txt"), "utf8")).toBe("ok");
    await expect(readFile(path.join(root, "verified.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records a failing approved script without changing the original project", async () => {
    const { root, stage } = await makeStage("failure", "node -e \"process.exit(7)\"");
    const result = await runVerificationScript(stage, "test");
    expect(result.result.status).toBe("failed");
    expect(result.result.exitCode).toBe(7);
    expect(await readFile(path.join(root, "old.ts"), "utf8")).toContain("oldValue");
  });
});
