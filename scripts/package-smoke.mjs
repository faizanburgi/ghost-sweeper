import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ghost-sweeper-package-smoke-"));
const installRoot = path.join(temporaryRoot, "install");
const fixtureRoot = path.join(temporaryRoot, "fixture");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    shell: process.platform === "win32",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}).\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

try {
  await mkdir(installRoot);
  const pack = JSON.parse(run(npmCommand, ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot]));
  const tarball = path.join(temporaryRoot, pack[0].filename);
  run(npmCommand, ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);

  const executable = path.join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "ghost-sweeper.cmd" : "ghost-sweeper");
  run(executable, ["--help"]);

  await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "ghost-sweeper-package-smoke", type: "module" }));
  await writeFile(path.join(fixtureRoot, "src", "index.ts"), "export const live = 1;\n");
  await writeFile(path.join(fixtureRoot, "src", "unused.ts"), "export const unused = 2;\n");
  const json = run(executable, ["scan", "--json", "--allow-config-execution"], { cwd: fixtureRoot });
  const result = JSON.parse(json);
  if (!result.findings.some((finding) => finding.kind === "file" && finding.path === path.join("src", "unused.ts"))) {
    throw new Error("The installed package did not report the fixture's unused source file.");
  }
  process.stdout.write("Packed install, CLI launch, and Knip JSON scan passed.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
