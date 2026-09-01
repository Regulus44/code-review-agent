import type { ChatModel, ModelContextCapability, ModelRequest, ModelStreamPart } from "@coding-agent/contracts";
import { AnthropicMessagesError, anthropicHttpError } from "./errors.js";
import { parseRetryAfter, retryDelayMs } from "../../failures.js";
import { serializeAnthropicRequest } from "./serialize.js";
import { AnthropicStreamState, parseSseFrames } from "./stream.js";
import { ANTHROPIC_MESSAGES_DEFAULT_MAX_OUTPUT_TOKENS, ANTHROPIC_MESSAGES_MAX_OUTPUT_TOKENS, type AnthropicMessagesOptions } from "./types.js";

const DEFAULT_API_VERSION = "2023-06-01";
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** Native Anthropic Messages adapter with provider-neutral ModelStreamPart output. */
export class AnthropicMessagesChatModel implements ChatModel {
  readonly contextCapability?: ModelContextCapability;
  private readonly endpoint: string;
  private readonly maxOutputTokens: number;
  private readonly apiVersion: string;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: AnthropicMessagesOptions) {
    this.endpoint = messagesEndpoint(options.baseUrl);
    const capabilityMax = options.contextCapability?.maxOutputTokens;
    if (capabilityMax !== undefined) validateCapabilityLimit(capabilityMax, "contextCapability.maxOutputTokens");
    const capabilityDefault = options.contextCapability?.defaultMaxOutputTokens;
    if (capabilityDefault !== undefined) validateCapabilityLimit(capabilityDefault, "contextCapability.defaultMaxOutputTokens");
    if (capabilityMax !== undefined && capabilityDefault !== undefined && capabilityDefault > capabilityMax) {
      throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", "contextCapability.defaultMaxOutputTokens must not exceed contextCapability.maxOutputTokens");
    }
    const requestedMax = options.maxOutputTokens ?? capabilityDefault ?? ANTHROPIC_MESSAGES_DEFAULT_MAX_OUTPUT_TOKENS;
    this.maxOutputTokens = positiveInteger(requestedMax, ANTHROPIC_MESSAGES_DEFAULT_MAX_OUTPUT_TOKENS, "maxOutputTokens");
    if (this.maxOutputTokens > ANTHROPIC_MESSAGES_MAX_OUTPUT_TOKENS) {
      throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", `maxOutputTokens must not exceed ${ANTHROPIC_MESSAGES_MAX_OUTPUT_TOKENS}`);
    }
    if (capabilityMax !== undefined && this.maxOutputTokens > capabilityMax) {
      throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", "maxOutputTokens must not exceed contextCapability.maxOutputTokens");
    }
    this.apiVersion = options.apiVersion?.trim() || DEFAULT_API_VERSION;
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, "idleTimeoutMs");
    if (options.contextCapability !== undefined) this.contextCapability = options.contextCapability;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new AnthropicMessagesError("ANTHROPIC_FETCH_UNAVAILABLE", "Fetch API is unavailable in this runtime");
    const watchdog = createIdleWatchdog(request.signal, this.idleTimeoutMs);
    let emittedOutput = false;
    try {
      const response = await fetchWithRetry(fetchImpl, this.endpoint, {
        method: "POST",
        headers: requestHeaders(this.options, this.apiVersion),
        body: JSON.stringify(serializeAnthropicRequest(request, this.options.model, this.maxOutputTokens)),
        signal: watchdog.signal,
      }, request.purpose === "context_summary" ? 1 : 2, watchdog.signal);
      if (!response.ok) {
        const detail = await providerErrorDetail(response);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
        throw anthropicHttpError(response.status, detail.providerCode, detail.message, {
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(requestId === undefined ? {} : { requestId }),
        });
      }
      if (response.body === null) throw new AnthropicMessagesError("ANTHROPIC_STREAM_CLOSED", "Anthropic Messages response did not contain a stream body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const state = new AnthropicStreamState();
      let remainder = "";
      while (true) {
        watchdog.touch();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await readChunk(reader, watchdog.signal);
        } catch (error) {
          throw watchdog.error(error);
        }
        watchdog.touch();
        remainder += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const parsed = parseSseFrames(remainder);
        remainder = parsed.remainder;
        for (const event of parsed.frames) {
          for (const part of state.consume(event)) {
            if (part.type === "text_delta" || part.type === "tool_call_start" || part.type === "tool_call_delta") emittedOutput = true;
            yield part;
          }
        }
        if (chunk.done) break;
      }
      if (remainder.trim().length > 0) {
        const parsed = parseSseFrames(`${remainder}\n\n`);
        for (const event of parsed.frames) {
          for (const part of state.consume(event)) {
            if (part.type === "text_delta" || part.type === "tool_call_start" || part.type === "tool_call_delta") emittedOutput = true;
            yield part;
          }
        }
      }
      if (!state.isTerminal()) throw new AnthropicMessagesError("ANTHROPIC_STREAM_CLOSED", "Anthropic Messages stream closed before message_stop");
    } catch (error) {
      const normalized = watchdog.error(error);
      if (normalized instanceof AnthropicMessagesError) {
        if (emittedOutput && normalized.partialOutput !== true) throw new AnthropicMessagesError(normalized.code, normalized.message, {
          ...(normalized.status === undefined ? {} : { status: normalized.status }),
          ...(normalized.providerCode === undefined ? {} : { providerCode: normalized.providerCode }),
          failureCode: normalized.failureCode,
          retryable: normalized.retryable,
          ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
          ...(normalized.requestId === undefined ? {} : { requestId: normalized.requestId }),
          partialOutput: true,
        });
        throw normalized;
      }
      if (request.signal?.aborted) throw new AnthropicMessagesError("ANTHROPIC_ABORTED", "Anthropic Messages request was cancelled", { failureCode: "ABORTED", retryable: false, partialOutput: emittedOutput });
      throw new AnthropicMessagesError("ANTHROPIC_NETWORK_ERROR", "Anthropic Messages request failed before completion", { failureCode: "NETWORK", retryable: true, partialOutput: emittedOutput });
    } finally {
      watchdog.dispose();
    }
  }
}

async function fetchWithRetry(
  fetchImpl: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  maxAttempts: number,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      if (attempt < maxAttempts && (response.status === 429 || response.status === 529 || response.status >= 500)) {
        await waitForRetry(retryDelayMs(attempt, parseRetryAfter(response.headers.get("retry-after"))), signal);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (signal.aborted || attempt === maxAttempts) throw error;
      await waitForRetry(retryDelayMs(attempt), signal);
    }
  }
  throw lastError ?? new Error("Unknown network failure");
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("Request cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Request cancelled")); }, { once: true });
  });
}

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled"));
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function requestHeaders(options: AnthropicMessagesOptions, apiVersion: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  for (const [key, value] of Object.entries(options.headers ?? {})) headers[key.toLowerCase()] = value;
  if (headers["anthropic-version"] === undefined) headers["anthropic-version"] = apiVersion;
  if (options.apiKey !== undefined && headers["x-api-key"] === undefined && headers.authorization === undefined) headers["x-api-key"] = options.apiKey;
  return headers;
}

function messagesEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", "ANTHROPIC_BASE_URL must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", "ANTHROPIC_BASE_URL must be an http(s) URL");
  if (url.username !== "" || url.password !== "") throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", "ANTHROPIC_BASE_URL must not contain credentials");
  if (url.search !== "" || url.hash !== "") throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", "ANTHROPIC_BASE_URL must not contain query or fragment data");
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname.endsWith("/messages")) return url.toString();
  url.pathname = pathname.endsWith("/v1") ? `${pathname}/messages` : `${pathname}/v1/messages`;
  return url.toString();
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", `${field} must be a positive integer`);
  return value;
}

function validateCapabilityLimit(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AnthropicMessagesError("ANTHROPIC_CONFIGURATION_ERROR", `${field} must be a positive integer`);
  }
}

async function providerErrorDetail(response: Response): Promise<{ readonly message?: string; readonly providerCode?: string }> {
  try {
    const raw = await response.text();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...(raw.trim().length === 0 ? {} : { message: raw.slice(0, 300) }) };
    const root = parsed as Record<string, unknown>;
    const nested = typeof root.error === "object" && root.error !== null ? root.error as Record<string, unknown> : root;
    return {
      ...(typeof nested.message === "string" ? { message: nested.message.slice(0, 300) } : {}),
      ...(typeof nested.type === "string" ? { providerCode: nested.type.slice(0, 120) } : {}),
    };
  } catch {
    return {};
  }
}

function createIdleWatchdog(parent: AbortSignal | undefined, idleTimeoutMs: number): {
  readonly signal: AbortSignal;
  touch(): void;
  error(error: unknown): unknown;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort(parent?.reason ?? new Error("Request cancelled"));
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new AnthropicMessagesError("ANTHROPIC_IDLE_TIMEOUT", `Anthropic Messages stream was idle for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
    timer.unref?.();
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    error: (error) => {
      if (timedOut) return new AnthropicMessagesError("ANTHROPIC_IDLE_TIMEOUT", `Anthropic Messages stream was idle for ${idleTimeoutMs}ms`);
      if (parent?.aborted) return parent.reason ?? error;
      return error;
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}
