import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let scratch = "";
let stateDir = "";
let safety: typeof import("../src/safety.ts");

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "ghost-sweeper-test-"));
  stateDir = path.join(scratch, "state");
  process.env.GHOST_SWEEPER_STATE_DIR = stateDir;
  safety = await import("../src/safety.ts");
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function gitProject(name: string): Promise<string> {
  const root = path.join(scratch, name);
  await mkdir(root, { recursive: true });
  const git = spawnSync("git", ["-C", root, "init", "--quiet"], { encoding: "utf8" });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  return root;
}

describe("safe cleanup sessions", () => {
  it("backs up a selected file before deleting it and restores it on undo", async () => {
    const root = await gitProject("roundtrip");
    const file = path.join(root, "legacy.ts");
    const original = "export const oldValue = 42;\n";
    await writeFile(file, original);
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f1", kind: "file", name: "legacy.ts", path: file, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    const preview = await safety.preview(scan, [finding]);
    const session = await safety.applyCleanup(root, preview);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(session.status).toBe("applied");
    const restored = await safety.undo(session.id);
    expect(restored.status).toBe("restored");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("does not overwrite a file recreated after cleanup", async () => {
    const root = await gitProject("conflict");
    const file = path.join(root, "legacy.ts");
    await writeFile(file, "original\n");
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f2", kind: "file", name: "legacy.ts", path: file, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    const preview = await safety.preview(scan, [finding]);
    const session = await safety.applyCleanup(root, preview);
    await writeFile(file, "user edit\n");
    await expect(safety.undo(session.id)).rejects.toThrow(/recreated paths/);
    expect(await readFile(file, "utf8")).toBe("user edit\n");
  });

  it("refuses to apply when a target changed after preview", async () => {
    const root = await gitProject("stale-preview");
    const file = path.join(root, "legacy.ts");
    await writeFile(file, "before\n");
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f3", kind: "file", name: "legacy.ts", path: file, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    const preview = await safety.preview(scan, [finding]);
    await writeFile(file, "changed after preview\n");
    await expect(safety.applyCleanup(root, preview)).rejects.toThrow(/changed after preview/);
    expect(await readFile(file, "utf8")).toBe("changed after preview\n");
  });
});
