import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMarkdownGroup, validateMergeDraft } from "../src/markdown-merge.js";
import { getDraft } from "../src/markdown-cli.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MarkdownMatchGroup } from "../src/model.js";

const group: MarkdownMatchGroup = {
  id: "md:one.md::two.md",
  relationship: "overlapping",
  similarity: 0.5,
  files: [{ path: "one.md", protected: false }, { path: "two.md", protected: false }],
  evidence: ["fixture"]
};
const docs = [{ path: "one.md", contents: "# Guide\nUse port 3000.\n" }, { path: "two.md", contents: "# Guide\nUse port 4000.\n" }];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
group.files[0].hash = hash(docs[0].contents);
group.files[1].hash = hash(docs[1].contents);
const valid = {
  relationship: "overlapping",
  draft: "# Guide\n\n{{CONFLICT:port}}\n",
  sources: [{ path: "one.md", startLine: 2, endLine: 2, excerpt: "Use port 3000." }],
  sections: [{ heading: "# Guide", content: "{{CONFLICT:port}}", sources: [{ path: "one.md", startLine: 1, endLine: 1, excerpt: "# Guide" }] }],
  conflicts: [{ id: "port", topic: "Default port", sources: [
    { path: "one.md", startLine: 2, endLine: 2, excerpt: "Use port 3000." },
    { path: "two.md", startLine: 2, endLine: 2, excerpt: "Use port 4000." }
  ] }]
};

afterEach(() => vi.unstubAllGlobals());

describe("Gemini Markdown merge adapter", () => {
  it("sends only the selected group and validates exact source passages", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-test-key");
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts[0].text).toContain("one.md");
      expect(body.contents[0].parts[0].text).toContain("two.md");
      expect(body.contents[0].parts[0].text).not.toContain("hidden.md");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(valid) }] } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await analyzeMarkdownGroup(group, docs, "secret-test-key");
    expect(result.conflicts).toHaveLength(1);
    expect(result.sources[0].excerpt).toBe("Use port 3000.");
  });

  it("rejects nonexistent and inexact citations before showing a draft", () => {
    const contents = new Map(docs.map((item) => [item.path, item.contents]));
    expect(() => validateMergeDraft({ ...valid, sources: [{ path: "missing.md", startLine: 1, endLine: 1, excerpt: "x" }] }, contents)).toThrow(/outside the uploaded group/);
    expect(() => validateMergeDraft({ ...valid, sources: [{ path: "one.md", startLine: 2, endLine: 2, excerpt: "made up" }] }, contents)).toThrow(/does not match/);
  });

  it("does not include API keys in API endpoint URLs", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).not.toContain("secret-test-key");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(valid) }] } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await analyzeMarkdownGroup(group, docs, "secret-test-key");
  });

  it("handles API and malformed structured response failures without exposing the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("service unavailable", { status: 503 })));
    await expect(analyzeMarkdownGroup(group, docs, "secret-test-key")).rejects.toThrow("HTTP 503");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 })));
    await expect(analyzeMarkdownGroup(group, docs, "secret-test-key")).rejects.toThrow(/could not be validated/);
  });

  it("does not contact Gemini without non-TTY upload approval or when offline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ghost-sweeper-cloud-consent-"));
    try {
      await writeFile(path.join(root, "one.md"), docs[0].contents);
      await writeFile(path.join(root, "two.md"), docs[1].contents);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(getDraft(root, group, false, false)).rejects.toThrow(/--allow-cloud-upload/);
      await expect(getDraft(root, group, true, true)).rejects.toThrow(/--offline/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
