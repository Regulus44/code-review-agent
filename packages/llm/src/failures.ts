import type { ModelStreamPart } from "@code-review-agent/contracts";

/** Provider-neutral failure classes used by adapters and Runtime diagnostics. */
export type ModelFailureCode =
  | "ABORTED"
  | "TIMEOUT"
  | "AUTH"
  | "RATE_LIMIT"
  | "OVERLOADED"
  | "CONTEXT_WINDOW_EXCEEDED"
  | "STREAM_CLOSED"
  | "NETWORK"
  | "PROTOCOL_ERROR"
  | "CONFIGURATION"
  | "PROVIDER_ERROR";

export interface ModelFailureMetadata {
  readonly code: ModelFailureCode;
  readonly status?: number;
  readonly providerCode?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly partialOutput?: boolean;
}

/** Bounded, provider-neutral error facts safe for EventStore diagnostics. */
export class ModelFailureError extends Error implements ModelFailureMetadata {
  readonly code: ModelFailureCode;
  readonly status?: number;
  readonly providerCode?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly partialOutput?: boolean;

  constructor(message: string, metadata: ModelFailureMetadata) {
    super(sanitizeFailureMessage(message));
    this.name = "ModelFailureError";
    this.code = metadata.code;
    this.retryable = metadata.retryable;
    if (metadata.status !== undefined) this.status = metadata.status;
    if (metadata.providerCode !== undefined) this.providerCode = bound(metadata.providerCode, 120);
    if (metadata.retryAfterMs !== undefined) this.retryAfterMs = boundedRetryAfter(metadata.retryAfterMs);
    if (metadata.requestId !== undefined) this.requestId = bound(metadata.requestId, 160);
    if (metadata.partialOutput !== undefined) this.partialOutput = metadata.partialOutput;
  }
}

export function modelFailureMetadata(error: unknown): ModelFailureMetadata {
  const record = asRecord(error);
  const status = integer(record?.["status"], record?.["statusCode"], record?.["httpStatus"]);
  const code = normalizeCode(record?.["code"] ?? record?.["failureCode"] ?? record?.["errorCode"], status, error);
  const providerCode = firstString(record?.["providerCode"]);
  const retryAfterMs = finite(record?.["retryAfterMs"] ?? record?.["providerRetryAfterMs"]);
  const requestId = firstString(record?.["requestId"] ?? record?.["providerRequestId"]);
  const partialOutput = record?.["partialOutput"] === true ? true : undefined;
  const retryable = record?.["retryable"] === true || isRetryable(code, status);
  return {
    code,
    retryable,
    ...(status === undefined ? {} : { status }),
    ...(providerCode === undefined ? {} : { providerCode: bound(providerCode, 120) }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs: boundedRetryAfter(retryAfterMs) }),
    ...(requestId === undefined ? {} : { requestId: bound(requestId, 160) }),
    ...(partialOutput === undefined ? {} : { partialOutput }),
  };
}

export function failureFromStreamPart(part: Extract<ModelStreamPart, { readonly type: "error" }>): ModelFailureError {
  return new ModelFailureError(part.message, {
    code: normalizeCode(part.failureCode ?? part.code, part.status, part.message),
    retryable: part.retryable ?? isRetryable(part.failureCode ?? part.code, part.status),
    ...(part.status === undefined ? {} : { status: part.status }),
    ...(part.providerCode === undefined ? {} : { providerCode: part.providerCode }),
    ...(part.retryAfterMs === undefined ? {} : { retryAfterMs: part.retryAfterMs }),
    ...(part.requestId === undefined ? {} : { requestId: part.requestId }),
    ...(part.partialOutput === undefined ? {} : { partialOutput: part.partialOutput }),
  });
}

/** Parse HTTP Retry-After seconds or an HTTP-date into a bounded delay. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return boundedRetryAfter(Number(trimmed) * 1_000);
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  return boundedRetryAfter(Math.max(0, timestamp - now));
}

export function retryDelayMs(attempt: number, retryAfterMs?: number, baseDelayMs = 250, maxDelayMs = 30_000): number {
  if (retryAfterMs !== undefined) return Math.min(maxDelayMs, boundedRetryAfter(retryAfterMs));
  const exponent = Math.max(0, Math.min(8, Math.floor(attempt) - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs));
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent) + jitter);
}

export function isRetryableFailure(error: unknown): boolean {
  return modelFailureMetadata(error).retryable;
}

export function sanitizeFailureMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [redacted]")
    .replace(/(?:sk|key|token)[-_]?[A-Za-z0-9]{8,}/giu, "[redacted]")
    .slice(0, 500);
}

function normalizeCode(value: unknown, status: number | undefined, error: unknown): ModelFailureCode {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  if (raw === "ABORTED" || raw.includes("CANCEL") || raw.includes("ABORT")) return "ABORTED";
  if (raw === "TIMEOUT" || raw.includes("TIMEOUT") || raw.includes("IDLE")) return "TIMEOUT";
  if (raw === "AUTH" || raw.includes("AUTH") || status === 401 || status === 403) return "AUTH";
  if (raw === "RATE_LIMIT" || raw.includes("RATE") || status === 429) return "RATE_LIMIT";
  if (raw === "OVERLOADED" || raw.includes("OVERLOAD") || status === 529) return "OVERLOADED";
  if (raw === "CONTEXT_WINDOW_EXCEEDED" || raw.includes("CONTEXT") || raw.includes("TOO_LARGE") || status === 413) return "CONTEXT_WINDOW_EXCEEDED";
  if (raw === "STREAM_CLOSED" || raw.includes("STREAM_CLOSED")) return "STREAM_CLOSED";
  if (raw.includes("PROTOCOL") || raw.includes("MALFORMED")) return "PROTOCOL_ERROR";
  if (raw.includes("CONFIGURATION") || raw.includes("CONFIG")) return "CONFIGURATION";
  if (raw.includes("NETWORK") || raw.includes("FETCH") || raw.includes("ECONN")) return "NETWORK";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("abort") || message.includes("cancel")) return "ABORTED";
  if (message.includes("timeout") || message.includes("timed out")) return "TIMEOUT";
  return "PROVIDER_ERROR";
}

function isRetryable(code: ModelFailureCode | string, status?: number): boolean {
  return code === "NETWORK" || code === "RATE_LIMIT" || code === "OVERLOADED" || (status !== undefined && status >= 500 && status !== 501);
}

function boundedRetryAfter(value: number): number {
  return Math.max(0, Math.min(300_000, Math.floor(value)));
}

function bound(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function integer(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
