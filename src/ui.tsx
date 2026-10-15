import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import path from "node:path";
import type { Finding, ScanResult, StagedCleanup, VerificationResult } from "./model.js";
import { applyCleanup, createStagedCleanup, isGitRepository, prepareCleanup, preview, recordVerification, removeStagedCleanup, sessionStorePath } from "./safety.js";
import { listVerificationScripts, runVerificationScript, type VerificationScript } from "./verification.js";

type Screen = "overview" | "findings" | "detail" | "selection" | "preview" | "verify" | "confirm" | "done";

function App({ scan, onStageReady, trackOperation }: { scan: ScanResult; onStageReady: (stage: StagedCleanup) => void; trackOperation: (operation: Promise<unknown>) => void }) {
  const { exit } = useApp();
  const [gitAvailable] = useState(() => isGitRepository(scan.root));
  const [screen, setScreen] = useState<Screen>("overview");
  const [items] = useState(scan.findings);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<Finding | undefined>();
  const [stage, setStage] = useState<StagedCleanup | undefined>();
  const [verificationScripts, setVerificationScripts] = useState<VerificationScript[]>([]);
  const [verificationResults, setVerificationResults] = useState<VerificationResult[]>([]);
  const [verificationOutput, setVerificationOutput] = useState("");
  const [verifyCursor, setVerifyCursor] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [category, setCategory] = useState<"all" | "file" | "markdown" | "export" | "dependency">("all");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const filtered = useMemo(() => items.filter((finding) =>
    (category === "all" || finding.kind === category || (category === "export" && finding.kind === "type")) &&
    (!query || `${finding.name} ${finding.path ?? ""}`.toLowerCase().includes(query.toLowerCase()))), [items, category, query]);
  const selectedItems = items.filter((finding) => selected.has(finding.id));

  useInput((input, key) => {
    if (searching) {
      if (key.return) { setSearching(false); return; }
      if (key.escape) { setQuery(""); setSearching(false); return; }
      if (key.backspace || key.delete) { setQuery(query.slice(0, -1)); setCursor(0); return; }
      if (input && input.length === 1 && input >= " ") { setQuery(query + input); setCursor(0); }
      return;
    }
    if (key.ctrl && input === "c") {
      if (screen === "done") { exit(); return; }
      setMessage("Cancelled. No changes were applied.");
      setScreen("done");
      return;
    }
    if (screen === "done") {
      if (input === "q" || key.ctrl && input === "c") exit();
      return;
    }
    if (busy) return;
    if (screen === "overview") {
      if (key.return || input === "r") setScreen("findings");
      if (input === "q") setScreen("done");
      return;
    }
    if (screen === "findings" || screen === "selection") {
      if (input === "q") { setScreen("done"); return; }
      if (key.escape) { setScreen(screen === "selection" ? "findings" : "overview"); return; }
      if (input === "1") { setCategory("file"); setCursor(0); }
      if (input === "2") { setCategory("export"); setCursor(0); }
      if (input === "3") { setCategory("dependency"); setCursor(0); }
      if (input === "4") { setCategory("markdown"); setCursor(0); }
      if (input === "0") { setCategory("all"); setCursor(0); }
      if (input === "/") { setQuery(""); setCursor(0); setSearching(true); return; }
      if (input === "a") {
        const eligible = filtered.filter((item) => item.action === "delete-file" && item.risk !== "uncertain");
        setSelected(new Set([...selected, ...eligible.map((item) => item.id)]));
      }
      if (input === "n") setSelected(new Set());
      if (input === " ") {
        const current = filtered[cursor];
        if (current?.action === "delete-file") {
          const next = new Set(selected);
          if (next.has(current.id)) next.delete(current.id); else next.add(current.id);
          setSelected(next);
        }
      }
      if (input === "j" || key.downArrow) setCursor(Math.min(cursor + 1, Math.max(0, filtered.length - 1)));
      if (input === "k" || key.upArrow) setCursor(Math.max(0, cursor - 1));
      if (key.return) {
        if (screen === "selection") {
          if (!selectedItems.length) { setMessage("Select at least one eligible file."); return; }
          setBusy(true); setMessage("Checking selected files and creating exact preview…");
          const preparing = preview(scan, selectedItems)
            .then((files) => createStagedCleanup(scan.root, files))
          trackOperation(preparing);
          void preparing
            .then((prepared) => { setStage(prepared); onStageReady(prepared); setSessionId(""); setVerificationResults([]); setMessage(""); setScreen("preview"); })
            .catch((error: Error) => setMessage(error.message))
            .finally(() => setBusy(false));
        } else {
          const current = filtered[cursor];
          if (current) { setDetail(current); setScreen("detail"); }
        }
      }
      if (input === "p" || input === "v") setScreen("selection");
      if (input === "?" ) setMessage("↑↓/j/k move · Space select · Enter details · 1 source · 2 exports · 3 dependencies · 4 Markdown · 0 all · a select stronger candidates · n clear · p preview · q quit");
      return;
    }
    if (screen === "detail") {
      if (key.escape) { setScreen("findings"); return; }
      if (input === " ") {
        if (detail?.action === "delete-file") {
          const next = new Set(selected);
          if (next.has(detail.id)) next.delete(detail.id); else next.add(detail.id);
          setSelected(next);
        }
      }
      if (input === "p") setScreen("selection");
      return;
    }
    if (screen === "preview") {
      if (key.escape) { setScreen("selection"); return; }
      if (input === "v") {
        if (!stage) return;
        if (!gitAvailable) { setMessage("Verification and apply preparation require a Git repository in this release."); return; }
        setBusy(true);
        const preparation = (async () => {
          if (!sessionId) {
            const prepared = await prepareCleanup(stage);
            setSessionId(prepared.id);
          }
          const scripts = await listVerificationScripts(stage.projectRoot);
          setVerificationScripts(scripts);
          setVerifyCursor(0);
          setVerificationOutput("");
          setMessage("");
          setScreen("verify");
        })();
        trackOperation(preparation);
        void preparation.catch((error: Error) => setMessage(error.message)).finally(() => setBusy(false));
        return;
      }
      if (input === "s") {
        if (!stage || !gitAvailable) { setMessage("Apply is blocked without Git; preview remains read-only."); return; }
        setBusy(true);
        const skip = (async () => {
          const prepared = sessionId ? undefined : await prepareCleanup(stage);
          const id = prepared?.id ?? sessionId;
          if (prepared) setSessionId(prepared.id);
          const result: VerificationResult = { command: [], status: "skipped" };
          await recordVerification(id, result);
          setVerificationResults((current) => [...current, result]);
          setMessage("");
          setScreen("confirm");
        })();
        trackOperation(skip);
        void skip.catch((error: Error) => setMessage(error.message)).finally(() => setBusy(false));
      }
      return;
    }
    if (screen === "verify") {
      if (key.escape) { setScreen("preview"); return; }
      if (input === "j" || key.downArrow) setVerifyCursor(Math.min(verifyCursor + 1, Math.max(0, verificationScripts.length - 1)));
      if (input === "k" || key.upArrow) setVerifyCursor(Math.max(0, verifyCursor - 1));
      if (input === "s") {
        if (!stage || !sessionId) return;
        setBusy(true);
        const skipped: VerificationResult = { command: [], status: "skipped" };
        const record = recordVerification(sessionId, skipped);
        trackOperation(record);
        void record
          .then(() => { setVerificationResults((current) => [...current, skipped]); setScreen("confirm"); })
          .catch((error: Error) => setVerificationOutput(error.message))
          .finally(() => setBusy(false));
        return;
      }
      if (input === "f") {
        if (!stage || !sessionId) return;
        setBusy(true);
        const skipped: VerificationResult = { command: [], status: "skipped" };
        const record = recordVerification(sessionId, skipped);
        trackOperation(record);
        void record
          .then(() => { setVerificationResults((current) => [...current, skipped]); setScreen("confirm"); })
          .catch((error: Error) => setVerificationOutput(error.message))
          .finally(() => setBusy(false));
        return;
      }
      if (input.toLowerCase() === "y") {
        const script = verificationScripts[verifyCursor];
        if (!stage || !script) { setVerificationOutput("No supported package scripts were found. Press f to continue without verification."); return; }
        setBusy(true);
        setVerificationOutput(`Running ${script.command.join(" ")} in the staged project copy…`);
        const verification = runVerificationScript(stage, script.name).then(async ({ result, output }) => {
          await recordVerification(sessionId, result);
          setVerificationResults((current) => [...current, result]);
          setVerificationOutput(`${result.status.toUpperCase()} · exit ${result.exitCode} · ${(result.durationMs! / 1000).toFixed(1)}s\n${output}`);
        });
        trackOperation(verification);
        void verification
          .catch((error: Error) => setVerificationOutput(error.message))
          .finally(() => setBusy(false));
        return;
      }
      return;
    }
    if (screen === "confirm") {
      if (input.toLowerCase() === "y") {
        if (!stage || !sessionId) { setMessage("Recovery session is unavailable. Return to findings and preview again."); return; }
        if (!gitAvailable) { setMessage("Apply is blocked because this project is not in a Git repository."); return; }
        setBusy(true); setMessage("Saving recovery data and applying selected deletions…");
        const apply = applyCleanup(stage, sessionId);
        trackOperation(apply);
        void apply.then((session) => { setVerificationResults(session.verification); setMessage(""); setScreen("done"); }).catch((error: Error) => setMessage(error.message)).finally(() => setBusy(false));
      }
      if (input.toLowerCase() === "n" || key.escape) { setScreen("preview"); setMessage(""); }
    }
  });

  const header = <Text bold color="magenta">Ghost Sweeper 👻  {scan.projectName}</Text>;
  const count = (kind: string) => scan.findings.filter((item) => item.kind === kind).length;
  return <Box flexDirection="column" padding={1}>
    {header}
    <Text dimColor>{scan.framework} · Knip {scan.knipVersion} · {scan.unusedFiles} unused file finding(s)</Text>
    {scan.warnings.map((warning, index) => <Text key={`warning-${index}`} color="yellow">Knip: {warning}</Text>)}
    {screen === "overview" && <Box flexDirection="column" marginTop={1}>
      <Text>Scan complete. No files have been changed.</Text>
      <Text>Source files: {count("file")}   Markdown: {count("markdown")}   Exports/types: {count("export") + count("type")}   Dependencies: {count("dependency")}</Text>
      <Text color="yellow">Trust notice: Knip plugins may load and execute project configuration files.</Text>
      <Text>Press Enter to review findings · q to quit</Text>
    </Box>}
    {(screen === "findings" || screen === "selection") && <Box flexDirection="column" marginTop={1}>
      <Text bold>Findings · {filtered.length} shown · {selected.size} selected</Text>
      <Text dimColor>Filter: {category} · Search: {query.trim() || "(none)"}</Text>
      {filtered.length === 0 && <Text dimColor>No findings match this filter.</Text>}
      {filtered.slice(Math.max(0, cursor - 8), cursor + 12).map((finding, localIndex) => {
        const absoluteIndex = Math.max(0, cursor - 8) + localIndex;
        const marker = selected.has(finding.id) ? "☑" : finding.action === "delete-file" ? "☐" : "·";
        const treatment = finding.action !== "delete-file"
          ? "[view only]"
          : finding.risk === "uncertain" ? "[uncertain · select individually]" : "[review required]";
        return <Text key={finding.id} color={absoluteIndex === cursor ? "cyan" : undefined}>
          {absoluteIndex === cursor ? ">" : " "} {marker} {finding.kind.padEnd(12)} {finding.name} {treatment}
        </Text>;
      })}
      <Text dimColor>{searching ? `Search input: ${query} · Enter finish · Esc clear` : "↑↓/j/k move · Space select · Enter details/preview · / search · 1 source · 2 exports · 3 deps · 4 Markdown · 0 all · a select stronger · n clear · Esc back"}</Text>
    </Box>}
    {screen === "detail" && detail && <Box flexDirection="column" marginTop={1}>
      <Text bold>{detail.name}</Text>
      <Text>Category: {detail.kind} · Risk: {detail.risk}</Text>
      {detail.path && <Text>Path: {pathForDisplay(scan.root, detail.path)}</Text>}
      <Text>Evidence: {detail.reason}</Text>
      <Text>Uncertainty: Static analysis cannot detect every runtime convention, reflection, or external consumer.</Text>
      <Text>Action: {detail.action === "delete-file" ? "File deletion is eligible after preview and confirmation." : "View only in this release."}</Text>
      <Text dimColor>Space select · p preview · Esc back</Text>
    </Box>}
    {screen === "selection" && message && <Text color="yellow">{message}</Text>}
    {screen === "preview" && <Box flexDirection="column" marginTop={1}>
      <Text bold>Staged preview · {stage?.files.length ?? 0} file deletion(s)</Text>
      {stage?.files.map((file) => <Text key={file.path}>DELETE {pathForDisplay(scan.root, file.path)} · {file.lines} lines · SHA256 {file.hash.slice(0, 12)}</Text>)}
      <Text dimColor>Temporary copy: {stage?.tempRoot}</Text>
      <Text color="yellow">The copy excludes .git and node_modules. Approved scripts run as project code and may have external side effects; this is not a sandbox.</Text>
      <Text>{gitAvailable ? "v verify in copy · s skip checks and continue · Esc back" : "Apply is blocked without Git; preview is read-only"}</Text>
    </Box>}
    {screen === "verify" && <Box flexDirection="column" marginTop={1}>
      <Text bold>Verification · staged copy</Text>
      <Text>Working directory: {stage ? path.join(stage.tempRoot, "project") : "unavailable"}</Text>
      <Text dimColor>Environment: current shell environment, CI=1, no color · 120 second timeout</Text>
      {verificationScripts.length === 0 && <Text color="yellow">No supported npm scripts found (test/build/typecheck/lint).</Text>}
      {verificationScripts.map((script, index) => <Text key={script.name} color={index === verifyCursor ? "cyan" : undefined}>
        {index === verifyCursor ? ">" : " "} {script.command.join(" ")}{verificationResults.filter((result) => result.command.join(" ") === script.command.join(" ")).map((result) => ` · ${result.status}`).at(-1) ?? ""}
      </Text>)}
      <Text dimColor>↑↓/j/k choose · y approve and run this command · run each command separately</Text>
      <Text dimColor>f finish checks · s skip checks · Esc back</Text>
      {verificationOutput && <Text>{verificationOutput}</Text>}
    </Box>}
    {screen === "confirm" && <Box flexDirection="column" marginTop={1}>
      <Text color="red" bold>Apply these {stage?.files.length ?? 0} deletions to the project?</Text>
      {verificationResults.some((result) => result.status === "failed") && <Text color="yellow">At least one approved verification command failed. You may return to review or explicitly apply anyway.</Text>}
      {verificationResults.every((result) => result.status === "passed") && <Text color="green">All approved verification commands passed.</Text>}
      <Text>Original contents will be stored in {sessionStorePath} before deletion.</Text>
      <Text>Type y to apply, n to return. Project-wide changes since preview block apply.</Text>
    </Box>}
    {screen === "done" && <Box flexDirection="column" marginTop={1}>
      {sessionId ? <><Text color="green" bold>Cleanup applied · {sessionId}</Text><Text>Verification: {verificationResults.map((result) => result.command.length ? `${result.command.join(" ")} ${result.status}` : result.status).join(", ") || "skipped"}</Text><Text>Restore with: ghost-sweeper undo {sessionId}</Text></> : <Text>{message || "No changes were applied."}</Text>}
      <Text>Press q or Ctrl-C to exit.</Text>
    </Box>}
    {message && screen !== "selection" && screen !== "done" && <Text color="yellow">{message}</Text>}
    {busy && <Text color="yellow">Working…</Text>}
  </Box>;
}

function pathForDisplay(root: string, file: string): string {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}

export async function runTui(scan: ScanResult): Promise<void> {
  const stages: StagedCleanup[] = [];
  const operations: Promise<unknown>[] = [];
  const app = render(<App scan={scan} onStageReady={(created) => { stages.push(created); }} trackOperation={(operation) => { operations.push(operation); }} />, { exitOnCtrlC: false });
  try {
    await app.waitUntilExit();
  } finally {
    await Promise.allSettled(operations);
    for (const stage of stages) await removeStagedCleanup(stage).catch(() => undefined);
  }
}
