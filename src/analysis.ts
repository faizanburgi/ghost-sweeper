import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Finding, FindingKind, ScanResult } from "./model.js";

const require = createRequire(import.meta.url);

function findKnipCli(): { cli: string; version: string } {
  let entry = require.resolve("knip");
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string; bin?: string | Record<string, string> };
      if (manifest.name === "knip") {
        const relativeBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.knip;
        if (!relativeBin || !manifest.version) break;
        return { cli: path.resolve(dir, relativeBin), version: manifest.version };
      }
    } catch {
      // Walk upward until Knip's package manifest is found.
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate the bundled Knip CLI. Reinstall Ghost Sweeper and try again.");
}

function toKind(key: string): FindingKind {
  if (key === "files") return "file";
  if (key === "exports" || key === "enumMembers" || key === "namespaceMembers") return "export";
  if (key === "types") return "type";
  if (key === "dependencies" || key === "devDependencies" || key === "optionalPeerDependencies") return "dependency";
  return "other";
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

export function normalizeKnipReport(report: unknown, root: string): Finding[] {
  const raw = report && typeof report === "object" ? report as { issues?: unknown[] } : {};
  const findings: Finding[] = [];
  for (const issueValue of Array.isArray(raw.issues) ? raw.issues : []) {
    if (!issueValue || typeof issueValue !== "object") continue;
    const issue = issueValue as Record<string, unknown>;
    for (const [key, value] of Object.entries(issue)) {
      const kind = toKind(key);
      if (kind === "other" || !Array.isArray(value)) continue;
      for (const item of records(value)) {
        const fileName = typeof item.name === "string" ? item.name : undefined;
        const issueFile = typeof issue.file === "string" ? issue.file : undefined;
        const candidatePath = kind === "file" ? (fileName ?? issueFile) : issueFile;
        const displayName = kind === "file"
          ? (candidatePath ?? "(unknown file)")
          : (typeof item.name === "string" ? item.name : (candidatePath ?? "(unknown finding)"));
        const rel = candidatePath ? path.normalize(candidatePath) : undefined;
        const insideRoot = rel !== undefined && !path.isAbsolute(rel) && !rel.split(path.sep).includes("..");
        const sourceFile = insideRoot ? path.resolve(root, rel) : undefined;
        const fileAction = kind === "file" && !!sourceFile ? "delete-file" : "view-only";
        findings.push({
          id: `${kind}:${candidatePath ?? ""}:${displayName}:${findings.length}`,
          kind,
          name: displayName,
          path: sourceFile,
          detail: typeof item.line === "number" ? `line ${item.line}` : undefined,
          risk: "review-recommended",
          action: fileAction,
          reason: kind === "file" ? "Knip reported this project file as unused." : "Displayed for review; automatic changes are not supported in this release."
        });
      }
    }
  }
  return findings;
}

function runKnip(cli: string, root: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--reporter", "json", "--no-progress", "--no-exit-code"], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const limit = 20 * 1024 * 1024;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > limit) child.kill("SIGTERM");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk.slice(0, limit - stderr.length); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (stdout.length > limit) return reject(new Error("Knip output exceeded the 20 MB safety limit."));
      if (code !== 0) return reject(new Error(`Knip exited with code ${code ?? "unknown"}. ${stderr.trim()}`));
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function analyze(rootInput: string): Promise<ScanResult> {
  const root = path.resolve(rootInput);
  const project = JSON.parse(await readFile(path.join(root, "package.json"), "utf8").catch(() => "{}")) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const { cli, version } = findKnipCli();
  const output = await runKnip(cli, root);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    throw new Error(`Knip returned invalid JSON. ${output.stderr.trim()}`);
  }
  const findings = normalizeKnipReport(parsed, root);
  const unusedFiles = findings.filter((finding) => finding.kind === "file").length;
  const dependencies = { ...project.dependencies, ...project.devDependencies };
  const framework = Object.keys(dependencies).find((name) => ["next", "vite", "react", "astro", "@angular/core", "svelte"].includes(name)) ?? "JavaScript/TypeScript";
  const warnings = output.stderr.trim() ? [output.stderr.trim()] : [];
  return { root, projectName: project.name ?? path.basename(root), framework, unusedFiles, findings, warnings, knipVersion: version };
}

