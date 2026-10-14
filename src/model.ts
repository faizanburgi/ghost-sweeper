export type FindingKind = "file" | "export" | "type" | "dependency" | "other";

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
}

export interface PreviewFile {
  path: string;
  hash: string;
  lines: number;
  mode: number;
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
  state: "pending" | "deleted" | "restored" | "conflict";
}

export interface Session {
  id: string;
  createdAt: string;
  root: string;
  status: "prepared" | "applying" | "applied" | "interrupted" | "conflict" | "restoring" | "restored";
  verification: VerificationResult[];
  files: BackupEntry[];
}
