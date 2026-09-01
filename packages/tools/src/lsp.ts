import type { ToolResult } from "@coding-agent/contracts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WorkspaceResolver } from "@coding-agent/workspace";

export interface LspServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly languageIds?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxMessageBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxDocumentBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface LspEventContext {
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly appendEvent?: (type: "lsp/server" | "lsp/request", payload: Readonly<Record<string, unknown>>) => Promise<void>;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly method: string;
  readonly hooks?: LspEventContext;
  readonly relativePath?: string;
}

interface ServerState {
  readonly key: string;
  readonly serverId: string;
  readonly workspaceRoot: string;
  readonly config: LspServerConfig;
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<number, PendingRequest>;
  readonly hooks?: LspEventContext;
  buffer: Buffer;
  nextId: number;
  closed: boolean;
  disposing: boolean;
  stderrBytes: number;
  stderrTail: string;
}

class LspFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

/** Read-only JSON-RPC LSP client with bounded transport, lifecycle events, cancellation, and restart recovery. */
export class LspManager {
  private readonly servers = new Map<string, ServerState>();
  private readonly starting = new Map<string, Promise<ServerState>>();

  constructor(private readonly configs: Readonly<Record<string, LspServerConfig>> = {}) {}

  async diagnostics(input: { readonly serverId?: string; readonly path: string }, workspaceRoot: string, signal: AbortSignal, hooks?: LspEventContext): Promise<ToolResult> {
    return this.request("textDocument/diagnostic", input.serverId, input.path, undefined, workspaceRoot, signal, hooks);
  }

  async definition(input: { readonly serverId?: string; readonly path: string; readonly line: number; readonly character: number }, workspaceRoot: string, signal: AbortSignal, hooks?: LspEventContext): Promise<ToolResult> {
    return this.request("textDocument/definition", input.serverId, input.path, { line: input.line, character: input.character }, workspaceRoot, signal, hooks);
  }

  async references(input: { readonly serverId?: string; readonly path: string; readonly line: number; readonly character: number; readonly includeDeclaration?: boolean }, workspaceRoot: string, signal: AbortSignal, hooks?: LspEventContext): Promise<ToolResult> {
    return this.request("textDocument/references", input.serverId, input.path, { line: input.line, character: input.character }, workspaceRoot, signal, hooks, { includeDeclaration: input.includeDeclaration ?? true });
  }

  async close(): Promise<void> {
    const states = [...this.servers.values()];
    for (const state of states) await this.disposeState(state, new LspFailure("LSP_DISPOSED", "LSP manager was closed"));
  }

  private async request(method: string, serverId = "default", relativePath: string, position: { readonly line: number; readonly character: number } | undefined, workspaceRoot: string, signal: AbortSignal, hooks?: LspEventContext, context: Record<string, unknown> = {}): Promise<ToolResult> {
    const resolver = new WorkspaceResolver(workspaceRoot);
    let target: string;
    try { target = await resolver.resolveExisting(relativePath); } catch { return fail("LSP_PATH_INVALID", `LSP target is outside or missing from the workspace: ${relativePath}`); }
    let info;
    try { info = await stat(target); } catch { return fail("LSP_PATH_INVALID", `LSP target is not readable: ${relativePath}`); }
    if (!info.isFile()) return fail("LSP_PATH_INVALID", `LSP target is not a file: ${relativePath}`);
    const config = this.configs[serverId];
    if (config === undefined) return fail("LSP_UNAVAILABLE", `No configured read-only LSP server named '${serverId}'.`);
    const maxDocumentBytes = config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    if (info.size > maxDocumentBytes) return fail("LSP_DOCUMENT_TOO_LARGE", `LSP document exceeds ${maxDocumentBytes} bytes: ${relativePath}`);
    const content = await readFile(target, "utf8");
    const uri = pathToUri(target);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) return fail("LSP_CANCELLED", "LSP request was cancelled");
      try {
        const state = await this.ensureServer(serverId, config, workspaceRoot, signal, hooks);
        await this.notify(state, "textDocument/didOpen", { textDocument: { uri, languageId: languageId(relativePath, config), version: 1, text: content } }, signal);
        const params = method === "textDocument/diagnostic"
          ? { textDocument: { uri }, identifier: serverId }
          : { textDocument: { uri }, position, context };
        const result = await this.call(state, method, params, signal, hooks, relativePath);
        return { ok: true, output: { serverId, method, path: relativePath, result }, presentation: { kind: "tool", title: `LSP ${method}`, data: { serverId, path: relativePath, result } } };
      } catch (error) {
        lastError = error;
        if (errorCode(error) === "LSP_SERVER_CRASHED" && attempt === 0 && !signal.aborted) {
          await this.emit(hooks, "lsp/server", { action: "restart_requested", serverId, workspaceRoot, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        break;
      }
    }
    const code = errorCode(lastError) ?? "LSP_PROTOCOL_ERROR";
    return fail(code, lastError instanceof Error ? lastError.message : String(lastError));
  }

  private async ensureServer(serverId: string, config: LspServerConfig, workspaceRoot: string, signal: AbortSignal, hooks?: LspEventContext): Promise<ServerState> {
    const key = serverKey(serverId, workspaceRoot);
    const existing = this.servers.get(key);
    if (existing !== undefined && !existing.closed) return existing;
    const inFlight = this.starting.get(key);
    if (inFlight !== undefined) return inFlight;
    const start = this.startServer(key, serverId, config, workspaceRoot, signal, hooks);
    this.starting.set(key, start);
    try { return await start; } finally { if (this.starting.get(key) === start) this.starting.delete(key); }
  }

  private async startServer(key: string, serverId: string, config: LspServerConfig, workspaceRoot: string, signal: AbortSignal, hooks?: LspEventContext): Promise<ServerState> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.command, [...(config.args ?? [])], { cwd: workspaceRoot, env: { ...process.env, ...(config.env ?? {}) }, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      throw new LspFailure("LSP_SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }
    const state: ServerState = { key, serverId, workspaceRoot, config, child, pending: new Map(), ...(hooks === undefined ? {} : { hooks }), buffer: Buffer.alloc(0), nextId: 1, closed: false, disposing: false, stderrBytes: 0, stderrTail: "" };
    this.servers.set(key, state);
    child.stdout.on("data", (chunk: Buffer) => this.consume(state, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.consumeStderr(state, chunk));
    child.once("error", (error) => this.failState(state, new LspFailure("LSP_SERVER_CRASHED", `LSP server error: ${error.message}`)));
    child.once("close", (code, signalName) => this.failState(state, new LspFailure(state.disposing ? "LSP_DISPOSED" : "LSP_SERVER_CRASHED", `LSP server exited${code === null ? "" : ` with code ${code}`}${signalName === null ? "" : ` (${signalName})`}`)));
    await this.emit(hooks, "lsp/server", { action: "started", serverId, workspaceRoot });
    try {
      await this.call(state, "initialize", { processId: process.pid, rootUri: pathToUri(workspaceRoot), capabilities: { textDocument: { synchronization: { dynamicRegistration: false }, diagnostic: { dynamicRegistration: false } } }, workspaceFolders: [{ uri: pathToUri(workspaceRoot), name: path.basename(workspaceRoot) }], initializationOptions: null }, signal, hooks);
      await this.notify(state, "initialized", {}, signal);
      await this.emit(hooks, "lsp/server", { action: "initialized", serverId, workspaceRoot });
      return state;
    } catch (error) {
      await this.disposeState(state, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private call(state: ServerState, method: string, params: unknown, signal: AbortSignal, hooks?: LspEventContext, relativePath?: string): Promise<unknown> {
    if (state.closed || state.child.stdin.destroyed) return Promise.reject(new LspFailure("LSP_SERVER_CRASHED", "LSP transport is closed"));
    const id = state.nextId++;
    const timeoutMs = Math.min(Math.max(state.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, 1), 120_000);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    void this.emit(hooks, "lsp/request", { action: "started", requestId: id, method, serverId: state.serverId, workspaceRoot: state.workspaceRoot, ...(relativePath === undefined ? {} : { path: relativePath }), ...(hooks?.toolCallId === undefined ? {} : { toolCallId: hooks.toolCallId }) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.sendCancel(state, id); this.settlePending(state, id, new LspFailure("LSP_TIMEOUT", `LSP request timed out: ${method}`)); }, timeoutMs);
      timer.unref();
      const abort = (): void => { this.sendCancel(state, id); this.settlePending(state, id, new LspFailure("LSP_CANCELLED", `LSP request cancelled: ${method}`)); };
      const pending: PendingRequest = { resolve, reject, timer, signal, abort, method, ...(hooks === undefined ? {} : { hooks }), ...(relativePath === undefined ? {} : { relativePath }) };
      state.pending.set(id, pending);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      try { state.child.stdin.write(frame(payload)); } catch (error) { this.settlePending(state, id, new LspFailure("LSP_TRANSPORT_ERROR", error instanceof Error ? error.message : String(error))); }
    });
  }

  private async notify(state: ServerState, method: string, params: unknown, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new LspFailure("LSP_CANCELLED", `LSP notification cancelled: ${method}`);
    if (state.closed || state.child.stdin.destroyed) throw new LspFailure("LSP_SERVER_CRASHED", "LSP transport is closed");
    try { state.child.stdin.write(frame(JSON.stringify({ jsonrpc: "2.0", method, params }))); }
    catch (error) { throw new LspFailure("LSP_TRANSPORT_ERROR", error instanceof Error ? error.message : String(error)); }
  }

  private sendCancel(state: ServerState, id: number): void {
    if (state.closed || state.child.stdin.destroyed) return;
    try { state.child.stdin.write(frame(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }))); } catch { /* lifecycle handler reports the transport failure */ }
  }

  private consume(state: ServerState, chunk: Buffer): void {
    if (state.closed) return;
    state.buffer = Buffer.concat([state.buffer, chunk]);
    const maxMessageBytes = state.config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (state.buffer.length > maxMessageBytes + MAX_HEADER_BYTES) { this.failState(state, new LspFailure("LSP_OUTPUT_TRUNCATED", `LSP transport buffer exceeded ${maxMessageBytes} bytes`)); return; }
    while (true) {
      const separator = state.buffer.indexOf("\r\n\r\n");
      if (separator < 0) { if (state.buffer.length > MAX_HEADER_BYTES) this.failState(state, new LspFailure("LSP_PROTOCOL_ERROR", "LSP header exceeded the bounded transport limit")); return; }
      if (separator > MAX_HEADER_BYTES) { this.failState(state, new LspFailure("LSP_PROTOCOL_ERROR", "LSP header exceeded the bounded transport limit")); return; }
      const header = state.buffer.subarray(0, separator).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/iu.exec(header);
      if (match === null) { this.failState(state, new LspFailure("LSP_PROTOCOL_ERROR", "LSP response is missing Content-Length")); return; }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > maxMessageBytes) { this.failState(state, new LspFailure("LSP_OUTPUT_TRUNCATED", `LSP message length ${length} exceeds ${maxMessageBytes} bytes`)); return; }
      const start = separator + 4;
      if (state.buffer.length < start + length) return;
      const body = state.buffer.subarray(start, start + length).toString("utf8");
      state.buffer = state.buffer.subarray(start + length);
      let message: Record<string, unknown>;
      try { message = JSON.parse(body) as Record<string, unknown>; }
      catch (error) { this.failState(state, new LspFailure("LSP_PROTOCOL_ERROR", `LSP response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`)); return; }
      const id = message["id"];
      if (typeof id !== "number") continue;
      const pending = state.pending.get(id);
      if (pending === undefined) continue;
      if (message["error"] !== undefined) this.settlePending(state, id, new LspFailure("LSP_SERVER_ERROR", JSON.stringify(message["error"])));
      else this.settlePending(state, id, undefined, message["result"]);
    }
  }

  private consumeStderr(state: ServerState, chunk: Buffer): void {
    state.stderrBytes += chunk.byteLength;
    const max = state.config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    state.stderrTail = Buffer.concat([Buffer.from(state.stderrTail, "utf8"), chunk]).subarray(-max).toString("utf8");
  }

  private settlePending(state: ServerState, id: number, error?: Error, value?: unknown): void {
    const pending = state.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    state.pending.delete(id);
    const code = error === undefined ? undefined : errorCode(error) ?? "LSP_PROTOCOL_ERROR";
    const action = error === undefined ? "completed" : code === "LSP_CANCELLED" ? "cancelled" : code === "LSP_TIMEOUT" ? "timeout" : "failed";
    void this.emit(pending.hooks, "lsp/request", { action, requestId: id, method: pending.method, serverId: state.serverId, workspaceRoot: state.workspaceRoot, ...(pending.relativePath === undefined ? {} : { path: pending.relativePath }), ...(pending.hooks?.toolCallId === undefined ? {} : { toolCallId: pending.hooks.toolCallId }), ...(code === undefined ? {} : { code }) });
    if (error === undefined) pending.resolve(value); else pending.reject(error);
  }

  private failState(state: ServerState, error: Error): void {
    if (state.closed) return;
    state.closed = true;
    if (this.servers.get(state.key) === state) this.servers.delete(state.key);
    for (const id of [...state.pending.keys()]) this.settlePending(state, id, error);
    void this.emit(state.hooks, "lsp/server", { action: state.disposing ? "disposed" : "crashed", serverId: state.serverId, workspaceRoot: state.workspaceRoot, code: errorCode(error) ?? "LSP_SERVER_CRASHED", stderrBytes: state.stderrBytes });
  }

  private async disposeState(state: ServerState, error: Error): Promise<void> {
    if (state.disposing && state.closed) return;
    state.disposing = true;
    this.failState(state, error);
    if (state.child.exitCode !== null || state.child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => state.child.once("close", () => resolve()));
    try { state.child.kill(); } catch { /* process may already have exited */ }
    await Promise.race([closed, new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); timer.unref(); })]);
  }

  private async emit(hooks: LspEventContext | undefined, type: "lsp/server" | "lsp/request", payload: Readonly<Record<string, unknown>>): Promise<void> {
    if (hooks?.appendEvent === undefined) return;
    await hooks.appendEvent(type, payload);
  }
}

function serverKey(serverId: string, workspaceRoot: string): string { return `${serverId}\u0000${path.resolve(workspaceRoot)}`; }
function pathToUri(value: string): string { return encodeURI(`file://${value.replaceAll(path.sep, "/")}`); }
function frame(payload: string): string { return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`; }
function languageId(relativePath: string, config: LspServerConfig): string { return config.languageIds?.[path.extname(relativePath).toLowerCase()] ?? (path.extname(relativePath).slice(1) || "plaintext"); }
function errorCode(error: unknown): string | undefined { return error instanceof LspFailure ? error.code : error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined; }
function fail(code: string, message: string): ToolResult {
  const remedy = code === "LSP_UNAVAILABLE" ? "Configure an approved read-only LSP server for this workspace." : code === "LSP_CANCELLED" ? "Inspect partial progress and continue without assuming the request completed." : code === "LSP_SERVER_CRASHED" ? "Retry once after the host replaces the crashed transport; if it repeats, inspect the server configuration." : code === "LSP_DOCUMENT_TOO_LARGE" || code === "LSP_OUTPUT_TRUNCATED" ? "Narrow the document/query or raise the host-configured bound only through trusted configuration." : "Inspect the structured LSP error and retry only after the path, server, or protocol issue is understood.";
  return { ok: false, error: { code, message, remedy }, presentation: { kind: "tool", title: code, text: message } };
}
