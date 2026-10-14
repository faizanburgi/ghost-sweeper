import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Finding, ScanResult, Session } from "./model.js";

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

function blockedReason(relative: string): string | undefined {
  const normalized = relative.split(path.sep).join("/");
  if (normalized.startsWith("../") || path.isAbsolute(relative)) return "Path is outside the project root.";
  if (/(^|\/)(node_modules|\.git|dist|build|coverage)(\/|$)/i.test(normalized)) return "Generated or dependency paths cannot be removed.";
  if (/(^|\/)(app|pages|routes|api)(\/|$)/i.test(normalized)) return "Framework convention paths require manual review and are protected in this release.";
  if (/\.(d\.ts|config\.[cm]?[jt]sx?)$/i.test(normalized) || /(^|\/)index\.[cm]?[jt]sx?$/i.test(normalized)) return "Entry, declaration, and configuration files are protected.";
  if (!/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(normalized)) return "Only JavaScript and TypeScript source files are eligible in this release.";
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
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function preview(scan: ScanResult, selected: Finding[]): Promise<Array<{ path: string; hash: string; lines: number; mode: number }>> {
  const rootReal = await realpath(scan.root);
  const unique = new Map<string, Finding>();
  for (const finding of selected) {
    if (finding.action !== "delete-file" || !finding.path) throw new Error(`Finding “${finding.name}” is not eligible for deletion.`);
    const relative = path.relative(scan.root, finding.path);
    const blocked = blockedReason(relative);
    if (blocked) throw new Error(`${relative}: ${blocked}`);
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

export async function applyCleanup(root: string, files: Array<{ path: string; hash: string; mode: number }>): Promise<Session> {
  if (!isGitRepository(root)) throw new Error("Applying cleanup currently requires a Git repository.");
  if (!files.length) throw new Error("Select at least one eligible file.");
  await mkdir(sessionStorePath, { recursive: true, mode: 0o700 });
  const rootForStore = await realpath(root);
  const storeReal = await realpath(sessionStorePath);
  if (storeReal === rootForStore || storeReal.startsWith(`${rootForStore}${path.sep}`)) {
    throw new Error("Recovery storage must be outside the project directory. Choose a separate Ghost Sweeper state directory.");
  }
  const id = `gs-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const session: Session = {
    id,
    createdAt: new Date().toISOString(),
    root: rootForStore,
    status: "prepared",
    verification: [{ command: "Not run (verification is not implemented yet)", status: "skipped" }],
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

  // Persist all recovery bytes before the first destructive operation.
  await writeSession(session);
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
    try { sessions.push(JSON.parse(await readFile(path.join(sessionStorePath, name), "utf8")) as Session); } catch { /* Ignore an unreadable record, but preserve it on disk. */ }
  }
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function undo(id?: string): Promise<Session> {
  const sessions = await loadHistory();
  const session = id ? sessions.find((item) => item.id === id) : sessions.find((item) => ["applied", "interrupted", "conflict", "restoring"].includes(item.status));
  if (!session) throw new Error(id ? `No cleanup session found for ${id}.` : "No restorable cleanup session was found.");
  if (session.status === "restored") throw new Error(`Session ${session.id} is already restored.`);
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
      // Any recreated path may contain user work. Never overwrite it.
      entry.state = "conflict";
      conflict = true;
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
  if (conflict) throw new Error(`Undo stopped on one or more recreated paths in ${session.id}. Other conflict-free files were restored; inspect history before retrying.`);
  return session;
}
