import { lstat, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Finding } from "./model.js";
import type { MarkdownMatchGroup } from "./model.js";

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
  hash: string;
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

export async function collectMarkdownFiles(root: string): Promise<MarkdownFile[]> {
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
        const contents = await readFile(absolute, "utf8");
        files.push({
          absolute,
          relative: path.relative(root, absolute).split(path.sep).join("/"),
          contents,
          hash: createHash("sha256").update(contents).digest("hex")
        });
      }
    }
  };
  await visit(root);
  return files;
}

function terms(contents: string): { all: string[]; headings: string[] } {
  const visible = contents
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/```[^]*?```|~~~[^]*?~~~/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const tokenize = (value: string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? [];
  return { all: tokenize(visible), headings: tokenize(visible.split("\n").filter((line) => /^\s{0,3}#{1,6}\s/.test(line)).join(" ")) };
}

function vectorize(documents: ReturnType<typeof terms>[]): Array<Map<string, number>> {
  const documentFrequency = new Map<string, number>();
  const frequencies = documents.map((document) => {
    const counts = new Map<string, number>();
    for (const term of document.all) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const term of new Set(document.headings)) counts.set(`h:${term}`, (counts.get(`h:${term}`) ?? 0) + 1);
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    return counts;
  });
  return frequencies.map((counts) => {
    const weighted = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of counts) {
      const idf = Math.log(1 + documents.length / (1 + (documentFrequency.get(term) ?? 0)));
      const weight = (1 + Math.log(count)) * idf;
      weighted.set(term, weight);
      norm += weight * weight;
    }
    const divisor = Math.sqrt(norm) || 1;
    for (const [term, value] of weighted) weighted.set(term, value / divisor);
    return weighted;
  });
}

export async function findMarkdownMatchGroups(rootInput: string): Promise<MarkdownMatchGroup[]> {
  const root = path.resolve(rootInput);
  const files = await collectMarkdownFiles(root);
  if (files.length < 2) return [];
  const vectors = vectorize(files.map((file) => terms(file.contents)));
  const groups: MarkdownMatchGroup[] = [];
  const exactGroups = new Map<string, number[]>();
  for (let index = 0; index < files.length; index++) {
    const normalized = files[index].contents.replace(/\s+/g, " ").trim();
    const matches = exactGroups.get(normalized) ?? [];
    matches.push(index);
    exactGroups.set(normalized, matches);
  }
  const exactPairs = new Set<string>();
  for (const indices of exactGroups.values()) {
    if (indices.length < 2) continue;
    for (let i = 0; i < indices.length; i++) for (let j = i + 1; j < indices.length; j++) exactPairs.add(`${indices[i]}:${indices[j]}`);
    const members = indices.map((index) => files[index]);
    const paths = members.map((file) => file.relative);
    groups.push({ id: `md:${paths.join("::")}`, relationship: "duplicate", similarity: 1,
      files: members.map((file) => ({ path: file.relative, protected: isProtectedMarkdownPath(file.relative), hash: file.hash })),
      evidence: ["Normalized Markdown text is identical."] });
  }

  const postings = new Map<string, Array<{ index: number; weight: number }>>();
  for (let index = 0; index < vectors.length; index++) {
    for (const [term, weight] of vectors[index]) {
      const posting = postings.get(term) ?? [];
      posting.push({ index, weight });
      postings.set(term, posting);
    }
  }
  const dots = new Map<string, number>();
  const commonTermLimit = Math.max(40, Math.floor(files.length * 0.15));
  for (const posting of postings.values()) {
    // Very common words provide little matching signal and can otherwise make a large corpus quadratic.
    if (posting.length > commonTermLimit) continue;
    for (let i = 0; i < posting.length; i++) for (let j = i + 1; j < posting.length; j++) {
      const left = posting[i].index;
      const right = posting[j].index;
      const key = `${left}:${right}`;
      if (!exactPairs.has(key)) dots.set(key, (dots.get(key) ?? 0) + posting[i].weight * posting[j].weight);
    }
  }
  for (const [key, score] of dots) {
    const relationship = score >= 0.82 ? "duplicate" : score >= 0.34 ? "overlapping" : score >= 0.12 ? "related" : undefined;
    if (!relationship) continue;
    const [left, right] = key.split(":").map(Number);
    const members = [files[left], files[right]];
    const paths = members.map((file) => file.relative);
    groups.push({ id: `md:${paths.join("::")}`, relationship, similarity: Number(score.toFixed(3)),
      files: members.map((file) => ({ path: file.relative, protected: isProtectedMarkdownPath(file.relative), hash: file.hash })),
      evidence: [`Local TF-IDF similarity: ${(score * 100).toFixed(1)}%.`, "Headings receive extra weight; comparison uses local text only."] });
  }
  return groups.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
}

export async function findUnreferencedMarkdown(rootInput: string): Promise<Finding[]> {
  const root = path.resolve(rootInput);
  const files = await collectMarkdownFiles(root);
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
