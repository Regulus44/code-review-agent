import type { ToolDefinition, ToolResult } from "@code-review-agent/contracts";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { WorkspaceResolver } from "@code-review-agent/workspace";

const ALLOWED_EXECUTABLES = new Set(["git", "node", "npm", "pnpm", "vitest"]);
const MAX_PROCESS_OUTPUT_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1 * 1024 * 1024;
const DEFAULT_GLOB_RESULTS = 1_000;

const object = (properties: Record<string, any>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const string = { type: "string" as const };

export function createBuiltinTools(): readonly ToolDefinition[] {
  return [
    {
      name: "read_file", description: "Read a UTF-8 text file inside the workspace.", inputSchema: object({ path: string }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const resolver = new WorkspaceResolver(context.workspaceRoot); const target = await resolver.resolveExisting((input as { path: string }).path); const info = await stat(target); if (info.size > MAX_FILE_BYTES) return fail("FILE_TOO_LARGE", `File exceeds ${MAX_FILE_BYTES} bytes`); const value = await readFile(target, "utf8"); return ok(value); },
    },
    {
      name: "glob", description: "List files under the workspace matching a simple glob.", inputSchema: object({ pattern: string, maxResults: { type: "integer" as const, minimum: 1, maximum: 5_000 } }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { pattern: string; maxResults?: number }; return ok(await globFiles(context.workspaceRoot, args.pattern, args.maxResults ?? DEFAULT_GLOB_RESULTS)); },
    },
    {
      name: "grep", description: "Search UTF-8 text files under the workspace.", inputSchema: object({ pattern: string, path: { type: "string" as const }, maxResults: { type: "integer" as const, minimum: 1, maximum: 500 } }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => ok(await grepFiles(context.workspaceRoot, input as { pattern: string; path: string; maxResults: number }, context.signal)),
    },
    {
      name: "edit_file", description: "Replace an exact string in a workspace file and return a diff.", inputSchema: object({ path: string, oldText: string, newText: string }), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => editFile(context.workspaceRoot, input as { path: string; oldText: string; newText: string }),
    },
    {
      name: "write_file", description: "Create a UTF-8 workspace file; overwrites require explicit opt-in and return a diff.", inputSchema: object({ path: string, content: string, overwrite: { type: "boolean" as const } }), executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { path: string; content: string; overwrite?: boolean }; const resolver = new WorkspaceResolver(context.workspaceRoot); const candidate = resolver.resolve(args.path); let before: string | undefined; try { await stat(candidate); const existing = await resolver.resolveExisting(args.path); before = await readFile(existing, "utf8"); } catch (error) { if (!isMissingPathError(error)) throw error; } if (before !== undefined && args.overwrite !== true) return fail("WRITE_TARGET_EXISTS", "Refusing to overwrite an existing file; set overwrite=true or use edit_file"); await mkdir(path.dirname(candidate), { recursive: true }); const target = await resolver.resolveForWrite(args.path); await writeFile(target, args.content, "utf8"); return { ...ok({ path: args.path, bytes: Buffer.byteLength(args.content) }), ...(before === undefined ? {} : { diff: { path: args.path, before, after: args.content }, presentation: { kind: "diff" as const, title: `Updated ${args.path}`, data: { before, after: args.content } } }) }; },
    },
    {
      name: "git_status", description: "Read git status for the workspace.", inputSchema: object({}), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (_input, context) => gitStatus(context.workspaceRoot, context.signal),
    },
    {
      name: "git_diff", description: "Read the current git diff for the workspace.", inputSchema: object({ staged: { type: "boolean" as const } }), executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel",
      execute: async (input, context) => runArgv("git", (input as { staged: boolean }).staged ? ["diff", "--cached"] : ["diff"], context.workspaceRoot, context.signal),
    },
    {
      name: "run_command", description: "Run an allowlisted executable with argv inside the workspace.", inputSchema: object({ executable: string, args: { type: "array" as const, items: string, maxItems: 32 } }, ["executable"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { executable: string; args?: string[] }; if (!isAllowedExecutable(args.executable)) return fail("COMMAND_NOT_ALLOWED", "Executable is not on the allowlist"); return runArgv(args.executable, args.args ?? [], context.workspaceRoot, context.signal); },
    },
    {
      name: "run_tests", description: "Run the repository test command using argv.", inputSchema: object({ command: { type: "string" as const }, args: { type: "array" as const, items: string, maxItems: 32 } }, ["command"]), executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel",
      execute: async (input, context) => { const args = input as { command: string; args?: string[] }; if (!isAllowedExecutable(args.command)) return fail("COMMAND_NOT_ALLOWED", "Test command is not on the allowlist"); return runArgv(args.command, args.args ?? [], context.workspaceRoot, context.signal); },
    },
  ];
}

async function editFile(root: string, args: { path: string; oldText: string; newText: string }): Promise<ToolResult> {
  const resolver = new WorkspaceResolver(root); const target = await resolver.resolveExisting(args.path); const before = await readFile(target, "utf8"); const first = before.indexOf(args.oldText); if (first < 0) return fail("TEXT_NOT_FOUND", "oldText was not found"); if (before.indexOf(args.oldText, first + args.oldText.length) >= 0) return fail("TEXT_NOT_UNIQUE", "oldText occurs more than once"); const after = before.slice(0, first) + args.newText + before.slice(first + args.oldText.length); await writeFile(target, after, "utf8"); return { ok: true, output: { path: args.path }, diff: { path: args.path, before: args.oldText, after: args.newText }, presentation: { kind: "diff", title: `Updated ${args.path}`, data: { before: args.oldText, after: args.newText } } };
}

async function globFiles(root: string, pattern: string, maxResults: number): Promise<string[]> { const normalized = pattern.replaceAll("\\", "/"); const regex = new RegExp("^" + normalized.split("*").map(escapeRegExp).join(".*") + "$", "u"); const output: string[] = []; await walk(root, root, async (file) => { if (output.length >= maxResults) return; const relative = path.relative(root, file).replaceAll("\\", "/"); if (regex.test(relative)) output.push(relative); }); return output.sort(); }
async function walk(root: string, current: string, visit: (file: string) => Promise<void>): Promise<void> { for (const entry of await readdir(current, { withFileTypes: true })) { const full = path.join(current, entry.name); if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") await walk(root, full, visit); else if (entry.isFile()) await visit(full); } }
async function grepFiles(root: string, args: { pattern: string; path?: string; maxResults?: number }, signal: AbortSignal): Promise<string[]> { const resolver = new WorkspaceResolver(root); const base = await resolver.resolveExisting(args.path || "."); const info = await stat(base); const files: string[] = []; if (info.isFile()) files.push(base); else await walk(root, base, async (file) => { files.push(file); }); const regex = new RegExp(args.pattern, "u"); const maxResults = args.maxResults ?? 100; const results: string[] = []; for (const file of files) { if (signal.aborted) throw signal.reason ?? new Error("Cancelled"); if ((await stat(file)).size > MAX_SEARCH_FILE_BYTES) continue; const lines = (await readFile(file, "utf8")).split(/\r?\n/u); lines.forEach((line, index) => { if (results.length < maxResults && regex.test(line)) results.push(`${path.relative(root, file).replaceAll("\\", "/")}:${index + 1}:${line}`); }); if (results.length >= maxResults) break; } return results; }
async function gitStatus(cwd: string, signal: AbortSignal): Promise<ToolResult> { const result = await runArgv("git", ["status", "--porcelain=v2", "--branch"], cwd, signal); if (!result.ok || typeof result.output !== "string") return result; const lines = result.output.split(/\r?\n/u).filter(Boolean); const value = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length); const branchAb = value("# branch.ab ")?.match(/^\+(\d+) -(\d+)$/u); return { ...result, output: { branch: { head: value("# branch.head "), oid: value("# branch.oid "), ahead: branchAb == null ? 0 : Number(branchAb[1]), behind: branchAb == null ? 0 : Number(branchAb[2]) }, entries: lines.filter((line) => !line.startsWith("# ")).map((line) => ({ raw: line })) } }; }
function runArgv(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<ToolResult> { return new Promise((resolve) => { const child = spawn(command, args, { cwd, detached: true, shell: false, windowsHide: true }); let output = ""; let stdout = ""; let stderr = ""; let bytes = 0; let truncated = false; const append = (stream: "stdout" | "stderr", chunk: Buffer) => { const text = chunk.toString("utf8"); if (stream === "stdout") stdout += text; else stderr += text; bytes += chunk.byteLength; const currentBytes = Buffer.byteLength(output, "utf8"); if (currentBytes < MAX_PROCESS_OUTPUT_BYTES) output += text.slice(0, MAX_PROCESS_OUTPUT_BYTES - currentBytes); if (bytes > MAX_PROCESS_OUTPUT_BYTES) truncated = true; }; child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk)); child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk)); const abort = () => { terminateProcessTree(child); }; signal.addEventListener("abort", abort, { once: true }); child.on("error", (error) => { signal.removeEventListener("abort", abort); resolve(fail("COMMAND_FAILED", error.message)); }); child.on("close", (code, signalName) => { signal.removeEventListener("abort", abort); const usage = { bytes, truncated }; const audit = { stdout, stderr, exitCode: code, signal: signalName ?? undefined }; if (signal.aborted || signalName) resolve({ ...fail("COMMAND_CANCELLED", "Command was cancelled"), output, audit, usage }); else if (code === 0) resolve({ ...ok(output), audit, usage }); else resolve({ ok: false, output, audit, usage, error: { code: "COMMAND_EXITED", message: `Command exited with code ${code}` }, presentation: { kind: "terminal", title: "Command failed", text: output } }); }); }); }
function terminateProcessTree(child: ReturnType<typeof spawn>): void { if (child.pid === undefined) { child.kill(); return; } if (process.platform === "win32") { const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false }); killer.unref(); } else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } } }
function isMissingPathError(error: unknown): boolean { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"; }
function isAllowedExecutable(command: string): boolean { return /^[a-zA-Z0-9._-]+$/u.test(command) && ALLOWED_EXECUTABLES.has(command.toLowerCase()); }
function ok(output: unknown): ToolResult { return { ok: true, output, presentation: { kind: "tool", title: "Completed" } }; }
function fail(code: string, message: string): ToolResult { return { ok: false, error: { code, message }, presentation: { kind: "tool", title: code, text: message } }; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
