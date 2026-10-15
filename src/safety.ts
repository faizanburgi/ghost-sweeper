import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Finding, PreviewFile, ScanResult, Session, StagedCleanup, VerificationResult } from "./model.js";
import { GhostSweeperError } from "./errors.js";
import { isProtectedMarkdownPath } from "./markdown.js";

const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
export const sessionStorePath = process.env.GHOST_SWEEPER_STATE_DIR
  ? path.resolve(process.env.GHOST_SWEEPER_STATE_DIR)
  : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "GhostSweeper")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Ghost Sweeper")
      : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "ghost-sweeper");

function sessionPath(id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid cleanup session ID.");
  return path.join(sessionStorePath, `${id}.json`);
}

export function isGitRepository(root: string): boolean {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function excludedFromCopy(relative: string): boolean {
  return relative.split(path.sep).some((part) => part === ".git" || part === "node_modules");
}

async function fingerprintDirectory(root: string): Promise<string> {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute);
      if (relative !== ".git" && relative.split(path.sep).includes(".git")) throw new Error(`Nested Git metadata at ${relative} is not supported for cleanup.`);
      if (excludedFromCopy(relative)) continue;
      const info = await lstat(absolute);
      const mode = info.mode & 0o7777;
      if (info.isSymbolicLink()) {
        entries.push(`l\0${relative}\0${mode}\0${await readlink(absolute)}`);
      } else if (info.isDirectory()) {
        entries.push(`d\0${relative}\0${mode}`);
        await visit(absolute);
      } else if (info.isFile()) {
        entries.push(`f\0${relative}\0${mode}\0${digest(await readFile(absolute))}`);
      } else {
        entries.push(`o\0${relative}\0${mode}`);
      }
    }
  };
  await visit(root);
  return digest(Buffer.from(entries.join("\n")));
}

export async function createStagedCleanup(root: string, files: PreviewFile[]): Promise<StagedCleanup> {
  if (!files.length) throw new Error("Select at least one eligible file.");
  const projectRoot = await realpath(root);
  const projectFingerprint = await fingerprintDirectory(projectRoot);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ghost-sweeper-"));
  if (process.platform !== "win32") await chmod(tempRoot, 0o700).catch(() => undefined);
  const stagedProject = path.join(tempRoot, "project");
  try {
    await cp(projectRoot, stagedProject, {
      recursive: true,
      force: false,
      filter: (source) => source === projectRoot || !excludedFromCopy(path.relative(projectRoot, source))
    });
    const copiedFingerprint = await fingerprintDirectory(stagedProject);
    if (copiedFingerprint !== projectFingerprint) throw new Error("Project files changed while the preview copy was being prepared. Rescan and preview again.");
    for (const file of files) {
      const relative = path.relative(projectRoot, path.resolve(file.path));
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("A selected path is outside the project root.");
      }
      const stagedPath = path.resolve(stagedProject, relative);
      if (stagedPath !== stagedProject && !stagedPath.startsWith(`${stagedProject}${path.sep}`)) throw new Error(`${relative}: staged path escapes the project copy.`);
      await rejectSymlinkTraversal(stagedProject, relative);
      const stagedInfo = await lstat(stagedPath);
      if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink()) throw new Error(`${relative}: staged candidate is not a regular file.`);
      if (digest(await readFile(stagedPath)) !== file.hash) throw new Error(`${relative} changed while the preview copy was prepared. Rescan and preview again.`);
      await unlink(stagedPath);
    }
    return { id: path.basename(tempRoot), tempRoot, projectRoot, projectFingerprint, files };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function removeStagedCleanup(stage: StagedCleanup): Promise<void> {
  const tempBase = await realpath(os.tmpdir());
  const actual = await realpath(stage.tempRoot).catch(() => "");
  if (!actual || path.dirname(actual) !== tempBase || !path.basename(actual).startsWith("ghost-sweeper-")) return;
  await rm(actual, { recursive: true, force: true });
}

function blockedReason(relative: string): string | undefined {
  const normalized = relative.split(path.sep).join("/");
  if (normalized.startsWith("../") || path.isAbsolute(relative)) return "Path is outside the project root.";
  if (/(^|\/)(node_modules|\.git|dist|build|coverage)(\/|$)/i.test(normalized)) return "Generated or dependency paths cannot be removed.";
  if (/(^|\/)(app|pages|routes|api)(\/|$)/i.test(normalized)) return "Framework convention paths require manual review and are protected in this release.";
  if (normalized.toLowerCase().endsWith(".md") && isProtectedMarkdownPath(normalized)) return "Project guide and GitHub workflow Markdown files are protected.";
  if (/\.(d\.ts|config\.[cm]?[jt]sx?)$/i.test(normalized) || /(^|\/)index\.[cm]?[jt]sx?$/i.test(normalized)) return "Entry, declaration, and configuration files are protected.";
  if (!/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|md)$/i.test(normalized)) return "Only supported source and Markdown files are eligible in this release.";
  return undefined;
}

async function rejectSymlinkTraversal(rootReal: string, relative: string, includeLeaf = true): Promise<void> {
  let current = rootReal;
  const segments = relative.split(path.sep);
  const inspected = includeLeaf ? segments : segments.slice(0, -1);
  for (const [index, segment] of inspected.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${relative}: symlink traversal is blocked.`);
    if (index < inspected.length - 1 && !info.isDirectory()) throw new Error(`${relative}: a parent path is not a directory.`);
  }
}

async function writeSession(session: Session): Promise<void> {
  await mkdir(sessionStorePath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(sessionStorePath, 0o700).catch(() => undefined);
  const target = sessionPath(session.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(session, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const { rename } = await import("node:fs/promises");
    await rename(temporary, target);
    if (process.platform !== "win32") {
      const directory = await open(sessionStorePath, "r").catch(() => undefined);
      if (directory) {
        try { await directory.sync(); } catch { /* Some filesystems do not allow directory fsync. */ }
        await directory.close();
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function preview(scan: ScanResult, selected: Finding[]): Promise<Array<{ path: string; hash: string; lines: number; mode: number }>> {
  const rootReal = await realpath(scan.root);
  const unique = new Map<string, Finding>();
  for (const finding of selected) {
    if (finding.action !== "delete-file" || !finding.path) throw new GhostSweeperError(`Finding “${finding.name}” is not eligible for deletion.`, 2);
    const relative = path.relative(scan.root, finding.path);
    const blocked = blockedReason(relative);
    if (blocked) throw new GhostSweeperError(`${relative}: ${blocked}`, 2);
    await rejectSymlinkTraversal(rootReal, relative);
    const item = await lstat(finding.path);
    if (!item.isFile() || item.isSymbolicLink()) throw new Error(`${relative}: only regular files can be removed; links and special files are blocked.`);
    const parentReal = await realpath(path.dirname(finding.path));
    if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) throw new Error(`${relative}: parent directory escapes the project root.`);
    const fileReal = await realpath(finding.path);
    if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) throw new Error(`${relative}: resolved file escapes the project root.`);
    unique.set(fileReal, finding);
  }
  const result = [];
  for (const filePath of unique.keys()) {
    const contents = await readFile(filePath);
    const info = await stat(filePath);
    result.push({ path: filePath, hash: digest(contents), lines: contents.length === 0 ? 0 : contents.toString("utf8").split("\n").length, mode: info.mode });
  }
  return result;
}

async function prospectiveRealpath(target: string): Promise<string> {
  let current = path.resolve(target);
  const suffix: string[] = [];
  while (true) {
    try {
      const base = await realpath(current);
      return path.join(base, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function prepareStore(root: string): Promise<void> {
  const rootReal = await realpath(root);
  const requestedStore = await prospectiveRealpath(sessionStorePath);
  if (requestedStore === rootReal || requestedStore.startsWith(`${rootReal}${path.sep}`)) {
      throw new GhostSweeperError("Recovery storage must be outside the project directory. Choose a separate Ghost Sweeper state directory.", 2);
  }
  await mkdir(sessionStorePath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(sessionStorePath, 0o700).catch(() => undefined);
  const storeReal = await realpath(sessionStorePath);
  if (storeReal === rootReal || storeReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new GhostSweeperError("Recovery storage must be outside the project directory. Choose a separate Ghost Sweeper state directory.", 2);
  }
}

async function readSession(id: string): Promise<Session> {
  const raw = JSON.parse(await readFile(sessionPath(id), "utf8")) as Partial<Session>;
  const verification = Array.isArray(raw.verification) ? raw.verification.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as unknown as Record<string, unknown>;
    const command = Array.isArray(record.command) ? record.command.filter((part): part is string => typeof part === "string") : [];
    const status = ["passed", "failed", "skipped", "blocked"].includes(String(record.status)) ? record.status as VerificationResult["status"] : "skipped";
    return [{ command, status, ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}), ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}) }];
  }) : [];
  if (raw.id !== id || !raw.root || !raw.createdAt || !Array.isArray(raw.files)) throw new Error(`Invalid cleanup journal for ${id}.`);
  return { ...raw, verification } as Session;
}

export async function prepareCleanup(stage: StagedCleanup): Promise<Session> {
  const root = stage.projectRoot;
  const files = stage.files;
  if (!isGitRepository(root)) throw new GhostSweeperError("Applying cleanup currently requires a Git repository.", 2);
  if (!files.length) throw new GhostSweeperError("Select at least one eligible file.", 2);
  if (await fingerprintDirectory(root) !== stage.projectFingerprint) {
    throw new GhostSweeperError("Project files changed after preview. Nothing was applied; rescan and preview again.", 2);
  }
  await prepareStore(root);
  const rootForStore = await realpath(root);
  const id = `gs-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const session: Session = {
    id,
    createdAt: new Date().toISOString(),
    root: rootForStore,
    status: "prepared",
    verification: [],
    files: []
  };

  for (const file of files) {
    const relative = path.relative(session.root, path.resolve(file.path));
    const blocked = blockedReason(relative);
    if (blocked) throw new Error(`${relative}: ${blocked}`);
    await rejectSymlinkTraversal(session.root, relative);
    const parentReal = await realpath(path.dirname(file.path));
    if (parentReal !== session.root && !parentReal.startsWith(`${session.root}${path.sep}`)) throw new Error(`${relative}: parent directory escapes the project root.`);
    const current = await readFile(file.path);
    if (digest(current) !== file.hash) throw new Error(`${path.relative(root, file.path)} changed after preview. Rescan before applying.`);
    const info = await lstat(file.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path.relative(root, file.path)} is no longer a regular file.`);
    session.files.push({
      path: path.relative(session.root, file.path),
      originalBase64: current.toString("base64"),
      mode: file.mode,
      originalHash: file.hash,
      deletedHash: "absent",
      state: "pending"
    });
  }

  await writeSession(session);
  return session;
}

export async function recordVerification(id: string, result: VerificationResult): Promise<Session> {
  const session = await readSession(id);
  if (session.status !== "prepared") throw new Error(`Verification can only be recorded for a prepared session (${id}).`);
  session.verification.push(result);
  await writeSession(session);
  return session;
}

export async function applyCleanup(stage: StagedCleanup, sessionId: string): Promise<Session> {
  const root = stage.projectRoot;
  const files = stage.files;
  if (!isGitRepository(root)) throw new GhostSweeperError("Applying cleanup currently requires a Git repository.", 2);
  if (!files.length) throw new GhostSweeperError("Select at least one eligible file.", 2);
  await prepareStore(root);
  const session = await readSession(sessionId);
  if (session.status !== "prepared" || session.root !== root) throw new GhostSweeperError(`Session ${sessionId} is no longer prepared for this project.`, 2);
  if (session.files.length !== files.length || session.files.some((entry, index) =>
    entry.path !== path.relative(root, files[index].path) || entry.originalHash !== files[index].hash)) {
    throw new GhostSweeperError("The recovery journal does not match this staged preview. Prepare a new cleanup session.", 2);
  }
  if (await fingerprintDirectory(root) !== stage.projectFingerprint) {
    throw new GhostSweeperError("Project files changed after preview. Nothing was applied; rescan and preview again.", 2);
  }
  for (const entry of session.files) {
    const absolute = path.resolve(session.root, entry.path);
    const contents = await readFile(absolute);
    if (digest(contents) !== entry.originalHash) throw new GhostSweeperError(`${entry.path} changed after preview. Rescan before applying.`, 2);
  }
  session.status = "applying";
  await writeSession(session);
  try {
    for (const entry of session.files) {
      const absolute = path.resolve(session.root, entry.path);
      const contents = await readFile(absolute);
      if (digest(contents) !== entry.originalHash) throw new Error(`${entry.path} changed during apply; stopping.`);
      await unlink(absolute);
      entry.state = "deleted";
      await writeSession(session);
    }
    session.status = "applied";
    await writeSession(session);
    return session;
  } catch (error) {
    session.status = "interrupted";
    await writeSession(session);
    throw error;
  }
}

export async function loadHistory(): Promise<Session[]> {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(sessionStorePath).catch(() => [] as string[]);
  const sessions: Session[] = [];
  for (const name of names.filter((item) => /^gs-[\w-]+\.json$/.test(item))) {
    const id = name.slice(0, -5);
    try { sessions.push(await readSession(id)); } catch { /* Ignore an unreadable record, but preserve it on disk. */ }
  }
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function undo(id?: string): Promise<Session> {
  const sessions = await loadHistory();
  const session = id ? sessions.find((item) => item.id === id) : sessions.find((item) => ["prepared", "applying", "applied", "interrupted", "conflict", "restoring"].includes(item.status));
  if (!session) throw new GhostSweeperError(id ? `No cleanup session found for ${id}.` : "No restorable cleanup session was found.", 2);
  if (session.status === "restored") throw new GhostSweeperError(`Session ${session.id} is already restored.`, 2);
  await prepareStore(session.root);
  session.status = "restoring";
  await writeSession(session);
  let conflict = false;
  const rootReal = await realpath(session.root).catch(() => "");
  if (!rootReal) throw new Error(`Project directory for ${session.id} no longer exists; backups remain at ${sessionStorePath}.`);
  for (const entry of session.files) {
    if (entry.state === "restored") continue;
    const absolute = path.resolve(session.root, entry.path);
    const rel = path.relative(session.root, absolute);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      entry.state = "conflict";
      conflict = true;
      await writeSession(session);
      continue;
    }
    const parentReal = await realpath(path.dirname(absolute)).catch(() => "");
    if (!parentReal || (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`))) {
      entry.state = "conflict";
      conflict = true;
      await writeSession(session);
      continue;
    }
    try {
      await rejectSymlinkTraversal(rootReal, entry.path, false);
    } catch {
      entry.state = "conflict";
      conflict = true;
      await writeSession(session);
      continue;
    }
    const exists = await lstat(absolute).then(() => true, () => false);
    if (entry.state === "pending" && exists) {
      // The interrupted apply had not reached this file; leave it untouched.
      entry.state = "restored";
      await writeSession(session);
      continue;
    }
    if (exists) {
      // A crash can occur after the restore link succeeds but before its journal update.
      // Recognize our original bytes as restored; preserve every other recreated path.
      const current = await readFile(absolute).catch(() => Buffer.alloc(0));
      if (digest(current) === entry.originalHash) {
        entry.state = "restored";
      } else {
        entry.state = "conflict";
        conflict = true;
      }
      await writeSession(session);
      continue;
    }
    const bytes = Buffer.from(entry.originalBase64, "base64");
    if (digest(bytes) !== entry.originalHash) throw new Error(`Backup integrity check failed for ${entry.path}.`);
    const temporary = path.join(path.dirname(absolute), `.ghost-sweeper-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", entry.mode & 0o777);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // link() creates the destination only if it does not already exist.
      await link(temporary, absolute);
      await unlink(temporary);
      entry.state = "restored";
      await writeSession(session);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        entry.state = "conflict";
        conflict = true;
        await writeSession(session);
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        entry.state = "conflict";
        conflict = true;
        await writeSession(session);
        continue;
      }
      throw error;
    }
  }
  session.status = conflict ? "conflict" : "restored";
  await writeSession(session);
  if (conflict) throw new GhostSweeperError(`Undo stopped on one or more recreated paths in ${session.id}. Other conflict-free files were restored; inspect history before retrying.`, 2);
  return session;
}
