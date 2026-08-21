import type {
  ToolDefinition,
  ToolResult,
  TodoItem,
  TodoStatus,
} from "@code-review-agent/contracts";
import { readFile, writeFile, readdir, stat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WorkspaceResolver } from "@code-review-agent/workspace";

const ALLOWED_EXECUTABLES = new Set(["git", "node", "npm", "pnpm", "vitest"]);
const MAX_PROCESS_OUTPUT_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1 * 1024 * 1024;
const DEFAULT_GLOB_RESULTS = 1_000;
const DEFAULT_TERMINAL_READ_BYTES = 64 * 1024;

const object = (properties: Record<string, any>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const string = { type: "string" as const };
const boolean = { type: "boolean" as const };
const integer = (minimum: number, maximum: number) => ({ type: "integer" as const, minimum, maximum });

export type TerminalStatus = "running" | "exited" | "closed";

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
  readonly child: ChildProcessWithoutNullStreams;
  output: string;
  readOffset: number;
  totalBytes: number;
}

/** In-process terminal session manager. State is scoped by session/workspace and exposed through tool events. */
export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();

  async open(input: { sessionId: string; workspaceRoot: string; cwd?: string; executable?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }): Promise<ToolResult> {
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
    });
    this.sessions.set(terminalId, terminal);
    return ok({ terminalId, cwd: cwdPath, command: terminal.command, status: terminal.status });
  }

  send(input: { sessionId: string; terminalId: string; text: string; appendNewline?: boolean }, signal: AbortSignal): ToolResult {
    const terminal = this.get(input.sessionId, input.terminalId);
    if (terminal.status !== "running" || terminal.child.stdin.destroyed) return fail("TERMINAL_NOT_RUNNING", "Terminal is not running");
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

  signal(input: { sessionId: string; terminalId: string; signal?: "SIGINT" | "SIGTERM" | "SIGKILL" }): ToolResult {
    const terminal = this.get(input.sessionId, input.terminalId);
    if (terminal.status !== "running") return ok({ terminalId: terminal.terminalId, status: terminal.status });
    const signal = input.signal ?? "SIGINT";
    if (process.platform === "win32") {
      if (signal === "SIGKILL" || signal === "SIGTERM") terminateProcessTree(terminal.child);
      else terminal.child.kill("SIGINT");
    } else {
      try { process.kill(-(terminal.child.pid ?? 0), signal); } catch { terminal.child.kill(signal); }
    }
    return ok({ terminalId: terminal.terminalId, status: "signalled", signal });
  }

  async close(input: { sessionId: string; terminalId: string }): Promise<ToolResult> {
    const terminal = this.get(input.sessionId, input.terminalId);
    if (terminal.status === "running") {
      terminateProcessTree(terminal.child);
      await waitForChildClose(terminal.child, 1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    terminal.status = "closed";
    return ok({ terminalId: terminal.terminalId, status: terminal.status, outputBytes: terminal.totalBytes });
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
      bufferedBytes: Buffer.byteLength(terminal.output, "utf8"),
    };
  }
}

export function createBuiltinTools(options: { readonly terminalManager?: TerminalManager } = {}): readonly ToolDefinition[] {
  const terminals = options.terminalManager ?? new TerminalManager();
  return [
    {
      name: "read_file", description: "Read a UTF-8 text file inside the workspace.", inputSchema: object({ path: string }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const resolver = new WorkspaceResolver(context.workspaceRoot); const target = await resolver.resolveExisting((input as { path: string }).path); const info = await stat(target); if (info.size > MAX_FILE_BYTES) return fail("FILE_TOO_LARGE", `File exceeds ${MAX_FILE_BYTES} bytes`); return ok(await readFile(target, "utf8")); },
    },
    {
      name: "glob", description: "List files under the workspace matching a simple glob.", inputSchema: object({ pattern: string, maxResults: integer(1, 5_000) }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { pattern: string; maxResults?: number }; return ok(await globFiles(context.workspaceRoot, args.pattern, args.maxResults ?? DEFAULT_GLOB_RESULTS)); },
    },
    {
      name: "grep", description: "Search UTF-8 text files under the workspace.", inputSchema: object({ pattern: string, path: string, maxResults: integer(1, 500) }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => ok(await grepFiles(context.workspaceRoot, input as { pattern: string; path?: string; maxResults?: number }, context.signal)),
    },
    {
      name: "edit_file", description: "Replace an exact string in a workspace file and return a diff.", inputSchema: object({ path: string, oldText: string, newText: string }), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => editFile(context.workspaceRoot, input as { path: string; oldText: string; newText: string }),
    },
    {
      name: "write_file", description: "Create a UTF-8 workspace file; overwrites require explicit opt-in and return a diff.", inputSchema: object({ path: string, content: string, overwrite: boolean }), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => writeWorkspaceFile(context.workspaceRoot, input as { path: string; content: string; overwrite?: boolean }),
    },
    {
      name: "git_status", description: "Read git status for the workspace.", inputSchema: object({}), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (_input, context) => gitStatus(context.workspaceRoot, context.signal),
    },
    {
      name: "git_diff", description: "Read the current git diff for the workspace.", inputSchema: object({ staged: boolean }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => runArgv("git", (input as { staged?: boolean }).staged === true ? ["diff", "--cached"] : ["diff"], context.workspaceRoot, context.signal),
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
      name: "terminal_open", description: "Open a persistent terminal process scoped to this session and workspace.", inputSchema: object({ cwd: string, executable: string, args: { type: "array" as const, items: string, maxItems: 32 }, env: { type: "object" as const, additionalProperties: true } }), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => terminals.open({ sessionId: context.sessionId, workspaceRoot: context.workspaceRoot, ...(typeof (input as { cwd?: unknown }).cwd === "string" ? { cwd: (input as { cwd: string }).cwd } : {}), ...(typeof (input as { executable?: unknown }).executable === "string" ? { executable: (input as { executable: string }).executable } : {}), ...((input as { args?: string[] }).args === undefined ? {} : { args: (input as { args: string[] }).args }), ...((input as { env?: Record<string, string> }).env === undefined ? {} : { env: (input as { env: Record<string, string> }).env }) }),
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
      execute: async (input, context) => terminals.close({ sessionId: context.sessionId, terminalId: (input as { terminalId: string }).terminalId }),
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
  ];
}

async function editFile(root: string, args: { path: string; oldText: string; newText: string }): Promise<ToolResult> {
  const resolver = new WorkspaceResolver(root); const target = await resolver.resolveExisting(args.path); const before = await readFile(target, "utf8"); const first = before.indexOf(args.oldText); if (first < 0) return fail("TEXT_NOT_FOUND", "oldText was not found"); if (before.indexOf(args.oldText, first + args.oldText.length) >= 0) return fail("TEXT_NOT_UNIQUE", "oldText occurs more than once"); const after = before.slice(0, first) + args.newText + before.slice(first + args.oldText.length); await writeFile(target, after, "utf8"); return { ok: true, output: { path: args.path }, diff: { path: args.path, before: args.oldText, after: args.newText }, presentation: { kind: "diff", title: `Updated ${args.path}`, data: { before: args.oldText, after: args.newText } } };
}

async function writeWorkspaceFile(root: string, args: { path: string; content: string; overwrite?: boolean }): Promise<ToolResult> {
  const resolver = new WorkspaceResolver(root); const candidate = resolver.resolve(args.path); let before: string | undefined;
  try { await stat(candidate); before = await readFile(await resolver.resolveExisting(args.path), "utf8"); } catch (error) { if (!isMissingPathError(error)) throw error; }
  if (before !== undefined && args.overwrite !== true) return fail("WRITE_TARGET_EXISTS", "Refusing to overwrite an existing file; set overwrite=true or use edit_file");
  await mkdir(path.dirname(candidate), { recursive: true }); const target = await resolver.resolveForWrite(args.path); await writeFile(target, args.content, "utf8");
  return { ...ok({ path: args.path, bytes: Buffer.byteLength(args.content) }), ...(before === undefined ? {} : { diff: { path: args.path, before, after: args.content }, presentation: { kind: "diff" as const, title: `Updated ${args.path}`, data: { before, after: args.content } } }) };
}

async function globFiles(root: string, pattern: string, maxResults: number): Promise<string[]> { const normalized = pattern.replaceAll("\\", "/"); const regex = new RegExp("^" + normalized.split("*").map(escapeRegExp).join(".*") + "$", "u"); const output: string[] = []; await walk(root, root, async (file) => { if (output.length >= maxResults) return; const relative = path.relative(root, file).replaceAll("\\", "/"); if (regex.test(relative)) output.push(relative); }); return output.sort(); }

async function walk(root: string, current: string, visit: (file: string) => Promise<void>): Promise<void> { for (const entry of await readdir(current, { withFileTypes: true })) { const full = path.join(current, entry.name); if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules" && entry.name !== ".agent-trash") await walk(root, full, visit); else if (entry.isFile()) await visit(full); } }

async function grepFiles(root: string, args: { pattern: string; path?: string; maxResults?: number }, signal: AbortSignal): Promise<string[]> { const resolver = new WorkspaceResolver(root); const base = await resolver.resolveExisting(args.path || "."); const info = await stat(base); const files: string[] = []; if (info.isFile()) files.push(base); else await walk(root, base, async (file) => { files.push(file); }); const regex = new RegExp(args.pattern, "u"); const maxResults = args.maxResults ?? 100; const results: string[] = []; for (const file of files) { if (signal.aborted) throw signal.reason ?? new Error("Cancelled"); if ((await stat(file)).size > MAX_SEARCH_FILE_BYTES) continue; const lines = (await readFile(file, "utf8")).split(/\r?\n/u); lines.forEach((line, index) => { if (results.length < maxResults && regex.test(line)) results.push(`${path.relative(root, file).replaceAll("\\", "/")}:${index + 1}:${line}`); }); if (results.length >= maxResults) break; } return results; }

async function gitStatus(cwd: string, signal: AbortSignal): Promise<ToolResult> { const result = await runArgv("git", ["status", "--porcelain=v2", "--branch"], cwd, signal); if (!result.ok || typeof result.output !== "string") return result; const lines = result.output.split(/\r?\n/u).filter(Boolean); const value = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length); const branchAb = value("# branch.ab ")?.match(/^\+(\d+) -(\d+)$/u); return { ...result, output: { branch: { head: value("# branch.head "), oid: value("# branch.oid "), ahead: branchAb === undefined || branchAb === null ? 0 : Number(branchAb[1]), behind: branchAb === undefined || branchAb === null ? 0 : Number(branchAb[2]) }, entries: lines.filter((line) => !line.startsWith("# ")).map((line) => ({ raw: line })) } }; }

async function gitLog(cwd: string, args: { maxCount?: number; path?: string }, signal: AbortSignal): Promise<ToolResult> { const maxCount = Math.min(Math.max(args.maxCount ?? 20, 1), 100); const argv = ["log", "--no-color", `-n${maxCount}`, "--format=%H%x1f%an%x1f%aI%x1f%s%x1e"]; if (args.path !== undefined) argv.push("--", relativeGitPath(cwd, args.path)); const result = await runArgv("git", argv, cwd, signal); if (!result.ok || typeof result.output !== "string") return result; const commits = result.output.split("\x1e").flatMap((record) => { const fields = record.trim().split("\x1f"); return fields.length >= 4 && fields[0] !== undefined && fields[1] !== undefined && fields[2] !== undefined && fields[3] !== undefined ? [{ hash: fields[0], author: fields[1], date: fields[2], subject: fields.slice(3).join("\x1f") }] : []; }); return { ...result, output: { commits, text: result.output } }; }

async function gitShow(cwd: string, args: { ref: string; path?: string }, signal: AbortSignal): Promise<ToolResult> { if (!/^[A-Za-z0-9._/@:~-]+$/u.test(args.ref)) return fail("GIT_REF_INVALID", "Git ref contains unsupported characters"); const argv = ["show", "--no-color", "--no-ext-diff", "--format=fuller", "--stat", "--patch", args.ref]; if (args.path !== undefined) argv.push("--", relativeGitPath(cwd, args.path)); return runArgv("git", argv, cwd, signal); }

function relativeGitPath(cwd: string, value: string): string { const resolver = new WorkspaceResolver(cwd); const absolute = resolver.resolve(value); const relative = path.relative(resolver.rootPath, absolute).replaceAll("\\", "/"); if (relative === "") throw new Error("GIT_PATH_INVALID: path must be inside the workspace"); return relative; }

async function deleteWorkspacePath(root: string, args: { path: string; recursive?: boolean; permanent?: boolean }): Promise<ToolResult> { const resolver = new WorkspaceResolver(root); const candidate = resolver.resolve(args.path); if (candidate === resolver.rootPath) return fail("DELETE_WORKSPACE_ROOT", "Refusing to delete the workspace root"); const existing = await resolver.resolveExisting(args.path); const info = await stat(existing); if (args.permanent === true) { await rm(candidate, { force: false, recursive: args.recursive ?? info.isDirectory() }); return ok({ path: args.path, permanent: true, type: info.isDirectory() ? "directory" : "file" }); } const trashRoot = path.join(resolver.rootPath, ".agent-trash"); await mkdir(trashRoot, { recursive: true }); const trashPath = path.join(trashRoot, `${Date.now()}-${randomUUID()}-${path.basename(candidate)}`); await rename(candidate, trashPath); return ok({ path: args.path, permanent: false, trashedTo: path.relative(resolver.rootPath, trashPath).replaceAll("\\", "/"), type: info.isDirectory() ? "directory" : "file" }); }

function runArgv(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<ToolResult> { return new Promise((resolve) => { const child = spawn(command, args, { cwd, detached: true, shell: false, windowsHide: true }); let output = ""; let stdout = ""; let stderr = ""; let bytes = 0; let truncated = false; const append = (stream: "stdout" | "stderr", chunk: Buffer) => { const text = chunk.toString("utf8"); if (stream === "stdout") stdout += text; else stderr += text; bytes += chunk.byteLength; const currentBytes = Buffer.byteLength(output, "utf8"); if (currentBytes < MAX_PROCESS_OUTPUT_BYTES) output += text.slice(0, MAX_PROCESS_OUTPUT_BYTES - currentBytes); if (bytes > MAX_PROCESS_OUTPUT_BYTES) truncated = true; }; child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk)); child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk)); const abort = () => terminateProcessTree(child); signal.addEventListener("abort", abort, { once: true }); child.on("error", (error) => { signal.removeEventListener("abort", abort); resolve(fail("COMMAND_FAILED", error.message)); }); child.on("close", (code, signalName) => { signal.removeEventListener("abort", abort); const usage = { bytes, truncated }; const audit = { stdout, stderr, exitCode: code, signal: signalName ?? undefined }; if (signal.aborted || signalName) resolve({ ...fail("COMMAND_CANCELLED", "Command was cancelled"), output, audit, usage }); else if (code === 0) resolve({ ...ok(output), audit, usage }); else resolve({ ok: false, output, audit, usage, error: { code: "COMMAND_EXITED", message: `Command exited with code ${code}` }, presentation: { kind: "terminal", title: "Command failed", text: output } }); }); }); }

function terminateProcessTree(child: ChildProcessWithoutNullStreams | ReturnType<typeof spawn>): void { if (child.pid === undefined) { child.kill(); return; } if (process.platform === "win32") { const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false }); killer.unref(); try { child.kill(); } catch { /* taskkill remains the fallback for the process tree */ } } else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } } }
function defaultShell(): string { return process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : (process.env["SHELL"] ?? "/bin/sh"); }
function defaultShellArgs(): string[] { return process.platform === "win32" ? ["/d", "/q"] : ["-i"]; }
function isAllowedExecutable(command: string): boolean { return /^[a-zA-Z0-9._-]+$/u.test(command) && ALLOWED_EXECUTABLES.has(command.toLowerCase()); }
function waitForTerminalOutput(terminal: ManagedTerminal, waitMs: number, signal: AbortSignal): Promise<void> { return new Promise((resolve) => { const started = Date.now(); const timer = setInterval(() => { if (signal.aborted || terminal.readOffset < terminal.output.length || terminal.status !== "running" || Date.now() - started >= waitMs) { clearInterval(timer); resolve(); } }, 25); }); }
function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); return new Promise((resolve) => { let settled = false; const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); }; const timer = setTimeout(finish, timeoutMs); child.once("close", finish); }); }
function isMissingPathError(error: unknown): boolean { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"; }
function ok(output: unknown): ToolResult { return { ok: true, output, presentation: { kind: "tool", title: "Completed" } }; }
function fail(code: string, message: string): ToolResult { return { ok: false, error: { code, message }, presentation: { kind: "tool", title: code, text: message } }; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
