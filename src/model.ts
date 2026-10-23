export type FindingKind = "file" | "markdown" | "export" | "type" | "dependency" | "other";

export interface Finding {
  id: string;
  kind: FindingKind;
  name: string;
  path?: string;
  detail?: string;
  risk: "review-recommended" | "uncertain";
  action: "delete-file" | "view-only" | "blocked";
  reason?: string;
}

export interface ScanResult {
  root: string;
  projectName: string;
  framework: string;
  unusedFiles: number;
  findings: Finding[];
  warnings: string[];
  knipVersion: string;
  markdownGroups: MarkdownMatchGroup[];
}

export interface MarkdownMatchGroup {
  id: string;
  relationship: "duplicate" | "overlapping" | "related";
  similarity: number;
  files: Array<{ path: string; protected: boolean; hash: string }>;
  evidence: string[];
}

export interface MarkdownSourceReference {
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface MarkdownConflict {
  id: string;
  topic: string;
  sources: MarkdownSourceReference[];
  resolution?: string;
}

export interface MarkdownMergeSection {
  heading: string;
  content: string;
  sources: MarkdownSourceReference[];
}

export interface MarkdownMergeDraft {
  relationship: "duplicate" | "overlapping" | "related";
  draft: string;
  sources: MarkdownSourceReference[];
  sections: MarkdownMergeSection[];
  conflicts: MarkdownConflict[];
}

export interface PreviewFile {
  path: string;
  hash: string;
  lines: number;
  mode: number;
  replacementBase64?: string;
  replacementHash?: string;
}

export interface StagedCleanup {
  id: string;
  tempRoot: string;
  projectRoot: string;
  projectFingerprint: string;
  files: PreviewFile[];
}

export interface VerificationResult {
  command: string[];
  status: "passed" | "failed" | "skipped" | "blocked";
  exitCode?: number;
  durationMs?: number;
}

export interface BackupEntry {
  path: string;
  originalBase64: string;
  mode: number;
  originalHash: string;
  deletedHash: string;
  replacementBase64?: string;
  replacementHash?: string;
  state: "pending" | "deleted" | "replaced" | "restored" | "conflict";
}

export interface Session {
  id: string;
  createdAt: string;
  root: string;
  status: "prepared" | "applying" | "applied" | "interrupted" | "conflict" | "restoring" | "restored";
  verification: VerificationResult[];
  files: BackupEntry[];
}
