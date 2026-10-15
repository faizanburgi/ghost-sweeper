import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "./model.js";

const skippedDirectories = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const protectedNames = new Set([
  "readme.md",
  "contributing.md",
  "security.md",
  "code_of_conduct.md",
  "code-of-conduct.md",
  "changelog.md",
  "license.md",
  "notice.md",
  "authors.md",
  "support.md",
  "governance.md",
  "maintainers.md",
  "agents.md",
  "claude.md",
  "gemini.md"
]);

interface MarkdownFile {
  absolute: string;
  relative: string;
  contents: string;
}

function isMarkdownFile(file: string): boolean {
  return file.toLowerCase().endsWith(".md");
}

export function isProtectedMarkdownPath(file: string): boolean {
  const normalized = file.split(path.sep).join("/");
  const basename = path.posix.basename(normalized).toLowerCase();
  return protectedNames.has(basename) || normalized === ".github" || normalized.startsWith(".github/");
}

function targetsInMarkdown(contents: string): string[] {
  const visible = contents
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s{0,3}(```|~~~)[\s\S]*?^\s{0,3}\1[^\n]*$/gm, " ")
    .replace(/`[^`]*`/g, " ");
  const targets: string[] = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g,
    /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm,
    /\bhref\s*=\s*["']([^"']+)["']/gi
  ];
  for (const pattern of patterns) {
    for (const match of visible.matchAll(pattern)) targets.push(match[1]);
  }
  return targets;
}

function localMarkdownTarget(fromFile: string, rawTarget: string, root: string): string | undefined {
  let target = rawTarget.trim();
  if (!target || target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(target)) return undefined;
  try { target = decodeURIComponent(target); } catch { return undefined; }
  target = target.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  if (!target) return undefined;

  const targetPath = target.startsWith("/")
    ? path.resolve(root, `.${target}`)
    : path.resolve(path.dirname(fromFile), target);
  const rel = path.relative(root, targetPath);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;

  const options = [targetPath];
  if (!path.extname(targetPath)) {
    options.push(`${targetPath}.md`, path.join(targetPath, "README.md"), path.join(targetPath, "index.md"));
  }
  for (const option of options) {
    const candidateRel = path.relative(root, option);
    if (!candidateRel || candidateRel === ".." || candidateRel.startsWith(`..${path.sep}`) || path.isAbsolute(candidateRel)) continue;
    if (isMarkdownFile(option)) return candidateRel.split(path.sep).join("/");
  }
  return undefined;
}

async function collectMarkdown(root: string): Promise<MarkdownFile[]> {
  const files: MarkdownFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.isDirectory() && skippedDirectories.has(child.name)) continue;
      const absolute = path.join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile() && isMarkdownFile(child.name)) {
        files.push({
          absolute,
          relative: path.relative(root, absolute).split(path.sep).join("/"),
          contents: await readFile(absolute, "utf8")
        });
      }
    }
  };
  await visit(root);
  return files;
}

export async function findUnreferencedMarkdown(rootInput: string): Promise<Finding[]> {
  const root = path.resolve(rootInput);
  const files = await collectMarkdown(root);
  const byPath = new Map(files.map((file) => [file.relative, file]));
  const links = new Map<string, string[]>();
  for (const file of files) {
    links.set(file.relative, targetsInMarkdown(file.contents)
      .map((target) => localMarkdownTarget(file.absolute, target, root))
      .filter((target): target is string => !!target && byPath.has(target)));
  }

  const reachable = new Set<string>();
  const pending = files.filter((file) => isProtectedMarkdownPath(file.relative)).map((file) => file.relative);
  while (pending.length) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const target of links.get(current) ?? []) pending.push(target);
  }

  return files.filter((file) => !isProtectedMarkdownPath(file.relative) && !reachable.has(file.relative)).map((file, index) => ({
    id: `markdown:${file.relative}:${index}`,
    kind: "markdown",
    name: file.relative,
    path: file.absolute,
    risk: "uncertain",
    action: "delete-file",
    reason: "No path from a recognized project guide was found through local Markdown links. Configured navigation, external references, and standalone guides may not be detected; review before deleting."
  }));
}
