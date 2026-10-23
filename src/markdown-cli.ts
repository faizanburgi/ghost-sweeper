import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { analyzeMarkdownGroup, validateMergeAgainstGroup } from "./markdown-merge.js";
import { collectMarkdownFiles, findMarkdownMatchGroups, isProtectedMarkdownPath } from "./markdown.js";
import { applyCleanup, createStagedCleanup, isGitRepository, prepareCleanup, previewMarkdownMerge, recordVerification, removeStagedCleanup } from "./safety.js";
import { listVerificationScripts, runVerificationScript } from "./verification.js";
import type { MarkdownMatchGroup, MarkdownMergeDraft, MarkdownSourceReference, PreviewFile } from "./model.js";

function argsValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function hiddenKeyPrompt(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Set GEMINI_API_KEY in the environment to use Gemini without an interactive terminal.");
  stderr.write("Gemini API key (input hidden): ");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = Boolean(stdin.isRaw);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") { cleanup(); reject(new Error("Cancelled.")); return; }
      if (text === "\r" || text === "\n") { cleanup(); stderr.write("\n"); resolve(value); return; }
      if (text === "\u007f" || text === "\b") { value = value.slice(0, -1); return; }
      value += text;
    };
    const cleanup = () => { stdin.off("data", onData); stdin.setRawMode(wasRaw); stdin.pause(); };
    stdin.setRawMode(true); stdin.resume(); stdin.on("data", onData);
  });
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

function printGroup(group: MarkdownMatchGroup, index: number): void {
  stdout.write(`${index + 1}. ${group.relationship} · ${(group.similarity * 100).toFixed(1)}%\n`);
  for (const file of group.files) stdout.write(`   ${file.path}${file.protected ? " [protected: comparison only]" : ""}\n`);
}

function sourceExcerpt(sources: MarkdownSourceReference[], index: number): string {
  const source = sources[index];
  return `> ${source.excerpt.split("\n").join("\n> ")}\n\n<!-- Source: ${source.path}:${source.startLine}-${source.endLine} -->`;
}

function openEditor(initial: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const editor = process.env.VISUAL || process.env.EDITOR;
    if (!editor) { reject(new Error("Set EDITOR or VISUAL to edit the merge draft, or resolve every conflict by choosing a cited passage.")); return; }
    const dir = await mkdtemp(path.join(os.tmpdir(), "ghost-sweeper-draft-"));
    const file = path.join(dir, "merged.md");
    try {
      await writeFile(file, initial, { mode: 0o600 });
      // No shell is used. Simple quoted command names and arguments are supported.
      const parts = editor.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, a, b) => a ?? b)) ?? [];
      if (!parts.length) throw new Error("EDITOR is empty.");
      const result = spawnSync(parts[0], [...parts.slice(1), file], { stdio: "inherit", windowsHide: true });
      if (result.error || result.status !== 0) throw new Error("The configured editor did not complete successfully.");
      resolve(await readFile(file, "utf8"));
    } catch (error) { reject(error); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
}

async function chooseGroup(groups: MarkdownMatchGroup[], requested?: string): Promise<MarkdownMatchGroup> {
  if (requested) {
    const group = groups.find((item) => item.id === requested);
    if (!group) throw new Error(`No Markdown match group found for ${requested}.`);
    return group;
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Select a Markdown match group in a terminal, or pass --group <group-id>.");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("Markdown comparison groups (all comparison is local):\n");
    groups.forEach(printGroup);
    const answer = await ask(rl, "Open group number (q to cancel): ");
    if (answer.toLowerCase() === "q") throw new Error("Cancelled.");
    const group = groups[Number(answer) - 1];
    if (!group) throw new Error("Choose a listed group number.");
    return group;
  } finally { rl.close(); }
}

export async function getDraft(root: string, group: MarkdownMatchGroup, allowUpload: boolean, offline: boolean): Promise<MarkdownMergeDraft> {
  const docs = await collectMarkdownFiles(root);
  const contents = new Map(docs.map((file) => [file.relative, file]));
  if (group.files.some((file) => !contents.has(file.path) || contents.get(file.path)!.hash !== file.hash)) throw new Error("A Markdown file changed after the local comparison. Run the comparison again.");
  const sources = group.files.map((file) => ({ path: file.path, contents: contents.get(file.path)!.contents }));
  if (offline) throw new Error("--offline disables Gemini analysis. Local Markdown match groups remain available.");
  if (!stdin.isTTY || !stdout.isTTY) {
    if (!allowUpload) throw new Error("Cloud analysis is blocked in non-interactive mode. Pass --allow-cloud-upload to approve uploading the selected group.");
    stderr.write("Cloud upload approved by --allow-cloud-upload. Sending only these selected Markdown files to Google Gemini:\n");
    for (const item of sources) stderr.write(`  ${item.path} · ${Buffer.byteLength(item.contents)} bytes\n`);
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      stdout.write("The following Markdown content will be sent to Google Gemini for this group only:\n");
      for (const item of sources) stdout.write(`  ${item.path} · ${Buffer.byteLength(item.contents)} bytes\n`);
      stdout.write("The API may process this content according to Google's API terms. Nothing else from the repository is uploaded.\n");
      if (!/^(y|yes)$/i.test(await ask(rl, "Approve this upload? [y/N] "))) throw new Error("Cloud upload not approved.");
    } finally { rl.close(); }
  }
  const key = process.env.GEMINI_API_KEY || await hiddenKeyPrompt();
  const latest = new Map((await collectMarkdownFiles(root)).map((file) => [file.relative, file]));
  if (group.files.some((file) => !latest.has(file.path) || latest.get(file.path)!.hash !== file.hash)) throw new Error("A Markdown file changed before upload. Run the comparison again; nothing was uploaded.");
  const approvedSources = group.files.map((file) => ({ path: file.path, contents: latest.get(file.path)!.contents }));
  return analyzeMarkdownGroup(group, approvedSources, key);
}

async function ensureGroupUnchanged(root: string, group: MarkdownMatchGroup): Promise<void> {
  const current = new Map((await collectMarkdownFiles(root)).map((file) => [file.relative, file.hash]));
  if (group.files.some((file) => current.get(file.path) !== file.hash)) throw new Error("A compared Markdown file changed during merge review. Nothing was applied; compare again.");
}

async function ensureStagedGroupUnchanged(stage: Awaited<ReturnType<typeof createStagedCleanup>>, group: MarkdownMatchGroup, changedPaths: Set<string>): Promise<void> {
  for (const file of group.files) {
    if (changedPaths.has(file.path)) continue;
    const contents = await readFile(path.join(stage.tempRoot, "project", file.path), "utf8").catch(() => "");
    const hash = createHash("sha256").update(contents).digest("hex");
    if (hash !== file.hash) throw new Error(`Compared Markdown file ${file.path} changed while staging. Nothing was applied; compare again.`);
  }
}

async function editAndResolve(draft: MarkdownMergeDraft, rl: ReturnType<typeof createInterface>): Promise<string> {
  let text = draft.draft;
  for (const conflict of draft.conflicts) {
    stdout.write(`\nConflict: ${conflict.topic}\n`);
    conflict.sources.forEach((source, index) => stdout.write(`  ${index + 1}. ${source.path}:${source.startLine}-${source.endLine}\n     ${source.excerpt.replace(/\n/g, " ")}\n`));
    stdout.write("  e. Edit the full draft in $EDITOR\n");
    const choice = await ask(rl, `Resolve ${conflict.id} with passage number or e: `);
    if (choice.toLowerCase() === "e") {
      text = await openEditor(text);
      if (text.includes(`{{CONFLICT:${conflict.id}}}`)) throw new Error(`Conflict ${conflict.id} is still unresolved in the edited draft.`);
    } else {
      const sourceIndex = Number(choice) - 1;
      if (!conflict.sources[sourceIndex]) throw new Error(`Invalid passage choice for conflict ${conflict.id}.`);
      text = text.replaceAll(`{{CONFLICT:${conflict.id}}}`, sourceExcerpt(conflict.sources, sourceIndex));
    }
  }
  if (text.includes("{{CONFLICT:")) throw new Error("The draft still contains unresolved conflict markers.");
  return await openEditor(text);
}

export async function runMarkdownCommand(root: string, args: string[]): Promise<void> {
  const offline = args.includes("--offline");
  const allowUpload = args.includes("--allow-cloud-upload");
  const groups = await findMarkdownMatchGroups(root);
  const requested = argsValue(args, "--group");
  if (!groups.length) { stdout.write("No similar Markdown document groups were found.\n"); return; }
  const group = await chooseGroup(groups, requested);
  if (offline) {
    stdout.write(`Offline comparison · ${group.relationship} · ${(group.similarity * 100).toFixed(1)}%\n`);
    for (const file of group.files) stdout.write(`  ${file.path}${file.protected ? " [protected: comparison only]" : ""}\n`);
    for (const evidence of group.evidence) stdout.write(`  Evidence: ${evidence}\n`);
    stdout.write("Gemini is disabled. No content was uploaded.\n");
    return;
  }
  const draft = await getDraft(root, group, allowUpload, offline);
  validateMergeAgainstGroup(draft, group);
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write(`${JSON.stringify({ group, draft }, null, 2)}\n`);
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  let stage: Awaited<ReturnType<typeof createStagedCleanup>> | undefined;
  try {
    stdout.write(`\nGemini proposed a ${draft.relationship} merge with ${draft.conflicts.length} conflict(s).\n\n${draft.draft}\n`);
    stdout.write("Section sources:\n");
    for (const section of draft.sections) stdout.write(`  ${section.heading}: ${section.sources.map((source) => `${source.path}:${source.startLine}-${source.endLine}`).join(", ")}\n`);
    for (const [index, source] of draft.sources.entries()) stdout.write(`Citation ${index + 1}: ${source.path}:${source.startLine}-${source.endLine}\n`);
    const eligible = group.files.filter((file) => !file.protected);
    const destinations = eligible.map((file) => file.path);
    stdout.write("\nEligible destination files:\n");
    destinations.forEach((file, index) => stdout.write(`  ${index + 1}. ${file}\n`));
    if (!destinations.length) throw new Error("This group contains no eligible destination; protected guides are comparison-only.");
    const destinationChoice = await ask(rl, "Destination number: ");
    const destination = destinations[Number(destinationChoice) - 1];
    if (!destination) throw new Error("Choose an eligible destination.");
    const merged = await editAndResolve(draft, rl);
    const sources = eligible.map((file) => file.path).filter((file) => file !== destination);
    stdout.write("\nEligible source files that may be removed after replacement:\n");
    sources.forEach((file, index) => stdout.write(`  ${index + 1}. ${file}\n`));
    const answer = await ask(rl, "Source numbers to remove (comma separated), or Enter for none: ");
    const removals = answer ? [...new Set(answer.split(",").map((part) => sources[Number(part.trim()) - 1]).filter((file): file is string => !!file))] : [];
    if (answer && removals.length !== answer.split(",").length) throw new Error("One or more source selections are invalid.");
    if (!isGitRepository(root)) throw new Error("Applying Markdown merges currently requires a Git repository; this project remains unchanged.");
    await ensureGroupUnchanged(root, group);
    const files: PreviewFile[] = await previewMarkdownMerge(root, destination, merged, removals, new Map(group.files.map((file) => [file.path, file.hash])));
    stage = await createStagedCleanup(root, files);
    await ensureStagedGroupUnchanged(stage, group, new Set([destination, ...removals]));
    stdout.write(`\nPreview in staged copy (${stage.tempRoot}):\n`);
    stdout.write(`  REPLACE ${destination} · ${merged.split("\n").length} draft lines\n`);
    stdout.write("\nMerged destination contents:\n");
    stdout.write(`${await readFile(path.join(stage.tempRoot, "project", destination), "utf8")}\n`);
    for (const file of removals) stdout.write(`  DELETE  ${file}\n`);
    stdout.write("No project files have changed yet.\n");
    const session = await prepareCleanup(stage);
    const scripts = await listVerificationScripts(root);
    for (const script of scripts) {
      const approve = await ask(rl, `Run ${script.command.join(" ")} in staged copy? [y/N] `);
      if (/^(y|yes)$/i.test(approve)) {
        stdout.write(`Running ${script.command.join(" ")} in ${stage.tempRoot}/project\n`);
        const result = await runVerificationScript(stage, script.name);
        await recordVerification(session.id, result.result);
        stdout.write(`${result.result.status} · exit ${result.result.exitCode ?? "unknown"}\n${result.output}\n`);
      }
    }
    const approval = await ask(rl, `Apply replacement and ${removals.length} selected removal(s)? Type APPLY to continue: `);
    if (approval !== "APPLY") { stdout.write(`Cancelled. Recovery journal retained as ${session.id}; project files are unchanged.\n`); return; }
    const applied = await applyCleanup(stage, session.id);
    stdout.write(`\nMarkdown merge applied · ${applied.id}\nRestore with: ghost-sweeper undo ${applied.id}\n`);
  } finally {
    rl.close();
    if (stage) await removeStagedCleanup(stage).catch(() => undefined);
  }
}
