import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let scratch = "";
let stateDir = "";
let safety: typeof import("../src/safety.ts");
const stagedCopies: import("../src/model.ts").StagedCleanup[] = [];

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "ghost-sweeper-test-"));
  stateDir = path.join(scratch, "state");
  process.env.GHOST_SWEEPER_STATE_DIR = stateDir;
  safety = await import("../src/safety.ts");
});

afterAll(async () => {
  for (const stage of stagedCopies) await safety.removeStagedCleanup(stage);
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
    await writeFile(path.join(root, "keep.ts"), "export const keep = true;\n");
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f1", kind: "file", name: "legacy.ts", path: file, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    const preview = await safety.preview(scan, [finding]);
    const staged = await safety.createStagedCleanup(root, preview);
    stagedCopies.push(staged);
    expect(await readFile(path.join(staged.tempRoot, "project", "legacy.ts")).catch(() => null)).toBeNull();
    expect(await readFile(path.join(staged.tempRoot, "project", "keep.ts"), "utf8")).toContain("keep = true");
    await expect(readFile(path.join(staged.tempRoot, "project", "node_modules", "pkg", "index.js"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(file, "utf8")).toBe(original);
    const prepared = await safety.prepareCleanup(staged);
    await safety.recordVerification(prepared.id, { command: ["npm", "run", "test"], status: "passed", exitCode: 0, durationMs: 10 });
    const session = await safety.applyCleanup(staged, prepared.id);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(session.status).toBe("applied");
    expect(session.verification[0].status).toBe("passed");
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
    const staged = await safety.createStagedCleanup(root, preview);
    stagedCopies.push(staged);
    const prepared = await safety.prepareCleanup(staged);
    await safety.recordVerification(prepared.id, { command: [], status: "skipped" });
    const session = await safety.applyCleanup(staged, prepared.id);
    await writeFile(file, "user edit\n");
    await expect(safety.undo(session.id)).rejects.toThrow(/recreated paths/);
    expect(await readFile(file, "utf8")).toBe("user edit\n");
  });

  it("restores deleted files and leaves pending files intact after an interrupted apply", async () => {
    const root = await gitProject("interrupted-apply");
    const first = path.join(root, "legacy-one.ts");
    const second = path.join(root, "legacy-two.ts");
    await writeFile(first, "first original\n");
    await writeFile(second, "second original\n");
    const scan = { root } as import("../src/model.ts").ScanResult;
    const findings = [first, second].map((file, index) => ({
      id: `interrupted-${index}`,
      kind: "file",
      name: path.basename(file),
      path: file,
      risk: "review-recommended",
      action: "delete-file"
    } as import("../src/model.ts").Finding));
    const staged = await safety.createStagedCleanup(root, await safety.preview(scan, findings));
    stagedCopies.push(staged);
    const prepared = await safety.prepareCleanup(staged);

    // Model a process exit after the first unlink, before the next operation.
    await rm(first);
    const journalPath = path.join(stateDir, `${prepared.id}.json`);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as import("../src/model.ts").Session;
    journal.status = "applying";
    journal.files[0].state = "deleted";
    await writeFile(journalPath, JSON.stringify(journal));

    const restored = await safety.undo(prepared.id);
    expect(restored.status).toBe("restored");
    expect(await readFile(first, "utf8")).toBe("first original\n");
    expect(await readFile(second, "utf8")).toBe("second original\n");
  });

  it("restores conflict-free files and resumes a partial undo after the conflict is resolved", async () => {
    const root = await gitProject("partial-undo");
    const conflicted = path.join(root, "legacy-one.ts");
    const restorable = path.join(root, "legacy-two.ts");
    await writeFile(conflicted, "first original\n");
    await writeFile(restorable, "second original\n");
    const scan = { root } as import("../src/model.ts").ScanResult;
    const findings = [conflicted, restorable].map((file, index) => ({
      id: `partial-${index}`,
      kind: "file",
      name: path.basename(file),
      path: file,
      risk: "review-recommended",
      action: "delete-file"
    } as import("../src/model.ts").Finding));
    const staged = await safety.createStagedCleanup(root, await safety.preview(scan, findings));
    stagedCopies.push(staged);
    const prepared = await safety.prepareCleanup(staged);
    await safety.recordVerification(prepared.id, { command: [], status: "skipped" });
    const applied = await safety.applyCleanup(staged, prepared.id);
    await writeFile(conflicted, "new user content\n");

    await expect(safety.undo(applied.id)).rejects.toThrow(/recreated paths/);
    expect(await readFile(conflicted, "utf8")).toBe("new user content\n");
    expect(await readFile(restorable, "utf8")).toBe("second original\n");

    await rm(conflicted);
    const resumed = await safety.undo(applied.id);
    expect(resumed.status).toBe("restored");
    expect(await readFile(conflicted, "utf8")).toBe("first original\n");
    expect(await readFile(restorable, "utf8")).toBe("second original\n");
  });

  it("recognizes a completed restore if the process stopped before journaling it", async () => {
    const root = await gitProject("interrupted-undo");
    const file = path.join(root, "legacy.ts");
    const original = "original bytes\n";
    await writeFile(file, original);
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f-crash", kind: "file", name: "legacy.ts", path: file, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    const staged = await safety.createStagedCleanup(root, await safety.preview(scan, [finding]));
    stagedCopies.push(staged);
    const prepared = await safety.prepareCleanup(staged);
    await safety.recordVerification(prepared.id, { command: [], status: "skipped" });
    const session = await safety.applyCleanup(staged, prepared.id);
    await writeFile(file, original);
    const journalPath = path.join(stateDir, `${session.id}.json`);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as import("../src/model.ts").Session;
    journal.status = "restoring";
    journal.files[0].state = "deleted";
    await writeFile(journalPath, JSON.stringify(journal));
    const resumed = await safety.undo(session.id);
    expect(resumed.status).toBe("restored");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("keeps a prepared journal with failed verification results and leaves source files untouched", async () => {
    const root = await gitProject("verification-failed");
    const file = path.join(root, "legacy.ts");
    const original = "leave this until explicit apply\n";
    await writeFile(file, original);
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f-failed-check", kind: "file", name: "legacy.ts", path: file, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    const staged = await safety.createStagedCleanup(root, await safety.preview(scan, [finding]));
    stagedCopies.push(staged);
    const prepared = await safety.prepareCleanup(staged);
    await safety.recordVerification(prepared.id, { command: ["npm", "run", "test"], status: "failed", exitCode: 1, durationMs: 15 });
    const saved = (await safety.loadHistory()).find((session) => session.id === prepared.id);
    expect(saved?.status).toBe("prepared");
    expect(saved?.verification[0].status).toBe("failed");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("refuses to apply when a target changed after preview", async () => {
    const root = await gitProject("stale-preview");
    const file = path.join(root, "legacy.ts");
    await writeFile(file, "before\n");
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f3", kind: "file", name: "legacy.ts", path: file, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    const preview = await safety.preview(scan, [finding]);
    const staged = await safety.createStagedCleanup(root, preview);
    stagedCopies.push(staged);
    const prepared = await safety.prepareCleanup(staged);
    await writeFile(file, "changed after preview\n");
    await expect(safety.applyCleanup(staged, prepared.id)).rejects.toThrow(/Project files changed after preview/);
    expect(await readFile(file, "utf8")).toBe("changed after preview\n");
  });

  it("blocks apply if any project file changes after the staged preview", async () => {
    const root = await gitProject("project-change");
    const file = path.join(root, "legacy.ts");
    await writeFile(file, "remove me\n");
    await writeFile(path.join(root, "unselected.ts"), "leave me\n");
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f4", kind: "file", name: "legacy.ts", path: file, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    const staged = await safety.createStagedCleanup(root, await safety.preview(scan, [finding]));
    stagedCopies.push(staged);
    const prepared = await safety.prepareCleanup(staged);
    await writeFile(path.join(root, "unselected.ts"), "concurrent edit\n");
    await expect(safety.applyCleanup(staged, prepared.id)).rejects.toThrow(/Project files changed after preview/);
    expect(await readFile(file, "utf8")).toBe("remove me\n");
  });

  it("blocks symlink candidates", async () => {
    const root = await gitProject("symlink");
    const target = path.join(root, "target.ts");
    const candidate = path.join(root, "legacy.ts");
    await writeFile(target, "keep me\n");
    await symlink(target, candidate);
    const scan = { root } as import("../src/model.ts").ScanResult;
    const finding = { id: "f-link", kind: "file", name: "legacy.ts", path: candidate, risk: "review-recommended", action: "delete-file" } as import("../src/model.ts").Finding;
    await expect(safety.preview(scan, [finding])).rejects.toThrow(/symlink/);
    expect(await readFile(target, "utf8")).toBe("keep me\n");
  });
});
