import { createHash } from "node:crypto";
import type {
  ChatMessage,
  ModelRequest,
  ContextRecoveryErrorClass,
} from "@code-review-agent/contracts";

export interface ProviderContextError {
  readonly errorClass: ContextRecoveryErrorClass;
  readonly message: string;
  readonly code?: string;
  readonly providerCode?: string;
  readonly status?: number;
}

export interface RecoveryGuardSnapshot {
  readonly reactiveAttempts: number;
  readonly consecutiveCompactionFailures: number;
  readonly circuitOpen: boolean;
  readonly attemptedModules: readonly string[];
}

/**
 * Per-turn guard modeled after Claude Code's query-loop tracking. It prevents
 * a failed reactive retry from recursively compacting forever while keeping
 * failure state isolated from other turns and sessions.
 */
export class ContextRecoveryGuard {
  private reactiveAttempts = 0;
  private consecutiveCompactionFailures = 0;
  private circuitOpen = false;
  private readonly attemptedModulesSet = new Set<string>();

  constructor(
    private readonly maxReactiveAttempts = 1,
    private readonly maxConsecutiveCompactionFailures = 3,
  ) {
    if (!Number.isInteger(maxReactiveAttempts) || maxReactiveAttempts < 1) throw new Error("maxReactiveAttempts must be a positive integer");
    if (!Number.isInteger(maxConsecutiveCompactionFailures) || maxConsecutiveCompactionFailures < 1) throw new Error("maxConsecutiveCompactionFailures must be a positive integer");
  }

  canAttemptReactive(): boolean {
    return !this.circuitOpen && this.reactiveAttempts < this.maxReactiveAttempts;
  }

  beginReactive(module = "reactive_compact"): number | undefined {
    if (!this.canAttemptReactive()) return undefined;
    this.reactiveAttempts += 1;
    this.attemptedModulesSet.add(module);
    return this.reactiveAttempts;
  }

  recordCompactionSuccess(module = "compact"): void {
    this.consecutiveCompactionFailures = 0;
    this.circuitOpen = false;
    this.attemptedModulesSet.add(module);
  }

  recordCompactionFailure(module = "compact"): boolean {
    this.consecutiveCompactionFailures += 1;
    this.attemptedModulesSet.add(module);
    if (this.consecutiveCompactionFailures >= this.maxConsecutiveCompactionFailures) this.circuitOpen = true;
    return this.circuitOpen;
  }

  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  snapshot(): RecoveryGuardSnapshot {
    return {
      reactiveAttempts: this.reactiveAttempts,
      consecutiveCompactionFailures: this.consecutiveCompactionFailures,
      circuitOpen: this.circuitOpen,
      attemptedModules: [...this.attemptedModulesSet].sort(),
    };
  }
}

/** Creates a stable, non-secret fingerprint for the exact model-visible request. */
export function fingerprintModelRequest(request: ModelRequest | { readonly messages: readonly ChatMessage[]; readonly tools?: ModelRequest["tools"] }): string {
  const normalized = {
    messages: request.messages.map((message) => normalizeMessage(message)),
    tools: (request.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    toolChoice: "toolChoice" in request ? request.toolChoice : undefined,
    reasoningEffort: "reasoningEffort" in request ? request.reasoningEffort : undefined,
    purpose: "purpose" in request ? request.purpose : undefined,
  };
  const digest = createHash("sha256").update(stableSerialize(normalized)).digest("hex");
  return `ctxreq_${digest.slice(0, 16)}`;
}

/** Classifies provider errors without relying on a provider-specific SDK. */
export function classifyProviderContextError(error: unknown): ProviderContextError {
  const record = asRecord(error);
  const nestedResponse = asRecord(record?.["response"]);
  const status = firstInteger(record?.["status"], record?.["statusCode"], record?.["httpStatus"], nestedResponse?.["status"]);
  const code = firstString(record?.["code"], record?.["failureCode"], record?.["errorCode"]);
  const providerCode = firstString(record?.["providerCode"], asRecord(record?.["error"])?.["code"]);
  const message = boundedMessage(error);
  const haystack = `${code ?? ""} ${providerCode ?? ""} ${message}`.toLowerCase();
  const media = /(?:image|media|mime|document|pdf|vision|attachment|payload\s+too\s+large)/u.test(haystack);
  const promptTooLong = status === 413 || /(?:prompt\s*(?:is\s*)?too\s*long|context(?:\s+window|\s+length)?\s*(?:exceeded|too\s*large|limit)|context[_ -]window[_ -]exceeded|maximum\s+context|too\s+many\s+tokens|context_length_exceeded|request\s+too\s+large)/u.test(haystack);
  const toolPairing = /(?:tool(?:_call)?|tool_use|tool_result).*(?:pair|match|orphan|missing|invalid)|(?:pair|match).*(?:tool(?:_call)?|tool_use|tool_result)/u.test(haystack);
  const schema = /(?:schema|validation|invalid\s+(?:request|message|parameter)|malformed)/u.test(haystack);
  const errorClass: ContextRecoveryErrorClass = media && promptTooLong
    ? "media_too_large"
    : promptTooLong
      ? "prompt_too_long"
      : toolPairing
        ? "tool_pairing"
        : schema
          ? "schema"
          : "other";
  return {
    errorClass,
    message,
    ...(code === undefined ? {} : { code }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(status === undefined ? {} : { status }),
  };
}

export function isReactiveContextError(error: unknown): boolean {
  const classified = classifyProviderContextError(error);
  return classified.errorClass === "prompt_too_long" || classified.errorClass === "media_too_large";
}

function normalizeMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") return { role: message.role, toolCallId: message.toolCallId, content: message.content };
  if (message.role === "assistant") return { role: message.role, content: message.content, toolCalls: message.toolCalls ?? [] };
  return { role: message.role, content: message.content };
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function firstInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
}

function boundedMessage(error: unknown): string {
  const record = asRecord(error);
  const message = error instanceof Error ? error.message : firstString(record?.["message"], record?.["error"], error);
  return String(message ?? "Unknown provider error").slice(0, 500);
}
