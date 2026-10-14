export class GhostSweeperError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "GhostSweeperError";
  }
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
