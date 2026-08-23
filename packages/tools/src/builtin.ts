import type {
  ToolDefinition,
  ToolContext,
  EventStore,
  ToolResult,
  TodoItem,
  TodoStatus,
} from "@code-review-agent/contracts";
import { readFile, writeFile, readdir, stat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceResolver } from "@code-review-agent/workspace";
import { JobManager } from "./jobs.js";
import { readWorkspaceImage } from "./image.js";
import { LspManager, type LspServerConfig } from "./lsp.js";
import type { CodeModeSandbox } from "./code-mode.js";
import { CapabilityRegistry, CapabilityError } from "./capabilities.js";
import { applyPreview, loadPatchRecord, PatchConflictError, PatchParseError, persistPatchRecord, previewUnifiedPatch, removePatchRecord, type AppliedPatch } from "./patch.js";

const ALLOWED_EXECUTABLES = new Set(["git", "node", "npm", "pnpm", "vitest"]);
const MAX_PROCESS_OUTPUT_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1 * 1024 * 1024;
const DEFAULT_GLOB_RESULTS = 1_000;
const DEFAULT_TERMINAL_READ_BYTES = 64 * 1024;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 1_000;
const MAX_READ_LINE_CHARS = 2_000;
const MAX_READ_RESULT_BYTES = 50 * 1024;

const object = (properties: Record<string, any>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const string = { type: "string" as const };
const boolean = { type: "boolean" as const };
const integer = (minimum: number, maximum: number) => ({ type: "integer" as const, minimum, maximum });

export type TerminalStatus = "running" | "exited" | "closed" | "interrupted";

export interface TerminalSummary {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly command: string;
  readonly status: TerminalStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly bufferedBytes: number;
}

interface ManagedTerminal extends Omit<TerminalSummary, "status" | "exitCode" | "signal" | "bufferedBytes"> {
  status: TerminalStatus;
  exitCode: number | undefined;
  signal: string | undefined;
  readonly child: ChildProcessWithoutNullStreams | undefined;
  appendEvent?: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
  output: string;
  readOffset: number;
  totalBytes: number;
}

/** In-process terminal session manager. State is scoped by session/workspace and exposed through tool events. */
export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();

  /** Rebuild terminal metadata from durable events after a host restart. */
  async restore(
    sessionId: string,
    workspaceRoot: string,
    events: readonly { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }[],
    appendEvent: (payload: Readonly<Record<string, unknown>>) => Promise<void>,
  ): Promise<void> {
    const latest = new Map<string, Readonly<Record<string, unknown>>>();
    for (const event of events) {
      if (event.type !== "terminal/session") continue;
      const eventSessionId = event.payload["sessionId"];
      if (eventSessionId !== undefined && eventSessionId !== sessionId) continue;
      const terminalId = event.payload["terminalId"];
      if (typeof terminalId === "string") latest.set(terminalId, event.payload);
    }
    const resolvedRoot = path.resolve(workspaceRoot);
    for (const payload of latest.values()) {
      const terminalId = payload["terminalId"];
      const terminalWorkspace = typeof payload["workspaceRoot"] === "string" ? path.resolve(payload["workspaceRoot"]) : resolvedRoot;
      if (typeof terminalId !== "string" || terminalWorkspace !== resolvedRoot) continue;
      const status = terminalStatus(payload["status"]);
      const terminal: ManagedTerminal = {
        terminalId,
        sessionId,
        workspaceRoot: terminalWorkspace,
        cwd: typeof payload["cwd"] === "string" ? payload["cwd"] : terminalWorkspace,
        command: typeof payload["command"] === "string" ? payload["command"] : "",
        status: status === "running" ? "interrupted" : status,
        exitCode: typeof payload["exitCode"] === "number" ? payload["exitCode"] : undefined,
        signal: typeof payload["signal"] === "string" ? payload["signal"] : undefined,
        child: undefined,
        output: "",
        readOffset: 0,
        totalBytes: typeof payload["bufferedBytes"] === "number" ? payload["bufferedBytes"] : 0,
      };
      this.sessions.set(terminalId, terminal);
      if (status === "running") {
        await appendEvent({
          action: "interrupted",
          terminalId,
          workspaceRoot: terminal.workspaceRoot,
          cwd: terminal.cwd,
          command: terminal.command,
          status: "interrupted",
          bufferedBytes: terminal.totalBytes,
        });
      }
    }
  }

  async open(input: { sessionId: string; workspaceRoot: string; cwd?: string; executable?: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; appendEvent?: (payload: Readonly<Record<string, unknown>>) => Promise<void> }): Promise<ToolResult> {
    const resolver = new WorkspaceResolver(input.workspaceRoot);
    const cwdPath = input.cwd === undefined ? resolver.rootPath : await resolver.resolveExisting(input.cwd);
    if (!(await stat(cwdPath)).isDirectory()) return fail("TERMINAL_CWD_INVALID", "Terminal cwd must be a directory");
    const command = input.executable === undefined ? defaultShell() : input.executable;
    const args = input.executable === undefined ? defaultShellArgs() : [...(input.args ?? [])];
    if (input.executable !== undefined && !isAllowedExecutable(command)) return fail("COMMAND_NOT_ALLOWED", "Terminal executable is not on the allowlist");
    const child = spawn(command, args, {
      cwd: cwdPath,
      detached: true,
      env: { ...process.env, ...(input.env ?? {}) },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const terminalId = `terminal_${randomUUID()}`;
    const terminal: ManagedTerminal = {
      terminalId,
      sessionId: input.sessionId,
      workspaceRoot: resolver.rootPath,
      cwd: cwdPath,
      command: [command, ...args].join(" "),
      status: "running",
      exitCode: undefined,
      signal: undefined,
      child,
      ...(input.appendEvent === undefined ? {} : { appendEvent: input.appendEvent }),
      output: "",
      readOffset: 0,
      totalBytes: 0,
    };
    child.stdout.on("data", (chunk: Buffer) => this.append(terminal, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.append(terminal, chunk));
    child.once("error", (error) => this.append(terminal, Buffer.from(error.message)));
    child.once("close", (exitCode, signal) => {
      terminal.status = "exited";
      terminal.exitCode = exitCode === null ? undefined : exitCode;
      terminal.signal = signal ?? undefined;
      void terminal.appendEvent?.({ ...this.eventPayload(terminal), action: "exited" });
    });
    this.sessions.set(terminalId, terminal);
    await terminal.appendEvent?.({ ...this.eventPayload(terminal), action: "opened" });
    return ok({ terminalId, cwd: cwdPath, command: terminal.command, status: terminal.status });
  }

  send(input: { sessionId: string; terminalId: string; text: string; appendNewline?: boolean }, signal: AbortSignal): ToolResult {
    const terminal = this.get(input.sessionId, input.terminalId);
    if (terminal.status !== "running" || terminal.child === undefined || terminal.child.stdin.destroyed) return fail(terminal.status === "interrupted" ? "TERMINAL_INTERRUPTED" : "TERMINAL_NOT_RUNNING", terminal.status === "interrupted" ? "Terminal process was interrupted by a host restart" : "Terminal is not running");
    if (signal.aborted) return fail("TERMINAL_CANCELLED", "Terminal input was cancelled");
    const text = input.appendNewline === false ? input.text : `${input.text}\n`;
    terminal.child.stdin.write(text);
    return ok({ terminalId: terminal.terminalId, bytesWritten: Buffer.byteLength(text), status: terminal.status });
  }

  async read(input: { sessionId: string; terminalId: string; maxBytes?: number; waitMs?: number }, signal: AbortSignal): Promise<ToolResult> {
    const terminal = this.get(input.sessionId, input.terminalId);
    const maxBytes = Math.min(Math.max(input.maxBytes ?? DEFAULT_TERMINAL_READ_BYTES, 1), MAX_PROCESS_OUTPUT_BYTES);
    const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), 5_000);
    if (waitMs > 0 && terminal.readOffset >= terminal.output.length && terminal.status === "running") await waitForTerminalOutput(terminal, waitMs, signal);
    if (signal.aborted) return fail("TERMINAL_CANCELLED", "Terminal read was cancelled");
    const available = terminal.output.slice(terminal.readOffset);
    const text = available.slice(0, maxBytes);
    terminal.readOffset += text.length;
    return {
      ...ok({ terminalId: terminal.terminalId, output: text, status: terminal.status, exitCode: terminal.exitCode, signal: terminal.signal, hasMore: terminal.readOffset < terminal.output.length }),
      usage: { bytes: Buffer.byteLength(available), truncated: Buffer.byteLength(available) > Buffer.byteLength(text) },
      presentation: { kind: "terminal", title: `Terminal ${terminal.status}`, text },
    };
  }

  async signal(input: { sessionId: string; terminalId: string; signal?: "SIGINT" | "SIGTERM" | "SIGKILL" }): Promise<ToolResult> {
    const terminal = this.get(input.sessionId, input.terminalId);
    if (terminal.status !== "running" || terminal.child === undefined) return ok({ terminalId: terminal.terminalId, status: terminal.status });
    const signal = input.signal ?? "SIGINT";
    if (process.platform === "win32") {
      if (signal === "SIGKILL" || signal === "SIGTERM") terminateProcessTree(terminal.child);
      else terminal.child.kill("SIGINT");
    } else {
      try { process.kill(-(terminal.child.pid ?? 0), signal); } catch { terminal.child.kill(signal); }
    }
    await terminal.appendEvent?.({ ...this.eventPayload(terminal), action: "signalled", signal });
    return ok({ terminalId: terminal.terminalId, status: "signalled", signal });
  }

  async close(input: { sessionId: string; terminalId: string; appendEvent?: (payload: Readonly<Record<string, unknown>>) => Promise<void> }): Promise<ToolResult> {
    const terminal = this.get(input.sessionId, input.terminalId);
    if (input.appendEvent !== undefined) terminal.appendEvent = input.appendEvent;
    if (terminal.status === "running" && terminal.child !== undefined) {
      terminateProcessTree(terminal.child);
      await waitForChildClose(terminal.child, 1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    terminal.status = "closed";
    await terminal.appendEvent?.({ ...this.eventPayload(terminal), action: "closed" });
    return ok({ terminalId: terminal.terminalId, status: terminal.status, outputBytes: terminal.totalBytes });
  }

  async shutdown(): Promise<void> {
    const running = [...this.sessions.values()].filter((terminal) => terminal.status === "running" && terminal.child !== undefined);
    for (const terminal of running) {
      terminateProcessTree(terminal.child as ChildProcessWithoutNullStreams);
      await waitForChildClose(terminal.child as ChildProcessWithoutNullStreams, 1_000);
      terminal.status = "interrupted";
      await terminal.appendEvent?.({ ...this.eventPayload(terminal), action: "host_shutdown" });
    }
  }

  list(sessionId: string, workspaceRoot: string): readonly TerminalSummary[] {
    return [...this.sessions.values()]
      .filter((terminal) => terminal.sessionId === sessionId && terminal.workspaceRoot === path.resolve(workspaceRoot))
      .map((terminal) => this.summary(terminal));
  }

  private get(sessionId: string, terminalId: string): ManagedTerminal {
    const terminal = this.sessions.get(terminalId);
    if (terminal === undefined || terminal.sessionId !== sessionId) throw new Error("TERMINAL_NOT_FOUND: terminal does not belong to this session");
    return terminal;
  }

  private append(terminal: ManagedTerminal, chunk: Buffer): void {
    terminal.totalBytes += chunk.byteLength;
    terminal.output += chunk.toString("utf8");
    if (Buffer.byteLength(terminal.output, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
      const encoded = Buffer.from(terminal.output, "utf8").subarray(-MAX_PROCESS_OUTPUT_BYTES);
      terminal.output = encoded.toString("utf8");
      terminal.readOffset = Math.max(0, terminal.readOffset - (terminal.output.length - encoded.length));
    }
  }

  private summary(terminal: ManagedTerminal): TerminalSummary {
    return {
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      workspaceRoot: terminal.workspaceRoot,
      cwd: terminal.cwd,
      command: terminal.command,
      status: terminal.status,
      ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
      ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
      bufferedBytes: terminal.child === undefined ? terminal.totalBytes : Buffer.byteLength(terminal.output, "utf8"),
    };
  }

  private eventPayload(terminal: ManagedTerminal): Readonly<Record<string, unknown>> {
    return {
      terminalId: terminal.terminalId,
      workspaceRoot: terminal.workspaceRoot,
      cwd: terminal.cwd,
      command: terminal.command,
      status: terminal.status,
      ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
      ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
      bufferedBytes: terminal.totalBytes,
    };
  }
}

export function createBuiltinTools(options: { readonly terminalManager?: TerminalManager; readonly jobManager?: JobManager; readonly eventStore?: Pick<EventStore, "list" | "project">; readonly visionEnabled?: boolean; readonly lspServers?: Readonly<Record<string, LspServerConfig>>; readonly lspManager?: LspManager; readonly codeMode?: CodeModeSandbox; readonly capabilities?: CapabilityRegistry } = {}): readonly ToolDefinition[] {
  const terminals = options.terminalManager ?? new TerminalManager();
  const jobs = options.jobManager ?? new JobManager(options.eventStore === undefined ? {} : { eventStore: options.eventStore });
  const lsp = options.lspManager ?? new LspManager(options.lspServers);
  const capabilities = options.capabilities ?? new CapabilityRegistry();
  const patches = new Map<string, AppliedPatch>();
  const tools: ToolDefinition[] = [
    {
      name: "read_file", description: "Read a bounded, line-numbered UTF-8 text range inside the workspace.", inputSchema: object({ path: string, offset: integer(1, Number.MAX_SAFE_INTEGER), limit: integer(1, MAX_READ_LINES) }, ["path"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { path: string; offset?: number; limit?: number }; return readWorkspaceFile(context.workspaceRoot, args, context.signal); },
    },
    {
      name: "glob", description: "List bounded, sorted files under the workspace matching a glob pattern.", inputSchema: object({ pattern: string, maxResults: integer(1, 5_000) }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { pattern: string; maxResults?: number }; return globFiles(context.workspaceRoot, args.pattern, args.maxResults ?? DEFAULT_GLOB_RESULTS); },
    },
    {
      name: "grep", description: "Search bounded UTF-8 text files with literal/regex, case, path, and context controls.", inputSchema: object({ pattern: string, path: string, maxResults: integer(1, 500), literal: boolean, ignoreCase: boolean, contextLines: integer(0, 20) }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => grepFiles(context.workspaceRoot, input as { pattern: string; path?: string; maxResults?: number; literal?: boolean; ignoreCase?: boolean; contextLines?: number }, context.signal),
    },
    {
      name: "edit_file", description: "Apply one or more unique exact replacements with stale detection and a unified diff.", inputSchema: object({ path: string, oldText: string, newText: string, expectedHash: string, edits: { type: "array" as const, maxItems: 50, items: object({ oldText: string, newText: string }, ["oldText", "newText"]) } }, ["path"]), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => editFile(context.workspaceRoot, input as { path: string; oldText?: string; newText?: string; expectedHash?: string; edits?: readonly { oldText: string; newText: string }[] }),
    },
    {
      name: "apply_patch", description: "Parse, preview, and apply a workspace-bound multi-file unified patch with stale-base and conflict checks.", inputSchema: object({ patch: string, dryRun: boolean, expectedHashes: { type: "object" as const, additionalProperties: true } }, ["patch"]), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => {
        const args = input as { patch: string; dryRun?: boolean; expectedHashes?: Readonly<Record<string, string>> };
        const patchId = `patch_${randomUUID()}`;
        try {
          const inspected = await previewUnifiedPatch(context.workspaceRoot, args.patch, args.expectedHashes ?? {});
          const record: AppliedPatch = { patchId, patch: args.patch, files: inspected.files, dryRun: args.dryRun === true, before: inspected.before, after: inspected.after };
          patches.set(patchId, record);
          await context.appendEvent("patch/preview", { patchId, dryRun: record.dryRun, files: inspected.files });
          if (record.dryRun) { const artifactPath = await persistPatchRecord(context.workspaceRoot, record); const persisted = { ...record, artifactPath: path.relative(path.resolve(context.workspaceRoot), artifactPath).replaceAll("\\", "/") }; patches.set(patchId, persisted); return patchResult(persisted, "Patch preview"); }
          await applyPreview(context.workspaceRoot, inspected);
          await context.appendEvent("patch/applied", { patchId, files: inspected.files });
          const artifactPath = await persistPatchRecord(context.workspaceRoot, record); const persisted = { ...record, artifactPath: path.relative(path.resolve(context.workspaceRoot), artifactPath).replaceAll("\\", "/") }; patches.set(patchId, persisted); return patchResult(persisted, "Patch applied");
        } catch (error) {
          const code = error instanceof PatchConflictError ? error.code : error instanceof PatchParseError ? error.code : "PATCH_APPLY_FAILED";
          return fail(code, error instanceof Error ? error.message : String(error), code === "PATCH_CONFLICT" ? "Reread every affected file, refresh expectedHashes, and regenerate the patch." : "Validate the unified patch and keep all targets inside the workspace.");
        }
      },
    },
    {
      name: "reject_patch", description: "Reject a previously previewed patch and record the decision without changing workspace files.", inputSchema: object({ patchId: string, reason: string }, ["patchId"]), executionMode: "exclusive", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => {
        const args = input as { patchId: string; reason?: string };
        const record = patches.get(args.patchId) ?? await loadPatchRecord(context.workspaceRoot, args.patchId);
        if (record === undefined) return fail("PATCH_NOT_FOUND", `Patch preview was not found: ${args.patchId}`, "Use the patchId returned by apply_patch in this host session.");
        if (!record.dryRun) return fail("PATCH_ALREADY_APPLIED", `Patch ${args.patchId} has already been applied`, "Use rollback_patch when the applied patch is still safe to reverse.");
        patches.delete(args.patchId);
        await removePatchRecord(context.workspaceRoot, args.patchId);
        await context.appendEvent("patch/rejected", { patchId: args.patchId, reason: args.reason ?? "Rejected by user", files: record.files });
        return ok({ patchId: args.patchId, status: "rejected", reason: args.reason ?? "Rejected by user" });
      },
    },
    {
      name: "rollback_patch", description: "Roll back an applied multi-file patch only when every target still matches the patch result.", inputSchema: object({ patchId: string }, ["patchId"]), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => {
        const patchId = (input as { patchId: string }).patchId;
        const record = patches.get(patchId) ?? await loadPatchRecord(context.workspaceRoot, patchId);
        if (record === undefined) return fail("PATCH_NOT_FOUND", `Applied patch was not found: ${patchId}`, "Use a patchId from the current host session.");
        if (record.dryRun) return fail("PATCH_NOT_APPLIED", `Patch ${patchId} was only previewed`, "Apply the patch first or reject the preview.");
        try {
          await applyPreview(context.workspaceRoot, { files: record.files, before: record.after, after: record.before });
          await context.appendEvent("patch/rolled_back", { patchId, files: record.files });
          patches.delete(patchId);
          await removePatchRecord(context.workspaceRoot, patchId);
          return ok({ patchId, status: "rolled_back", files: record.files });
        } catch (error) {
          const code = error instanceof PatchConflictError ? error.code : "PATCH_ROLLBACK_FAILED";
          return fail(code, error instanceof Error ? error.message : String(error), "Stop and inspect the affected files; rollback will not overwrite newer user changes.");
        }
      },
    },
    {
      name: "write_file", description: "Create, overwrite, or append a UTF-8 workspace file with stale detection and a unified diff.", inputSchema: object({ path: string, content: string, overwrite: boolean, mode: { type: "string" as const, enum: ["create", "overwrite", "append"] }, expectedHash: string }, ["path", "content"]), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => writeWorkspaceFile(context.workspaceRoot, input as { path: string; content: string; overwrite?: boolean; mode?: "create" | "overwrite" | "append"; expectedHash?: string }),
    },
    {
      name: "git_status", description: "Read git status for the workspace.", inputSchema: object({}), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (_input, context) => gitStatus(context.workspaceRoot, context.signal),
    },
    {
      name: "git_diff", description: "Read the current bounded Git diff for the workspace or one path.", inputSchema: object({ staged: boolean, path: string }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { staged?: boolean; path?: string }; const argv = args.staged === true ? ["diff", "--cached"] : ["diff"]; if (args.path !== undefined) argv.push("--", relativeGitPath(context.workspaceRoot, args.path)); return runArgv("git", argv, context.workspaceRoot, context.signal); },
    },
    {
      name: "run_command", description: "Run an allowlisted executable with argv inside the workspace.", inputSchema: object({ executable: string, args: { type: "array" as const, items: string, maxItems: 32 } }, ["executable"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { executable: string; args?: string[] }; if (!isAllowedExecutable(args.executable)) return fail("COMMAND_NOT_ALLOWED", "Executable is not on the allowlist"); return runArgv(args.executable, args.args ?? [], context.workspaceRoot, context.signal); },
    },
    {
      name: "run_tests", description: "Run the repository test command using argv.", inputSchema: object({ command: string, args: { type: "array" as const, items: string, maxItems: 32 } }, ["command"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { command: string; args?: string[] }; if (!isAllowedExecutable(args.command)) return fail("COMMAND_NOT_ALLOWED", "Test command is not on the allowlist"); return runArgv(args.command, args.args ?? [], context.workspaceRoot, context.signal); },
    },
    {
      name: "bash", description: "Run an explicit bash command in a fresh workspace-bound shell, optionally as a background job.", inputSchema: object({ command: string, description: string, workdir: string, timeoutMs: integer(1, 600_000), deadlineMs: integer(1, 86_400_000), maxAttempts: integer(1, 5), retryBackoffMs: integer(0, 60_000), run_in_background: boolean }, ["command"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => executeShellCommand("bash", input as ShellToolInput, context, jobs),
    },
    {
      name: "pwsh", description: "Run an explicit PowerShell command with native Windows path and environment semantics, optionally as a background job.", inputSchema: object({ command: string, description: string, workdir: string, timeoutMs: integer(1, 600_000), deadlineMs: integer(1, 86_400_000), maxAttempts: integer(1, 5), retryBackoffMs: integer(0, 60_000), run_in_background: boolean }, ["command"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => executeShellCommand("pwsh", input as ShellToolInput, context, jobs),
    },
    {
      name: "job_output", description: "Read bounded incremental output and status from a background job in this session.", inputSchema: object({ jobId: string, maxBytes: integer(1, MAX_PROCESS_OUTPUT_BYTES) }, ["jobId"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => jobs.read(context.sessionId, (input as { jobId: string }).jobId, (input as { maxBytes?: number }).maxBytes),
    },
    {
      name: "job_kill", description: "Stop a running background job in this session.", inputSchema: object({ jobId: string }, ["jobId"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => jobs.kill(context.sessionId, (input as { jobId: string }).jobId),
    },
    {
      name: "job_retry", description: "Retry a completed or failed background job using its durable executable metadata.", inputSchema: object({ jobId: string, backoffMs: integer(0, 60_000) }, ["jobId"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { jobId: string; backoffMs?: number }; return jobs.retry(context.sessionId, args.jobId, args.backoffMs === undefined ? {} : { backoffMs: args.backoffMs }); },
    },
    {
      name: "job_list", description: "List background jobs belonging to this session and workspace.", inputSchema: object({}), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (_input, context) => ({ ok: true, output: await jobs.listForSession(context.sessionId, context.workspaceRoot), presentation: { kind: "terminal", title: "Background jobs" } }),
    },
    {
      name: "terminal_open", description: "Open a persistent terminal process scoped to this session and workspace.", inputSchema: object({ cwd: string, executable: string, args: { type: "array" as const, items: string, maxItems: 32 }, env: { type: "object" as const, additionalProperties: true } }), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => terminals.open({ sessionId: context.sessionId, workspaceRoot: context.workspaceRoot, ...(typeof (input as { cwd?: unknown }).cwd === "string" ? { cwd: (input as { cwd: string }).cwd } : {}), ...(typeof (input as { executable?: unknown }).executable === "string" ? { executable: (input as { executable: string }).executable } : {}), ...((input as { args?: string[] }).args === undefined ? {} : { args: (input as { args: string[] }).args }), ...((input as { env?: Record<string, string> }).env === undefined ? {} : { env: (input as { env: Record<string, string> }).env }), appendEvent: async (payload) => context.appendEvent("terminal/session", payload) }),
    },
    {
      name: "terminal_send", description: "Send input to a persistent terminal process.", inputSchema: object({ terminalId: string, text: string, appendNewline: boolean }, ["terminalId", "text"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => terminals.send({ sessionId: context.sessionId, terminalId: (input as { terminalId: string }).terminalId, text: (input as { text: string }).text, ...((input as { appendNewline?: boolean }).appendNewline === undefined ? {} : { appendNewline: (input as { appendNewline: boolean }).appendNewline }) }, context.signal),
    },
    {
      name: "terminal_read", description: "Read new output from a persistent terminal process.", inputSchema: object({ terminalId: string, maxBytes: integer(1, MAX_PROCESS_OUTPUT_BYTES), waitMs: integer(0, 5_000) }, ["terminalId"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => terminals.read({ sessionId: context.sessionId, terminalId: (input as { terminalId: string }).terminalId, ...((input as { maxBytes?: number }).maxBytes === undefined ? {} : { maxBytes: (input as { maxBytes: number }).maxBytes }), ...((input as { waitMs?: number }).waitMs === undefined ? {} : { waitMs: (input as { waitMs: number }).waitMs }) }, context.signal),
    },
    {
      name: "terminal_signal", description: "Send a safe termination signal to a persistent terminal process.", inputSchema: object({ terminalId: string, signal: { type: "string" as const, enum: ["SIGINT", "SIGTERM", "SIGKILL"] } }, ["terminalId"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => terminals.signal({ sessionId: context.sessionId, terminalId: (input as { terminalId: string }).terminalId, ...((input as { signal?: "SIGINT" | "SIGTERM" | "SIGKILL" }).signal === undefined ? {} : { signal: (input as { signal: "SIGINT" | "SIGTERM" | "SIGKILL" }).signal }) }),
    },
    {
      name: "terminal_close", description: "Close a persistent terminal process and retain its audit summary.", inputSchema: object({ terminalId: string }, ["terminalId"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => terminals.close({ sessionId: context.sessionId, terminalId: (input as { terminalId: string }).terminalId, appendEvent: async (payload) => context.appendEvent("terminal/session", payload) }),
    },
    {
      name: "terminal_list", description: "List persistent terminal processes belonging to this session.", inputSchema: object({}), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (_input, context) => ok(terminals.list(context.sessionId, context.workspaceRoot)),
    },
    {
      name: "delete_file", description: "Move a workspace file or directory to a recoverable agent trash area; permanent deletion requires explicit opt-in.", inputSchema: object({ path: string, recursive: boolean, permanent: boolean }, ["path"]), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => deleteWorkspacePath(context.workspaceRoot, input as { path: string; recursive?: boolean; permanent?: boolean }),
    },
    {
      name: "git_log", description: "Read bounded commit history for the workspace.", inputSchema: object({ maxCount: integer(1, 100), path: string }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => gitLog(context.workspaceRoot, input as { maxCount?: number; path?: string }, context.signal),
    },
    {
      name: "git_show", description: "Show a bounded commit or object from the workspace repository.", inputSchema: object({ ref: string, path: string }, ["ref"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => gitShow(context.workspaceRoot, input as { ref: string; path?: string }, context.signal),
    },
    {
      name: "ask_user", description: "Ask the user a question and pause the current turn until they answer.", inputSchema: object({ question: string, options: { type: "array" as const, items: object({ label: string, value: string }, ["label", "value"]) }, allowFreeform: boolean }, ["question"]), executionMode: "exclusive", riskLevel: "read", approvalMode: "auto", interruptBehavior: "block",
      execute: async (input, context) => { const args = input as { question: string; options?: readonly { label: string; value: string }[]; allowFreeform?: boolean }; const answer = await context.requestUserInput({ question: args.question, ...(args.options === undefined ? {} : { options: args.options }), ...(args.allowFreeform === undefined ? {} : { allowFreeform: args.allowFreeform }) }); if (answer.status !== "answered") return fail(`INTERACTION_${answer.status.toUpperCase()}`, `User interaction ${answer.status}`); return ok({ interactionId: answer.interactionId, answer: answer.answer ?? "" }); },
    },
    {
      name: "plan", description: "Create or update the current implementation plan in the session projection.", inputSchema: object({ content: string, status: { type: "string" as const, enum: ["draft", "active", "approved", "rejected", "cleared"] } }, ["content"]), executionMode: "exclusive", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { content: string; status?: "draft" | "active" | "approved" | "rejected" | "cleared" }; const content = args.status === "cleared" ? "" : args.content; const status = args.status ?? (content.trim() === "" ? "cleared" : "draft"); await context.appendEvent("plan/updated", { content, status }); return ok({ content, status }); },
    },
    {
      name: "todo_write", description: "Replace the session todo list with an explicit set of pending, active, or completed items.", inputSchema: object({ todos: { type: "array" as const, maxItems: 100, items: object({ id: string, content: string, status: { type: "string" as const, enum: ["pending", "in_progress", "completed", "cancelled"] }, activeForm: string }, ["content", "status"]) } }, ["todos"]), executionMode: "exclusive", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { todos: readonly { id?: string; content: string; status: TodoStatus; activeForm?: string }[] }; const seen = new Set<string>(); const todos: TodoItem[] = args.todos.map((item, index) => { const id = item.id?.trim() || `todo_${index + 1}`; if (seen.has(id)) throw new Error(`TODO_DUPLICATE_ID: ${id}`); seen.add(id); return { id, content: item.content, status: item.status, ...(item.activeForm === undefined ? {} : { activeForm: item.activeForm }) }; }); await context.appendEvent("todo/updated", { todos }); return ok({ todos, allCompleted: todos.length > 0 && todos.every((item) => item.status === "completed") }); },
    },
    {
      name: "create_goal", description: "Create a durable session goal with explicit success criteria and optional budget metadata.", inputSchema: object({ title: string, successCriteria: { type: "array" as const, minItems: 1, maxItems: 20, items: string }, budget: { type: "object" as const, additionalProperties: true } }, ["title", "successCriteria"]), executionMode: "exclusive", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { title: string; successCriteria: readonly string[]; budget?: Record<string, unknown> }; const title = args.title.trim(); const criteria = args.successCriteria.map((item) => item.trim()).filter(Boolean); if (title.length === 0 || criteria.length === 0) return fail("GOAL_INPUT_INVALID", "A goal title and at least one non-empty success criterion are required."); const goalId = `goal_${randomUUID()}`; await context.appendEvent("goal/created", { goalId, title, successCriteria: criteria, ...(args.budget === undefined ? {} : { budget: args.budget }), status: "active" }); return ok({ goalId, title, successCriteria: criteria, status: "active" }); },
    },
    {
      name: "update_goal", description: "Update a durable goal status or result without claiming completion unless the supplied state says so.", inputSchema: object({ goalId: string, status: { type: "string" as const, enum: ["active", "completed", "blocked", "cancelled"] }, result: { type: "object" as const, additionalProperties: true }, reason: string }, ["goalId", "status"]), executionMode: "exclusive", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { goalId: string; status: "active" | "paused" | "completed" | "blocked" | "cancelled"; result?: unknown; reason?: string }; if (options.eventStore !== undefined) { const projection = await options.eventStore.project(context.sessionId); if (projection?.goals.every((goal) => goal.id !== args.goalId) !== false) return fail("GOAL_NOT_FOUND", `Goal does not exist in this session: ${args.goalId}`); } const eventType = args.status === "active" || args.status === "paused" ? "goal/updated" : "goal/ended"; await context.appendEvent(eventType, { goalId: args.goalId, status: args.status, ...(args.result === undefined ? {} : { result: args.result }), ...(args.reason === undefined ? {} : { reason: args.reason }) }); return ok({ goalId: args.goalId, status: args.status, ...(args.result === undefined ? {} : { result: args.result }), ...(args.reason === undefined ? {} : { reason: args.reason }) }); },
    },
    {
      name: "get_goal", description: "Read the current durable goal projection for this session.", inputSchema: object({ goalId: string }, ["goalId"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => getGoal(options.eventStore, context, (input as { goalId: string }).goalId),
    },
    {
      name: "session_query", description: "Query bounded public events for the current session by sequence, time, event type, text, or status.", inputSchema: object({ afterSequence: integer(0, Number.MAX_SAFE_INTEGER), beforeSequence: integer(1, Number.MAX_SAFE_INTEGER), after: string, before: string, eventTypes: { type: "array" as const, maxItems: 20, items: string }, text: string, status: string, maxResults: integer(1, 200) }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => querySessionEvents(options.eventStore, context, input as SessionQueryInput),
    },
    {
      name: "capability_status", description: "Inspect enabled Phase 3B.5 extension capabilities and their bounded limits.", inputSchema: object({}), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async () => ok({ capabilities: capabilities.snapshot() }),
    },
  ];
  if (options.visionEnabled === true) tools.push({
    name: "read_image", description: "Read bounded image metadata and an optional controlled vision artifact from the workspace.", inputSchema: object({ path: string, includeData: boolean }, ["path"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
    execute: async (input, context) => readWorkspaceImage(context.workspaceRoot, input as { path: string; includeData?: boolean }, context.signal),
  });
  if (options.lspServers !== undefined || options.lspManager !== undefined) {
    tools.push(
      { name: "lsp_diagnostics", description: "Request read-only diagnostics from a configured workspace LSP server.", inputSchema: object({ serverId: string, path: string }, ["path"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async (input, context) => lsp.diagnostics(input as { serverId?: string; path: string }, context.workspaceRoot, context.signal, { sessionId: context.sessionId, toolCallId: context.toolCallId, appendEvent: context.appendEvent }) },
      { name: "lsp_definition", description: "Request a read-only definition location from a configured workspace LSP server.", inputSchema: object({ serverId: string, path: string, line: integer(0, Number.MAX_SAFE_INTEGER), character: integer(0, Number.MAX_SAFE_INTEGER) }, ["path", "line", "character"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async (input, context) => lsp.definition(input as { serverId?: string; path: string; line: number; character: number }, context.workspaceRoot, context.signal, { sessionId: context.sessionId, toolCallId: context.toolCallId, appendEvent: context.appendEvent }) },
      { name: "lsp_references", description: "Request read-only references from a configured workspace LSP server.", inputSchema: object({ serverId: string, path: string, line: integer(0, Number.MAX_SAFE_INTEGER), character: integer(0, Number.MAX_SAFE_INTEGER), includeDeclaration: boolean }, ["path", "line", "character"]), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async (input, context) => lsp.references(input as { serverId?: string; path: string; line: number; character: number; includeDeclaration?: boolean }, context.workspaceRoot, context.signal, { sessionId: context.sessionId, toolCallId: context.toolCallId, appendEvent: context.appendEvent }) },
    );
  }
  if (options.codeMode !== undefined) tools.push({
    name: "code_mode",
    description: "Run bounded JavaScript in the host-controlled Code Mode sandbox.",
    inputSchema: object({ code: string, language: { type: "string" as const, enum: ["javascript"] }, args: { type: "array" as const, maxItems: 16, items: string }, cwd: string }, ["code"]),
    executionMode: "exclusive",
    riskLevel: "execute",
    approvalMode: "ask",
    interruptBehavior: "cancel",
    execute: async (input, context) => options.codeMode!.run(input as { code: string; language?: "javascript"; args?: readonly string[]; cwd?: string }, { workspaceRoot: context.workspaceRoot, signal: context.signal, reportProgress: context.reportProgress }),
  });
  return tools;
}

interface SessionQueryInput { readonly afterSequence?: number; readonly beforeSequence?: number; readonly after?: string; readonly before?: string; readonly eventTypes?: readonly string[]; readonly text?: string; readonly status?: string; readonly maxResults?: number; }

async function getGoal(store: Pick<EventStore, "project"> | undefined, context: ToolContext, goalId: string): Promise<ToolResult> {
  if (store === undefined) return fail("GOAL_STATE_UNAVAILABLE", "Goal projection is unavailable in this tool adapter.");
  const projection = await store.project(context.sessionId);
  const goal = projection?.goals.find((item) => item.id === goalId);
  return goal === undefined ? fail("GOAL_NOT_FOUND", `Goal does not exist in this session: ${goalId}`) : { ok: true, output: goal, presentation: { kind: "tool", title: `Goal ${goalId}`, data: goal } };
}

async function querySessionEvents(store: Pick<EventStore, "list"> | undefined, context: ToolContext, input: SessionQueryInput): Promise<ToolResult> {
  if (store === undefined) return fail("SESSION_QUERY_UNAVAILABLE", "Session query is unavailable in this tool adapter.");
  const events = await store.list(context.sessionId, input.afterSequence ?? 0);
  const eventTypes = new Set(input.eventTypes ?? []);
  const text = input.text?.toLowerCase();
  const filtered = events.filter((event) => {
    if (input.beforeSequence !== undefined && event.sequence >= input.beforeSequence) return false;
    if (input.after !== undefined && event.createdAt < input.after) return false;
    if (input.before !== undefined && event.createdAt > input.before) return false;
    if (eventTypes.size > 0 && !eventTypes.has(event.type)) return false;
    if (input.status !== undefined && event.payload["status"] !== input.status) return false;
    if (text !== undefined && !JSON.stringify(event).toLowerCase().includes(text)) return false;
    return true;
  });
  const maxResults = Math.min(Math.max(input.maxResults ?? 50, 1), 200);
  const result = filtered.slice(0, maxResults);
  return { ok: true, output: { sessionId: context.sessionId, events: result, returned: result.length, totalMatches: filtered.length, truncated: filtered.length > result.length, nextAfterSequence: result.at(-1)?.sequence }, presentation: { kind: "tool", title: "Session query", data: { returned: result.length, totalMatches: filtered.length } } };
}

interface EditableFile {
  readonly target: string;
  readonly before: string;
  readonly hash: string;
}

interface ShellToolInput {
  readonly command: string;
  readonly description?: string;
  readonly workdir?: string;
  readonly timeoutMs?: number;
  readonly deadlineMs?: number;
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: number;
  readonly run_in_background?: boolean;
}

type ShellKind = "bash" | "pwsh";

async function executeShellCommand(kind: ShellKind, args: ShellToolInput, context: ToolContext, jobs: JobManager): Promise<ToolResult> {
  if (args.command.trim().length === 0) return fail("COMMAND_REQUIRED", "Shell command cannot be empty");
  const resolver = new WorkspaceResolver(context.workspaceRoot);
  let cwd: string;
  try { cwd = args.workdir === undefined ? resolver.rootPath : await resolver.resolveExisting(args.workdir); if (!(await stat(cwd)).isDirectory()) return fail("WORKDIR_INVALID", `Shell workdir is not a directory: ${args.workdir}`); }
  catch { return fail("WORKDIR_INVALID", `Shell workdir is invalid: ${args.workdir ?? context.workspaceRoot}`); }
  const launch = shellLaunch(kind, args.command);
  const label = args.description?.trim() || args.command;
  if (args.run_in_background === true) {
    return jobs.start({ sessionId: context.sessionId, workspaceRoot: context.workspaceRoot, cwd, executable: launch.executable, args: launch.args, command: args.command, ...(args.maxAttempts === undefined ? {} : { retry: { maxAttempts: args.maxAttempts, ...(args.retryBackoffMs === undefined ? {} : { backoffMs: args.retryBackoffMs }) } }), ...(args.deadlineMs === undefined ? {} : { deadlineMs: args.deadlineMs }), signal: context.signal, appendEvent: async (type, payload) => context.appendEvent(type, payload) });
  }
  return runShellForeground(kind, args.command, label, cwd, launch.executable, launch.args, args.timeoutMs ?? 120_000, context.signal);
}

function shellLaunch(kind: ShellKind, command: string): { readonly executable: string; readonly args: readonly string[] } {
  if (kind === "bash") return { executable: "bash", args: ["-lc", command] };
  const constrained = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; " + command;
  return { executable: process.platform === "win32" ? (process.env["CODE_REVIEW_AGENT_PWSH"] ?? "pwsh") : "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", constrained] };
}

function runShellForeground(kind: ShellKind, command: string, label: string, cwd: string, executable: string, args: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { cwd, detached: false, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    let output = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (result: ToolResult): void => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(result); };
    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => { const text = chunk.toString("utf8"); if (stream === "stdout") stdout += text; else stderr += text; output += text; bytes += chunk.byteLength; if (Buffer.byteLength(output, "utf8") > MAX_PROCESS_OUTPUT_BYTES) { output = Buffer.from(output, "utf8").subarray(-MAX_PROCESS_OUTPUT_BYTES).toString("utf8"); truncated = true; } };
    const abort = (): void => { terminateProcessTree(child); finish({ ...fail("COMMAND_CANCELLED", `${kind} command was cancelled`), output, audit: { stdout, stderr, exitCode: child.exitCode, signal: child.signalCode, timedOut: false, cwd, shell: kind }, usage: { bytes, truncated } }); };
    const timer = setTimeout(() => { timedOut = true; terminateProcessTree(child); finish({ ...fail("TIMEOUT", `${kind} command exceeded ${timeoutMs}ms`), output, audit: { stdout, stderr, exitCode: child.exitCode, signal: child.signalCode, timedOut: true, cwd, shell: kind }, usage: { bytes, truncated } }); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => finish({ ...fail((error as NodeJS.ErrnoException).code === "ENOENT" ? "COMMAND_NOT_FOUND" : "COMMAND_FAILED", error.message), output, audit: { stdout, stderr, exitCode: null, signal: null, timedOut, cwd, shell: kind }, usage: { bytes, truncated } }));
    child.once("close", (exitCode, signalName) => {
      if (settled) return;
      const audit = { stdout, stderr, exitCode, signal: signalName, timedOut, cwd, shell: kind };
      if (signal.aborted) finish({ ...fail("COMMAND_CANCELLED", `${kind} command was cancelled`), output, audit, usage: { bytes, truncated } });
      else if (timedOut) finish({ ...fail("TIMEOUT", `${kind} command exceeded ${timeoutMs}ms`), output, audit, usage: { bytes, truncated } });
      else if (truncated) finish({ ...fail("OUTPUT_TRUNCATED", `${kind} output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`), output, audit, usage: { bytes, truncated } });
      else if (exitCode === 0) finish({ ...ok(output), audit, usage: { bytes, truncated }, presentation: { kind: "terminal", title: label, text: output, data: audit } });
      else finish({ ok: false, output, audit, usage: { bytes, truncated }, error: { code: "NON_ZERO_EXIT", message: `${kind} exited with code ${exitCode}`, remedy: "Inspect stdout/stderr and adjust the command only when the failure supports it." }, presentation: { kind: "terminal", title: label, text: output, data: audit } });
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function loadEditableFile(root: string, filePath: string): Promise<EditableFile | ToolResult> {
  const resolver = new WorkspaceResolver(root);
  let target: string;
  try { target = await resolver.resolveExisting(filePath); } catch { return fail("FILE_NOT_FOUND", `File was not found: ${filePath}`); }
  const info = await stat(target);
  if (!info.isFile()) return fail("FILE_NOT_REGULAR", `Target is not a regular file: ${filePath}`);
  if (info.size > MAX_FILE_BYTES) return fail("FILE_TOO_LARGE", `File exceeds ${MAX_FILE_BYTES} bytes`);
  const buffer = await readFile(target);
  if (buffer.includes(0)) return fail("FILE_BINARY", `Binary file is not editable as UTF-8 text: ${filePath}`);
  const before = buffer.toString("utf8");
  return { target, before, hash: hashText(before) };
}

async function editFile(root: string, args: { path: string; oldText?: string; newText?: string; expectedHash?: string; edits?: readonly { oldText: string; newText: string }[] }): Promise<ToolResult> {
  const loaded = await loadEditableFile(root, args.path);
  if ("ok" in loaded) return loaded;
  if (args.expectedHash !== undefined && args.expectedHash !== loaded.hash) return editFailure("EDIT_STALE", args.path, loaded.before, `File hash changed before edit (expected ${args.expectedHash}, current ${loaded.hash})`, 0);
  const operations = args.edits ?? (args.oldText === undefined || args.newText === undefined ? [] : [{ oldText: args.oldText, newText: args.newText }]);
  if (operations.length === 0) return fail("EDIT_INPUT_INVALID", "Provide oldText/newText or at least one edits item", "Provide an exact replacement or a non-empty edits array.");
  let after = loaded.before;
  const statuses: { readonly index: number; readonly status: "applied"; readonly matchCount: number }[] = [];
  for (const [index, operation] of operations.entries()) {
    if (operation.oldText.length === 0) return fail("EDIT_INPUT_INVALID", `Edit ${index + 1} oldText cannot be empty`);
    const positions = findOccurrences(after, operation.oldText);
    if (positions.length !== 1) return editFailure(positions.length === 0 ? "TEXT_NOT_FOUND" : "TEXT_NOT_UNIQUE", args.path, after, `Edit ${index + 1} expected one match but found ${positions.length}`, positions.length);
    const position = positions[0]!;
    after = after.slice(0, position) + operation.newText + after.slice(position + operation.oldText.length);
    statuses.push({ index, status: "applied", matchCount: 1 });
  }
  const latest = await loadEditableFile(root, args.path);
  if ("ok" in latest) return latest;
  if (latest.hash !== loaded.hash) return editFailure("EDIT_CONFLICT", args.path, latest.before, `File changed during edit (expected ${loaded.hash}, current ${latest.hash})`, 0);
  if (after === loaded.before) return fail("EDIT_NOOP", `Edit produced no change: ${args.path}`, "Reread the file and provide a replacement that changes the current content.");
  await writeFile(loaded.target, after, "utf8");
  const unifiedDiff = buildUnifiedDiff(args.path, loaded.before, after);
  return {
    ok: true,
    output: { path: args.path, beforeHash: loaded.hash, afterHash: hashText(after), operations: statuses, changed: true, unifiedDiff },
    diff: { path: args.path, before: loaded.before, after },
    presentation: { kind: "diff", title: `Updated ${args.path}`, text: unifiedDiff, data: { path: args.path, operations: statuses, unifiedDiff } },
  };
}

async function writeWorkspaceFile(root: string, args: { path: string; content: string; overwrite?: boolean; mode?: "create" | "overwrite" | "append"; expectedHash?: string }): Promise<ToolResult> {
  const resolver = new WorkspaceResolver(root);
  const candidate = resolver.resolve(args.path);
  const mode = args.mode ?? (args.overwrite === true ? "overwrite" : "create");
  let loaded: EditableFile | undefined;
  try {
    const current = await loadEditableFile(root, args.path);
    if ("ok" in current) {
      if (current.error?.code !== "FILE_NOT_FOUND") return current;
    } else loaded = current;
  } catch (error) { if (!isMissingPathError(error)) throw error; }
  if (mode === "create" && loaded !== undefined) return fail("WRITE_TARGET_EXISTS", "Refusing to overwrite an existing file in create mode", "Use mode=overwrite or mode=append only when the current content has been inspected and approval is granted.");
  if (args.expectedHash !== undefined && (loaded === undefined || args.expectedHash !== loaded.hash)) return fail("EDIT_STALE", `File hash does not match expectedHash for ${args.path}`, "Reread the target and send the current expectedHash before writing.");
  const before = loaded?.before ?? "";
  const after = mode === "append" ? `${before}${args.content}` : args.content;
  if (loaded !== undefined) {
    const latest = await loadEditableFile(root, args.path);
    if ("ok" in latest) return latest;
    if (latest.hash !== loaded.hash) return fail("EDIT_CONFLICT", `File changed during write: ${args.path}`, "Reread the file and retry with a fresh expectedHash.");
  }
  await mkdir(path.dirname(candidate), { recursive: true });
  const target = await resolver.resolveForWrite(args.path);
  await writeFile(target, after, "utf8");
  const unifiedDiff = buildUnifiedDiff(args.path, before, after);
  return {
    ok: true,
    output: { path: args.path, mode, bytes: Buffer.byteLength(args.content), beforeHash: loaded?.hash, afterHash: hashText(after), unifiedDiff },
    diff: { path: args.path, before, after },
    presentation: { kind: "diff", title: `${mode === "append" ? "Appended to" : "Updated"} ${args.path}`, text: unifiedDiff, data: { path: args.path, mode, unifiedDiff } },
  };
}

async function readWorkspaceFile(root: string, args: { path: string; offset?: number; limit?: number }, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return fail("TOOL_CANCELLED", "File read was cancelled");
  const offset = args.offset ?? 1;
  const limit = args.limit ?? DEFAULT_READ_LINES;
  const resolver = new WorkspaceResolver(root);
  let target: string;
  try { target = await resolver.resolveExisting(args.path); } catch { return fail("FILE_NOT_FOUND", `File was not found: ${args.path}`); }
  const info = await stat(target);
  if (!info.isFile()) return fail("FILE_NOT_REGULAR", `Target is not a regular file: ${args.path}`);
  if (info.size > MAX_FILE_BYTES) return fail("FILE_TOO_LARGE", `File exceeds ${MAX_FILE_BYTES} bytes`);
  const buffer = await readFile(target);
  if (buffer.includes(0)) return fail("FILE_BINARY", `Binary file is not readable as UTF-8 text: ${args.path}`);
  const text = buffer.toString("utf8");
  const allLines = text.length === 0 ? [] : text.split(/\r?\n/u);
  const totalLines = allLines.length;
  if (offset > Math.max(totalLines, 1)) return fail("READ_OFFSET_INVALID", `Offset ${offset} is outside ${args.path} (${totalLines} lines)`);
  const selected: { readonly number: number; readonly text: string }[] = [];
  let outputBytes = 0;
  for (let index = offset - 1; index < Math.min(allLines.length, offset - 1 + limit); index += 1) {
    if (signal.aborted) return fail("TOOL_CANCELLED", "File read was cancelled");
    const line = allLines[index]!.length > MAX_READ_LINE_CHARS ? `${allLines[index]!.slice(0, MAX_READ_LINE_CHARS)}… (line truncated)` : allLines[index]!;
    const bytes = Buffer.byteLength(`${index + 1}: ${line}\n`, "utf8");
    if (outputBytes + bytes > MAX_READ_RESULT_BYTES && selected.length > 0) break;
    selected.push({ number: index + 1, text: line });
    outputBytes += bytes;
  }
  const endLine = selected.at(-1)?.number ?? offset - 1;
  const truncated = endLine < totalLines;
  const footer = truncated ? `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)` : `(End of file - total ${totalLines} lines)`;
  const modelView = `<path>${args.path}</path>\n${selected.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`;
  return {
    ok: true,
    output: { path: args.path, offset, limit, totalLines, lines: selected, truncated, ...(truncated ? { nextOffset: endLine + 1 } : {}) },
    modelView,
    presentation: { kind: "tool", title: `Read ${args.path}`, text: modelView, data: { path: args.path, offset, totalLines, lines: selected, truncated } },
  };
}

async function globFiles(root: string, pattern: string, maxResults: number): Promise<ToolResult> {
  const normalized = pattern.trim().replaceAll("\\", "/");
  if (normalized.length === 0) return fail("GLOB_PATTERN_REQUIRED", "Glob pattern cannot be empty");
  let regex: RegExp;
  try { regex = globRegExp(normalized); } catch (error) { return fail("GLOB_PATTERN_INVALID", error instanceof Error ? error.message : String(error)); }
  const matches: string[] = [];
  let seen = 0;
  await walk(root, root, async (file) => {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const candidate = normalized.includes("/") ? relative : path.posix.basename(relative);
    if (!regex.test(candidate)) return;
    seen += 1;
    if (matches.length < maxResults) matches.push(relative);
  });
  matches.sort();
  const truncated = seen > matches.length;
  return {
    ok: true,
    output: { root: ".", paths: matches, seen, truncated, ...(truncated ? { nextStep: "Narrow the pattern or lower the search scope to inspect all matches." } : {}) },
    presentation: { kind: "tool", title: `Glob ${pattern}`, text: matches.join("\n"), data: { root: ".", paths: matches, seen, truncated } },
  };
}

async function walk(root: string, current: string, visit: (file: string) => Promise<void>): Promise<void> { for (const entry of await readdir(current, { withFileTypes: true })) { const full = path.join(current, entry.name); if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules" && entry.name !== ".agent-trash" && entry.name !== ".agent-artifacts") await walk(root, full, visit); else if (entry.isFile()) await visit(full); } }

async function grepFiles(root: string, args: { pattern: string; path?: string; maxResults?: number; literal?: boolean; ignoreCase?: boolean; contextLines?: number }, signal: AbortSignal): Promise<ToolResult> {
  const resolver = new WorkspaceResolver(root);
  let base: string;
  try { base = await resolver.resolveExisting(args.path || "."); } catch { return fail("SEARCH_PATH_INVALID", `Search path is not inside the workspace or does not exist: ${args.path ?? "."}`); }
  let regex: RegExp;
  try { regex = new RegExp(args.literal === true ? escapeRegExp(args.pattern) : args.pattern, args.ignoreCase === true ? "iu" : "u"); } catch (error) { return fail("SEARCH_PATTERN_INVALID", error instanceof Error ? error.message : String(error)); }
  const info = await stat(base);
  const files: string[] = [];
  if (info.isFile()) files.push(base); else await walk(root, base, async (file) => { files.push(file); });
  files.sort();
  const maxResults = args.maxResults ?? 100;
  const contextLines = args.contextLines ?? 0;
  const matches: { readonly path: string; readonly lineNumber: number; readonly line: string; readonly before: readonly string[]; readonly after: readonly string[] }[] = [];
  let skippedBinaryFiles = 0;
  let truncated = false;
  for (const file of files) {
    if (signal.aborted) return fail("TOOL_CANCELLED", "Search was cancelled");
    if ((await stat(file)).size > MAX_SEARCH_FILE_BYTES) continue;
    const buffer = await readFile(file);
    if (buffer.includes(0)) { skippedBinaryFiles += 1; continue; }
    const lines = buffer.toString("utf8").split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index]!)) continue;
      if (matches.length >= maxResults) { truncated = true; break; }
      matches.push({
        path: path.relative(root, file).replaceAll("\\", "/"),
        lineNumber: index + 1,
        line: lines[index]!,
        before: lines.slice(Math.max(0, index - contextLines), index),
        after: lines.slice(index + 1, Math.min(lines.length, index + 1 + contextLines)),
      });
    }
    if (truncated) break;
  }
  return {
    ok: true,
    output: { matches, searchedFiles: files.length, skippedBinaryFiles, truncated, ...(truncated ? { nextStep: "Narrow the pattern/path or increase maxResults within the schema limit." } : {}) },
    presentation: { kind: "tool", title: `Grep ${args.pattern}`, text: matches.map((match) => `${match.path}:${match.lineNumber}:${match.line}`).join("\n"), data: { matches, truncated, searchedFiles: files.length, skippedBinaryFiles } },
  };
}

async function gitStatus(cwd: string, signal: AbortSignal): Promise<ToolResult> { const result = await runArgv("git", ["status", "--porcelain=v2", "--branch"], cwd, signal); if (!result.ok || typeof result.output !== "string") return result; const lines = result.output.split(/\r?\n/u).filter(Boolean); const value = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length); const branchAb = value("# branch.ab ")?.match(/^\+(\d+) -(\d+)$/u); return { ...result, output: { branch: { head: value("# branch.head "), oid: value("# branch.oid "), ahead: branchAb === undefined || branchAb === null ? 0 : Number(branchAb[1]), behind: branchAb === undefined || branchAb === null ? 0 : Number(branchAb[2]) }, entries: lines.filter((line) => !line.startsWith("# ")).map((line) => ({ raw: line })) } }; }

async function gitLog(cwd: string, args: { maxCount?: number; path?: string }, signal: AbortSignal): Promise<ToolResult> { const maxCount = Math.min(Math.max(args.maxCount ?? 20, 1), 100); const argv = ["log", "--no-color", `-n${maxCount}`, "--format=%H%x1f%an%x1f%aI%x1f%s%x1e"]; if (args.path !== undefined) argv.push("--", relativeGitPath(cwd, args.path)); const result = await runArgv("git", argv, cwd, signal); if (!result.ok || typeof result.output !== "string") return result; const commits = result.output.split("\x1e").flatMap((record) => { const fields = record.trim().split("\x1f"); return fields.length >= 4 && fields[0] !== undefined && fields[1] !== undefined && fields[2] !== undefined && fields[3] !== undefined ? [{ hash: fields[0], author: fields[1], date: fields[2], subject: fields.slice(3).join("\x1f") }] : []; }); return { ...result, output: { commits, text: result.output } }; }

async function gitShow(cwd: string, args: { ref: string; path?: string }, signal: AbortSignal): Promise<ToolResult> { if (!/^[A-Za-z0-9._/@:~-]+$/u.test(args.ref)) return fail("GIT_REF_INVALID", "Git ref contains unsupported characters"); const argv = ["show", "--no-color", "--no-ext-diff", "--format=fuller", "--stat", "--patch", args.ref]; if (args.path !== undefined) argv.push("--", relativeGitPath(cwd, args.path)); return runArgv("git", argv, cwd, signal); }

function relativeGitPath(cwd: string, value: string): string { const resolver = new WorkspaceResolver(cwd); const absolute = resolver.resolve(value); const relative = path.relative(resolver.rootPath, absolute).replaceAll("\\", "/"); if (relative === "") throw new Error("GIT_PATH_INVALID: path must be inside the workspace"); return relative; }

async function deleteWorkspacePath(root: string, args: { path: string; recursive?: boolean; permanent?: boolean }): Promise<ToolResult> { const resolver = new WorkspaceResolver(root); const candidate = resolver.resolve(args.path); if (candidate === resolver.rootPath) return fail("DELETE_WORKSPACE_ROOT", "Refusing to delete the workspace root"); const existing = await resolver.resolveExisting(args.path); const info = await stat(existing); if (args.permanent === true) { await rm(candidate, { force: false, recursive: args.recursive ?? info.isDirectory() }); return ok({ path: args.path, permanent: true, type: info.isDirectory() ? "directory" : "file" }); } const trashRoot = path.join(resolver.rootPath, ".agent-trash"); await mkdir(trashRoot, { recursive: true }); const trashPath = path.join(trashRoot, `${Date.now()}-${randomUUID()}-${path.basename(candidate)}`); await rename(candidate, trashPath); return ok({ path: args.path, permanent: false, trashedTo: path.relative(resolver.rootPath, trashPath).replaceAll("\\", "/"), type: info.isDirectory() ? "directory" : "file" }); }

async function runArgv(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<ToolResult> {
  try {
    if (!(await stat(cwd)).isDirectory()) return fail("WORKDIR_INVALID", `Working directory is not a directory: ${cwd}`);
  } catch { return fail("WORKDIR_INVALID", `Working directory does not exist: ${cwd}`); }
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, detached: true, shell: false, windowsHide: true });
    let output = "";
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout += text; else stderr += text;
      bytes += chunk.byteLength;
      const currentBytes = Buffer.byteLength(output, "utf8");
      if (currentBytes < MAX_PROCESS_OUTPUT_BYTES) output += text.slice(0, MAX_PROCESS_OUTPUT_BYTES - currentBytes);
      if (bytes > MAX_PROCESS_OUTPUT_BYTES) truncated = true;
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    const abort = () => terminateProcessTree(child);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      signal.removeEventListener("abort", abort);
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "COMMAND_NOT_FOUND" : "COMMAND_FAILED";
      resolve(fail(code, error.message));
    });
    child.on("close", (code, signalName) => {
      signal.removeEventListener("abort", abort);
      const usage = { bytes, truncated };
      const audit = { stdout, stderr, exitCode: code, signal: signalName ?? undefined };
      if (signal.aborted || signalName) resolve({ ...fail("COMMAND_CANCELLED", "Command was cancelled"), output, audit, usage });
      else if (truncated) resolve({ ok: false, output, audit, usage, error: { code: "OUTPUT_TRUNCATED", message: `Command output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`, remedy: "Narrow the command or use a bounded output path." }, presentation: { kind: "terminal", title: "Command output truncated", text: output } });
      else if (code === 0) resolve({ ...ok(output), audit, usage });
      else resolve({ ok: false, output, audit, usage, error: { code: "NON_ZERO_EXIT", message: `Command exited with code ${code}`, remedy: "Inspect stdout/stderr and exit metadata before selecting the next command." }, presentation: { kind: "terminal", title: "Command failed", text: output } });
    });
  });
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams | ReturnType<typeof spawn>): void { if (child.pid === undefined) { child.kill(); return; } if (process.platform === "win32") { const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false }); killer.unref(); try { child.kill(); } catch { /* taskkill remains the fallback for the process tree */ } } else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } } }
function defaultShell(): string { return process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : (process.env["SHELL"] ?? "/bin/sh"); }
function defaultShellArgs(): string[] { return process.platform === "win32" ? ["/d", "/q"] : ["-i"]; }
function isAllowedExecutable(command: string): boolean { return /^[a-zA-Z0-9._-]+$/u.test(command) && ALLOWED_EXECUTABLES.has(command.toLowerCase()); }
function terminalStatus(value: unknown): TerminalStatus { return value === "exited" || value === "closed" || value === "interrupted" ? value : "running"; }
function waitForTerminalOutput(terminal: ManagedTerminal, waitMs: number, signal: AbortSignal): Promise<void> { return new Promise((resolve) => { const started = Date.now(); const timer = setInterval(() => { if (signal.aborted || terminal.readOffset < terminal.output.length || terminal.status !== "running" || Date.now() - started >= waitMs) { clearInterval(timer); resolve(); } }, 25); }); }
function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); return new Promise((resolve) => { let settled = false; const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); }; const timer = setTimeout(finish, timeoutMs); child.once("close", finish); }); }
function isMissingPathError(error: unknown): boolean { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"; }
function hashText(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function findOccurrences(value: string, needle: string): number[] { const positions: number[] = []; let offset = 0; while (offset <= value.length - needle.length) { const index = value.indexOf(needle, offset); if (index < 0) break; positions.push(index); offset = index + Math.max(needle.length, 1); } return positions; }
function editFailure(code: string, filePath: string, text: string, message: string, matchCount: number): ToolResult {
  const context = text.split(/\r?\n/u).slice(0, 8).map((line, index) => `${index + 1}: ${line}`).join("\n");
  return { ok: false, error: { code, message: `${message}; path=${filePath}; matchCount=${matchCount}`, remedy: code === "EDIT_CONFLICT" || code === "EDIT_STALE" ? "Stop, reread the current file, and retry with a fresh expectedHash." : "Include more exact surrounding context so exactly one current match is selected." }, presentation: { kind: "diff", title: code, text: context, data: { path: filePath, matchCount, context } } };
}
function patchResult(record: AppliedPatch, title: string): ToolResult {
  const text = record.files.map((file) => file.unifiedDiff).filter(Boolean).join("\n\n");
  return {
    ok: true,
    output: { patchId: record.patchId, status: record.dryRun ? "preview" : "applied", dryRun: record.dryRun, files: record.files, ...(record.artifactPath === undefined ? {} : { artifactPath: record.artifactPath }) },
    ...(record.files.length === 1 ? { diff: { path: record.files[0]!.path, before: record.before[record.files[0]!.path] ?? "", after: record.after[record.files[0]!.path] ?? "" } } : {}),
    presentation: { kind: "diff", title, text, data: { patchId: record.patchId, dryRun: record.dryRun, files: record.files } },
  };
}
function buildUnifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before.split(/\r?\n/u);
  const newLines = after.split(/\r?\n/u);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const oldCount = Math.max(removed.length, 1);
  const newCount = Math.max(added.length, 1);
  return [`--- a/${filePath}`, `+++ b/${filePath}`, `@@ -${prefix + 1},${oldCount} +${prefix + 1},${newCount} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
}
function ok(output: unknown): ToolResult { return { ok: true, output, presentation: { kind: "tool", title: "Completed" } }; }
function fail(code: string, message: string, remedy?: string): ToolResult { return { ok: false, error: { code, message, remedy: remedy ?? remedyForBuiltinError(code) }, presentation: { kind: "tool", title: code, text: message } }; }
function remedyForBuiltinError(code: string): string {
  if (code === "FILE_NOT_FOUND" || code === "FILE_NOT_REGULAR") return "Check the workspace-relative path and reread the current target.";
  if (code === "FILE_BINARY") return "Use a controlled image/binary-aware tool when available; do not decode arbitrary bytes as text.";
  if (code === "FILE_TOO_LARGE" || code === "READ_OFFSET_INVALID") return "Use a bounded line range or choose a supported artifact/read path.";
  if (code === "GLOB_PATTERN_REQUIRED" || code === "GLOB_PATTERN_INVALID") return "Use a non-empty supported glob rooted at the active workspace.";
  if (code === "SEARCH_PATH_INVALID" || code === "SEARCH_PATTERN_INVALID") return "Correct the search path/pattern and retry with a bounded scope.";
  if (code === "COMMAND_NOT_ALLOWED") return "Choose an executable from the visible allowlist and pass explicit argv.";
  if (code === "COMMAND_NOT_FOUND") return "Check the executable name and installed toolchain before retrying.";
  if (code === "WORKDIR_INVALID") return "Use an existing directory inside the active workspace.";
  if (code === "NON_ZERO_EXIT") return "Inspect stdout/stderr and exit metadata before selecting the next command.";
  if (code === "OUTPUT_TRUNCATED") return "Narrow the command/search scope or use the bounded continuation/spill guidance.";
  return "Inspect the structured error and adjust the next safe step; do not blindly repeat the call.";
}
function globRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*" && pattern[index + 2] === "/") { source += "(?:.*/)?"; index += 2; }
      else if (pattern[index + 1] === "*") { source += ".*"; index += 1; }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, "u");
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
