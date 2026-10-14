import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type { Finding, ScanResult } from "./model.js";
import { applyCleanup, isGitRepository, preview, sessionStorePath } from "./safety.js";

type Screen = "overview" | "findings" | "detail" | "selection" | "preview" | "confirm" | "done";

function App({ scan }: { scan: ScanResult }) {
  const { exit } = useApp();
  const [gitAvailable] = useState(() => isGitRepository(scan.root));
  const [screen, setScreen] = useState<Screen>("overview");
  const [items] = useState(scan.findings);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<Finding | undefined>();
  const [previewFiles, setPreviewFiles] = useState<Array<{ path: string; hash: string; lines: number; mode: number }>>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [category, setCategory] = useState<"all" | "file" | "export" | "dependency">("all");
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
      if (input === "0") { setCategory("all"); setCursor(0); }
      if (input === "/") { setQuery(""); setCursor(0); setSearching(true); return; }
      if (input === "a") {
        const eligible = filtered.filter((item) => item.action === "delete-file");
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
          void preview(scan, selectedItems).then((files) => { setPreviewFiles(files); setMessage(""); setScreen("preview"); }).catch((error: Error) => setMessage(error.message)).finally(() => setBusy(false));
        } else {
          const current = filtered[cursor];
          if (current) { setDetail(current); setScreen("detail"); }
        }
      }
      if (input === "p" || input === "v") setScreen("selection");
      if (input === "?" ) setMessage("↑↓/j/k move · Space select · Enter details · 1 files · 2 exports · 3 dependencies · 0 all · a select eligible · n clear · p preview · q quit");
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
      if (key.return) {
        if (!gitAvailable) { setMessage("Apply is blocked because this project is not in a Git repository. Preview is read-only."); return; }
        setMessage(""); setScreen("confirm"); return;
      }
      return;
    }
    if (screen === "confirm") {
      if (input.toLowerCase() === "y") {
        setBusy(true); setMessage("Saving recovery data and applying selected deletions…");
        void applyCleanup(scan.root, previewFiles).then((session) => { setSessionId(session.id); setMessage(""); setScreen("done"); }).catch((error: Error) => setMessage(error.message)).finally(() => setBusy(false));
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
      <Text>Unused files: {count("file")}   Exports/types: {count("export") + count("type")}   Dependencies: {count("dependency")}</Text>
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
        return <Text key={finding.id} color={absoluteIndex === cursor ? "cyan" : undefined}>
          {absoluteIndex === cursor ? ">" : " "} {marker} {finding.kind.padEnd(12)} {finding.name} {finding.action !== "delete-file" ? "[view only]" : "[review required]"}
        </Text>;
      })}
      <Text dimColor>{searching ? `Search input: ${query} · Enter finish · Esc clear` : "↑↓/j/k move · Space select · Enter details/preview · / search · 1 files · 2 exports · 3 deps · 0 all · a select eligible · n clear · Esc back"}</Text>
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
      <Text bold>Preview · {previewFiles.length} file deletion(s)</Text>
      {previewFiles.map((file) => <Text key={file.path}>DELETE {pathForDisplay(scan.root, file.path)} · {file.lines} lines · SHA256 {file.hash.slice(0, 12)}</Text>)}
      <Text color="yellow">No verification command will run. Verification support is not implemented in this build.</Text>
      <Text>{gitAvailable ? "Enter to continue to explicit approval" : "Apply blocked without Git; preview is read-only"} · Esc back</Text>
    </Box>}
    {screen === "confirm" && <Box flexDirection="column" marginTop={1}>
      <Text color="red" bold>Apply these {previewFiles.length} deletions to the project?</Text>
      <Text>Original contents will be stored in {sessionStorePath} before deletion.</Text>
      <Text>Type y to apply, n to return. This cannot be undone if you delete the recovery store.</Text>
    </Box>}
    {screen === "done" && <Box flexDirection="column" marginTop={1}>
      {sessionId ? <><Text color="green" bold>Cleanup applied · {sessionId}</Text><Text>Restore with: ghost-sweeper undo {sessionId}</Text></> : <Text>{message || "No changes were applied."}</Text>}
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
  const app = render(<App scan={scan} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
}
