import type { WebConnectionState } from "../client/store.js";

export type ConnectionTone = "neutral" | "warning" | "error";

export interface ConnectionRenderIntent {
  readonly visible: boolean;
  readonly tone: ConnectionTone;
  readonly message: string;
  readonly retryable: boolean;
}

/** Convert transport state into bounded, user-facing shell status. */
export function presentConnection(connection: WebConnectionState, error?: string, maxMessageChars = 240): ConnectionRenderIntent {
  switch (connection) {
    case "idle":
    case "connected":
      return { visible: false, tone: "neutral", message: "", retryable: false };
    case "connecting":
      return { visible: true, tone: "neutral", message: "Loading session…", retryable: false };
    case "reconnecting":
      return { visible: true, tone: "warning", message: bounded(`Connection interrupted; retrying${error === undefined ? "…" : `: ${error}`}`, maxMessageChars), retryable: false };
    case "failed":
      return { visible: true, tone: "error", message: bounded(`Connection failed${error === undefined ? "" : `: ${error}`}`, maxMessageChars), retryable: true };
  }
}

function bounded(value: string, maxChars: number): string {
  const limit = Math.max(32, Math.floor(maxChars));
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
