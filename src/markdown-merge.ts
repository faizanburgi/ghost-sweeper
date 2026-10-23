import type { MarkdownMatchGroup, MarkdownMergeDraft, MarkdownSourceReference } from "./model.js";

const sourceSchema = {
  type: "OBJECT",
  properties: {
    path: { type: "STRING" }, startLine: { type: "INTEGER" }, endLine: { type: "INTEGER" }, excerpt: { type: "STRING" }
  },
  required: ["path", "startLine", "endLine", "excerpt"]
};
const responseSchema = {
  type: "OBJECT",
  properties: {
    relationship: { type: "STRING", enum: ["duplicate", "overlapping", "related"] },
    draft: { type: "STRING" },
    sections: { type: "ARRAY", items: {
      type: "OBJECT",
      properties: { heading: { type: "STRING" }, content: { type: "STRING" }, sources: { type: "ARRAY", items: sourceSchema } },
      required: ["heading", "content", "sources"]
    } },
    sources: { type: "ARRAY", items: sourceSchema },
    conflicts: { type: "ARRAY", items: {
      type: "OBJECT",
      properties: { id: { type: "STRING" }, topic: { type: "STRING" }, sources: { type: "ARRAY", items: sourceSchema } },
      required: ["id", "topic", "sources"]
    } }
  },
  required: ["relationship", "draft", "sections", "sources", "conflicts"]
};

function parseJson(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(clean);
}

function verifyReference(value: unknown, contents: Map<string, string>): MarkdownSourceReference {
  if (!value || typeof value !== "object") throw new Error("Gemini returned an invalid source reference.");
  const ref = value as Record<string, unknown>;
  if (typeof ref.path !== "string" || !contents.has(ref.path) || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine) || typeof ref.excerpt !== "string") {
    throw new Error("Gemini cited a file or line range outside the uploaded group.");
  }
  const lines = contents.get(ref.path)!.split(/\r?\n/);
  const start = ref.startLine as number;
  const end = ref.endLine as number;
  if (start < 1 || end < start || end > lines.length || end - start > 80) throw new Error(`Gemini cited an invalid line range in ${ref.path}.`);
  const actual = lines.slice(start - 1, end).join("\n").trim();
  if (!actual || actual !== ref.excerpt.trim()) throw new Error(`Gemini citation does not match ${ref.path}:${start}-${end}.`);
  return { path: ref.path, startLine: start, endLine: end, excerpt: actual };
}

export function validateMergeDraft(value: unknown, contents: Map<string, string>): MarkdownMergeDraft {
  if (!value || typeof value !== "object") throw new Error("Gemini returned an invalid merge response.");
  const result = value as Record<string, unknown>;
  if (!(["duplicate", "overlapping", "related"] as unknown[]).includes(result.relationship) || typeof result.draft !== "string" || result.draft.length > 1_000_000 || !Array.isArray(result.sources) || !Array.isArray(result.sections) || !result.sections.length || !Array.isArray(result.conflicts)) {
    throw new Error("Gemini response did not match the expected merge format.");
  }
  const modelDraft = result.draft as string;
  const sources = result.sources.map((item) => verifyReference(item, contents));
  if (!sources.length) throw new Error("Gemini returned no source citations for the proposed merge.");
  const sections = result.sections.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Gemini returned an invalid merge section.");
    const section = item as Record<string, unknown>;
    if (typeof section.heading !== "string" || !/^#{1,6}\s+\S/.test(section.heading) || typeof section.content !== "string" || !section.content.trim() || !Array.isArray(section.sources) || !section.sources.length) throw new Error("Every proposed section needs a Markdown heading, content, and at least one cited source passage.");
    if (!modelDraft.includes(section.content)) throw new Error(`Draft does not contain the proposed section “${section.heading}”.`);
    return { heading: section.heading, content: section.content, sources: section.sources.map((source) => verifyReference(source, contents)) };
  });
  const conflicts = result.conflicts.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Gemini returned an invalid conflict.");
    const conflict = item as Record<string, unknown>;
    if (typeof conflict.id !== "string" || typeof conflict.topic !== "string" || !Array.isArray(conflict.sources) || conflict.sources.length < 2) throw new Error("Gemini returned a conflict without multiple cited alternatives.");
    return { id: conflict.id, topic: conflict.topic, sources: conflict.sources.map((source) => verifyReference(source, contents)) };
  });
  const fullDraft = sections.map((section) => `${section.heading}\n\n${section.content}`).join("\n\n");
  return { relationship: result.relationship as MarkdownMergeDraft["relationship"], draft: fullDraft, sources, sections, conflicts };
}

export async function analyzeMarkdownGroup(
  group: MarkdownMatchGroup,
  documents: Array<{ path: string; contents: string }>,
  apiKey: string,
  model = process.env.GHOST_SWEEPER_GEMINI_MODEL || "gemini-3.8-flash"
): Promise<MarkdownMergeDraft> {
  if (!apiKey.trim()) throw new Error("GEMINI_API_KEY is empty.");
  const names = new Set(group.files.map((file) => file.path));
  if (documents.length !== names.size || documents.some((item) => !names.has(item.path))) throw new Error("Uploaded documents do not match the selected Markdown group.");
  if (documents.some((item) => item.contents.length > 500_000)) throw new Error("A selected Markdown file exceeds the 500 KB upload limit.");
  const contents = new Map(documents.map((item) => [item.path, item.contents]));
  const input = documents.map(({ path, contents }) => `--- FILE: ${path} ---\n${contents}`).join("\n\n");
  const prompt = `Compare these Markdown files and propose a careful merged draft. Preserve useful distinct information and structure. Do not invent facts. Break the entire draft into logical sections and cite at least one exact, verbatim source passage for every section. Each section must have a Markdown heading and content; the full draft should be those heading/content pairs joined by one blank line. Identify disagreements as conflicts; cite at least two exact, verbatim source passages for every conflict. Every source reference must give a repository-relative path, 1-based inclusive lines, and the exact text of those lines. Use relationship ${group.relationship} as a hint, but choose the best label. Put {{CONFLICT:<id>}} at each unresolved conflict location in a section's content. Return only the required structured JSON.\n\n${input}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseSchema } }),
    signal: AbortSignal.timeout(90_000)
  });
  if (!response.ok) throw new Error(`Gemini API request failed (HTTP ${response.status}). Check the key, model, and API availability.`);
  const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no structured merge draft.");
  try { return validateMergeDraft(parseJson(text), contents); }
  catch (error) { throw new Error(`Gemini merge response could not be validated: ${error instanceof Error ? error.message : "invalid response"}`); }
}

export function validateMergeAgainstGroup(draft: MarkdownMergeDraft, group: MarkdownMatchGroup): void {
  const allowed = new Set(group.files.map((file) => file.path));
  if (draft.sources.some((source) => !allowed.has(source.path)) || draft.sections.some((section) => section.sources.some((source) => !allowed.has(source.path))) || draft.conflicts.some((conflict) => conflict.sources.some((source) => !allowed.has(source.path)))) {
    throw new Error("Merge draft contains citations outside the selected comparison group.");
  }
  for (const conflict of draft.conflicts) {
    if (!draft.draft.includes(`{{CONFLICT:${conflict.id}}}`)) throw new Error(`Conflict ${conflict.id} has no placeholder in the draft.`);
  }
}
