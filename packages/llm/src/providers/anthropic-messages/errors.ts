import { sanitizeFailureMessage, type ModelFailureCode } from "../../failures.js";

export class AnthropicMessagesError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly failureCode: ModelFailureCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly partialOutput?: boolean;

  constructor(code: string, message: string, options: { readonly status?: number; readonly providerCode?: string; readonly failureCode?: ModelFailureCode; readonly retryable?: boolean; readonly retryAfterMs?: number; readonly requestId?: string; readonly partialOutput?: boolean } = {}) {
    super(sanitizeFailureMessage(message));
    this.name = "AnthropicMessagesError";
    this.code = code;
    this.failureCode = options.failureCode ?? failureCodeFor(code, options.status);
    this.retryable = options.retryable ?? (this.failureCode === "NETWORK" || this.failureCode === "RATE_LIMIT" || this.failureCode === "OVERLOADED" || (options.status !== undefined && options.status >= 500));
    if (options.status !== undefined) this.status = options.status;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.min(300_000, Math.floor(options.retryAfterMs)));
    if (options.requestId !== undefined) this.requestId = options.requestId.slice(0, 160);
    if (options.partialOutput !== undefined) this.partialOutput = options.partialOutput;
  }
}

export function anthropicHttpError(status: number, providerCode?: string, detail?: string, options: { readonly retryAfterMs?: number; readonly requestId?: string } = {}): AnthropicMessagesError {
  const code = status === 401 || status === 403
    ? "ANTHROPIC_AUTHENTICATION_FAILED"
    : status === 413
      ? "ANTHROPIC_CONTEXT_TOO_LARGE"
      : status === 429
        ? "ANTHROPIC_RATE_LIMITED"
        : status === 529
          ? "ANTHROPIC_OVERLOADED"
          : "ANTHROPIC_HTTP_ERROR";
  const boundedDetail = detail === undefined || detail.length === 0 ? "" : `: ${detail.slice(0, 300)}`;
  return new AnthropicMessagesError(code, `Anthropic Messages request failed with HTTP ${status}${boundedDetail}`, {
    status,
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  });
}

function failureCodeFor(code: string, status?: number): ModelFailureCode {
  if (status === 401 || status === 403 || code.includes("AUTH")) return "AUTH";
  if (status === 413 || code.includes("CONTEXT")) return "CONTEXT_WINDOW_EXCEEDED";
  if (status === 429 || code.includes("RATE")) return "RATE_LIMIT";
  if (status === 529 || code.includes("OVERLOAD")) return "OVERLOADED";
  if (code.includes("TIMEOUT")) return "TIMEOUT";
  if (code.includes("STREAM_CLOSED")) return "STREAM_CLOSED";
  if (code.includes("PROTOCOL")) return "PROTOCOL_ERROR";
  if (code.includes("CONFIGURATION")) return "CONFIGURATION";
  if (code.includes("FETCH")) return "NETWORK";
  return "PROVIDER_ERROR";
}
