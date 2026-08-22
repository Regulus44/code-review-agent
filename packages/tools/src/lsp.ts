import type { ToolResult } from "@code-review-agent/contracts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WorkspaceResolver } from "@code-review-agent/workspace";

export interface LspServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly languageIds?: Readonly<Record<string, string>>;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ServerState {
  readonly key: string;
  readonly config: LspServerConfig;
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<number, PendingRequest>;
  buffer: Buffer;
  nextId: number;
  initialized: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Minimal read-only JSON-RPC LSP client. Server commands are configured by the host, never supplied by a tool call. */
export class LspManager {
  private readonly servers = new Map<string, ServerState>();

  constructor(private readonly configs: Readonly<Record<string, LspServerConfig>> = {}) {}

  async diagnostics(input: { readonly serverId?: string; readonly path: string }, workspaceRoot: string, signal: AbortSignal): Promise<ToolResult> {
    return this.request("textDocument/diagnostic", input.serverId, input.path, undefined, workspaceRoot, signal);
  }

  async definition(input: { readonly serverId?: string; readonly path: string; readonly line: number; readonly character: number }, workspaceRoot: string, signal: AbortSignal): Promise<ToolResult> {
    return this.request("textDocument/definition", input.serverId, input.path, { line: input.line, character: input.character }, workspaceRoot, signal);
  }

  async references(input: { readonly serverId?: string; readonly path: string; readonly line: number; readonly character: number; readonly includeDeclaration?: boolean }, workspaceRoot: string, signal: AbortSignal): Promise<ToolResult> {
    return this.request("textDocument/references", input.serverId, input.path, { line: input.line, character: input.character }, workspaceRoot, signal, { includeDeclaration: input.includeDeclaration ?? true });
  }

  async close(): Promise<void> {
    for (const state of this.servers.values()) state.child.kill();
    this.servers.clear();
  }

  private async request(method: string, serverId = "default", relativePath: string, position: { readonly line: number; readonly character: number } | undefined, workspaceRoot: string, signal: AbortSignal, context: Record<string, unknown> = {}): Promise<ToolResult> {
    const resolver = new WorkspaceResolver(workspaceRoot);
    let target: string;
    try { target = await resolver.resolveExisting(relativePath); } catch { return fail("LSP_PATH_INVALID", `LSP target is outside or missing from the workspace: ${relativePath}`); }
    try { if (!(await stat(target)).isFile()) return fail("LSP_PATH_INVALID", `LSP target is not a file: ${relativePath}`); } catch { return fail("LSP_PATH_INVALID", `LSP target is not readable: ${relativePath}`); }
    const config = this.configs[serverId];
    if (config === undefined) return fail("LSP_UNAVAILABLE", `No configured read-only LSP server named '${serverId}'.`);
    const state = await this.ensureServer(serverId, config, workspaceRoot, signal);
    const content = await readFile(target, "utf8");
    const uri = `file://${target.replaceAll(path.sep, "/")}`;
    await this.notify(state, "textDocument/didOpen", { textDocument: { uri, languageId: languageId(relativePath, config), version: 1, text: content } }, signal);
    const params = method === "textDocument/diagnostic"
      ? { textDocument: { uri }, identifier: serverId }
      : { textDocument: { uri }, position, context };
    try {
      const result = await this.call(state, method, params, signal);
      return { ok: true, output: { serverId, method, path: relativePath, result }, presentation: { kind: "tool", title: `LSP ${method}`, data: { serverId, path: relativePath, result } } };
    } catch (error) {
      return fail(error instanceof Error && error.message.startsWith("LSP_TIMEOUT") ? "LSP_TIMEOUT" : "LSP_PROTOCOL_ERROR", error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureServer(serverId: string, config: LspServerConfig, workspaceRoot: string, signal: AbortSignal): Promise<ServerState> {
    const existing = this.servers.get(serverId);
    if (existing !== undefined && existing.child.exitCode === null) return existing;
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(config.command, [...(config.args ?? [])], { cwd: workspaceRoot, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { throw new Error(`LSP_SERVER_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`); }
    const state: ServerState = { key: serverId, config, child, pending: new Map(), buffer: Buffer.alloc(0), nextId: 1, initialized: false };
    this.servers.set(serverId, state);
    child.stdout.on("data", (chunk: Buffer) => this.consume(state, chunk));
    child.once("error", (error) => this.failPending(state, new Error(`LSP_SERVER_UNAVAILABLE: ${error.message}`)));
    child.once("close", () => this.failPending(state, new Error("LSP_SERVER_CLOSED: server exited")));
    if (!state.initialized) {
      await this.call(state, "initialize", { processId: process.pid, rootUri: `file://${workspaceRoot.replaceAll(path.sep, "/")}`, capabilities: { textDocument: { synchronization: { dynamicRegistration: false }, diagnostic: { dynamicRegistration: false } } }, workspaceFolders: [{ uri: `file://${workspaceRoot.replaceAll(path.sep, "/")}`, name: path.basename(workspaceRoot) }] }, signal);
      await this.notify(state, "initialized", {}, signal);
      state.initialized = true;
    }
    return state;
  }

  private call(state: ServerState, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const id = state.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.pending.delete(id); reject(new Error(`LSP_TIMEOUT: ${method}`)); }, DEFAULT_TIMEOUT_MS);
      timer.unref();
      const pending: PendingRequest = { resolve, reject, timer };
      state.pending.set(id, pending);
      const abort = () => { clearTimeout(timer); state.pending.delete(id); reject(new Error("LSP_CANCELLED")); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      try { state.child.stdin.write(frame(payload)); } catch (error) { clearTimeout(timer); state.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private async notify(state: ServerState, method: string, params: unknown, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("LSP_CANCELLED");
    state.child.stdin.write(frame(JSON.stringify({ jsonrpc: "2.0", method, params })));
  }

  private consume(state: ServerState, chunk: Buffer): void {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (true) {
      const separator = state.buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = state.buffer.subarray(0, separator).toString("ascii");
      const match = /Content-Length:\s*(\d+)/iu.exec(header);
      if (match === null) { state.buffer = state.buffer.subarray(separator + 4); continue; }
      const length = Number(match[1]);
      const start = separator + 4;
      if (state.buffer.length < start + length) return;
      const body = state.buffer.subarray(start, start + length).toString("utf8");
      state.buffer = state.buffer.subarray(start + length);
      let message: Record<string, unknown>;
      try { message = JSON.parse(body) as Record<string, unknown>; } catch { continue; }
      const id = message["id"];
      if (typeof id !== "number") continue;
      const pending = state.pending.get(id);
      if (pending === undefined) continue;
      state.pending.delete(id); clearTimeout(pending.timer);
      if (message["error"] !== undefined) pending.reject(new Error(`LSP_SERVER_ERROR: ${JSON.stringify(message["error"])}`)); else pending.resolve(message["result"]);
    }
  }

  private failPending(state: ServerState, error: Error): void {
    for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    state.pending.clear();
  }
}

function frame(payload: string): string { return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`; }
function languageId(relativePath: string, config: LspServerConfig): string { return config.languageIds?.[path.extname(relativePath).toLowerCase()] ?? (path.extname(relativePath).slice(1) || "plaintext"); }
function fail(code: string, message: string): ToolResult { return { ok: false, error: { code, message, remedy: code === "LSP_UNAVAILABLE" ? "Configure an approved read-only LSP server for this workspace." : "Inspect the LSP server state and retry only after the target/server is valid." }, presentation: { kind: "tool", title: code, text: message } }; }
