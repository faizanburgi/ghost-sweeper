import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { StagedCleanup, VerificationResult } from "./model.js";

export interface VerificationScript {
  name: string;
  command: string[];
}

export interface VerificationExecution {
  result: VerificationResult;
  output: string;
}

const supportedScripts = ["test", "build", "typecheck", "lint"] as const;

export async function listVerificationScripts(root: string): Promise<VerificationScript[]> {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  return supportedScripts.flatMap((name) => {
    const script = manifest.scripts?.[name];
    if (typeof script !== "string" || !script.trim()) return [];
    return [{ name, command: ["npm", "run", name] }];
  });
}

export function runVerificationScript(stage: StagedCleanup, name: string): Promise<VerificationExecution> {
  if (!(supportedScripts as readonly string[]).includes(name)) {
    return Promise.reject(new Error(`Verification script “${name}” is not supported.`));
  }
  const command = ["npm", "run", name];
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks: string[] = [];
    let captured = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let timer: NodeJS.Timeout;
    // npm scripts execute project code. Approval is per command; the temporary cwd is not a sandbox.
    const child = spawn("npm", ["run", name], {
      cwd: path.join(stage.tempRoot, "project"),
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32"
    });
    const append = (value: Buffer | string) => {
      const text = value.toString();
      const available = Math.max(0, 64 * 1024 - captured);
      if (text.length > available) overflow = true;
      if (available) chunks.push(text.slice(0, available));
      captured += Math.min(text.length, available);
      if (overflow) child.kill("SIGTERM");
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 120_000);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = exitCode === 0 && !timedOut && !overflow ? "passed" : "failed";
      resolve({
        result: {
          command,
          status,
          exitCode: exitCode ?? (timedOut ? 124 : 1),
          durationMs: Date.now() - startedAt
        },
        output: `${chunks.join("")}${timedOut ? "\nVerification timed out after 120 seconds.\n" : ""}${overflow ? "\nOutput truncated at 64 KB.\n" : ""}`
      });
    };
    child.once("error", (error) => {
      chunks.push(`Could not start ${command.join(" ")}: ${error.message}`);
      finish(1);
    });
    child.once("close", finish);
  });
}
