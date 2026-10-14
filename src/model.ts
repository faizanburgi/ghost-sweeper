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
  verification: Array<{ command: string; status: "not-run" | "passed" | "failed" | "skipped" }>;
  files: BackupEntry[];
}
