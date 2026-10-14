import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "./analysis.js";
import { loadHistory, undo } from "./safety.js";
import { runTui } from "./ui.js";
import type { Finding } from "./model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(await readFile(path.resolve(here, "../package.json"), "utf8")) as { version: string };

function usage(): void {
  stdout.write(`Ghost Sweeper ${packageJson.version}\n\n` +
    `Usage:\n  ghost-sweeper [scan] [--json]\n  ghost-sweeper history\n  ghost-sweeper undo [session-id]\n\n` +
    `Options:\n  --json                       Print machine-readable findings (scan only)\n  --allow-config-execution     Acknowledge Knip may execute project config (required without a TTY)\n  --help                       Show this help\n  --version                    Show version\n\n` +
    `Only explicitly selected unused source files can be removed. Runs Knip; scan trusted projects only because some Knip plugins load project configuration.\n`);
}

async function findProjectRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try {
      const info = await import("node:fs/promises").then(({ stat }) => stat(path.join(current, "package.json")));
      if (info.isFile()) return current;
    } catch { /* Search parent. */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function formatFinding(finding: Finding, root: string): string {
  const location = finding.path ? path.relative(root, finding.path) : finding.name;
  const treatment = finding.action === "delete-file" ? "selectable after review" : "view only";
  return `  ${finding.kind.padEnd(12)} ${location} — ${treatment}`;
}

async function promptForConfigTrust(): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("Knip plugins may load and execute project configuration files during analysis. Continue only if you trust this project. [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return usage();
  if (args.includes("--version") || args.includes("-V")) { stdout.write(`${packageJson.version}\n`); return; }
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "scan";

  if (command === "history") {
    const sessions = await loadHistory();
    if (!sessions.length) { stdout.write("No Ghost Sweeper cleanup sessions found.\n"); return; }
    for (const session of sessions) stdout.write(`${session.id.padEnd(36)} ${session.createdAt}  ${session.status.padEnd(12)} ${session.files.length} file(s)\n`);
    stdout.write("\nRestore with: ghost-sweeper undo <session-id>\n");
    return;
  }

  if (command === "undo") {
    const id = args[1];
    if (!id && stdin.isTTY) {
      const sessions = (await loadHistory()).filter((session) => ["applied", "interrupted", "conflict"].includes(session.status));
      if (sessions.length > 1) {
        stderr.write("More than one cleanup can be restored. Choose a session:\n");
        sessions.forEach((session, index) => stderr.write(`  ${index + 1}. ${session.id} (${session.status}, ${session.files.length} file(s))\n`));
        stderr.write("Run: ghost-sweeper undo <session-id>\n");
        process.exitCode = 2;
        return;
      }
    }
    const session = await undo(id);
    stdout.write(`Restored ${session.files.length} file(s) from ${session.id}.\n`);
    return;
  }

  if (command !== "scan") throw new Error(`Unknown command: ${command}. Run ghost-sweeper --help.`);
  const json = args.includes("--json");
  const allowConfigExecution = args.includes("--allow-config-execution");
  const root = await findProjectRoot(process.cwd());
  if (stdin.isTTY && stdout.isTTY && !allowConfigExecution && !await promptForConfigTrust()) {
    stdout.write("Scan cancelled. No files were changed.\n");
    return;
  }
  if ((!stdin.isTTY || !stdout.isTTY) && !allowConfigExecution) {
    stderr.write("Scan blocked: Knip plugins may load and execute project configuration. Review the project, then pass --allow-config-execution to acknowledge this risk.\n");
    process.exitCode = 2;
    return;
  }

  const result = await analyze(root);
  if (json) {
    stdout.write(`${JSON.stringify({ ...result, findings: result.findings.map((item) => ({ ...item, path: item.path ? path.relative(root, item.path) : undefined })) }, null, 2)}\n`);
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write(`Ghost Sweeper · ${result.projectName}\n${result.framework} · Knip ${result.knipVersion}\nFound ${result.findings.length} finding(s), including ${result.unusedFiles} unused file(s). No files have been changed.\n`);
    for (const finding of result.findings) stdout.write(`${formatFinding(finding, root)}\n`);
    if (result.warnings.length) stderr.write(`\nKnip warnings:\n${result.warnings.join("\n")}\n`);
    stdout.write("\nRun in an interactive terminal to review eligible file deletions.\n");
    return;
  }
  await runTui(result);
}

main().catch((error: unknown) => {
  stderr.write(`Ghost Sweeper: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
