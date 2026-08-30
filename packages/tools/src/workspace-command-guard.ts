import type { ToolResult } from "@code-review-agent/contracts";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WorkspaceCommandGuardReason =
  | "workdir_outside_workspace"
  | "external_absolute_path"
  | "path_traversal"
  | "symlink_escape"
  | "dynamic_external_path"
  | "inline_code"
  | "nested_shell"
  | "dynamic_execution"
  | "environment_enumeration";

export type WorkspaceCommandDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: "WORKSPACE_COMMAND_DENIED";
      readonly reason: WorkspaceCommandGuardReason;
      readonly message: string;
      readonly workspaceRoot: string;
      readonly offendingValue: string;
    };

export interface WorkspaceCommandInspection {
  readonly workspaceRoot: string;
  readonly workdir?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly shellCommand?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const DYNAMIC_EXTERNAL_PATH = /(?:\$env:(?:userprofile|home|temp|tmp)\b|\$(?:home|userprofile)\b|%(?:userprofile|home|temp|tmp)%|~[\\/])/iu;
const ENVIRONMENT_ENUMERATION = /(?:\b(?:get-childitem|gci|dir|get-item|gi)\s+(?:env:|\$env:)|\bget-psdrive\b|\bcmd(?:\.exe)?\s+\/c\s+set\b)/iu;
const DYNAMIC_EXECUTION = /(?:\bstart-process\b|\binvoke-expression\b|(?:^|[\s;|&])iex(?:\s|$)|\[\s*system\.diagnostics\.process\s*\])/iu;
const NESTED_SHELL = /(?:^|[;|&]\s*|\s)(?:cmd(?:\.exe)?\s+\/[ck]|powershell(?:\.exe)?\s+(?:-command|-encodedcommand)|pwsh(?:\.exe)?\s+(?:-command|-encodedcommand))\b/iu;
const INLINE_SHELL_CODE = /(?:^|[;|&]\s*|\s)(?:python(?:\d+(?:\.\d+)*)?|node(?:\.exe)?)\s+(?:-c|-e|--eval)\b/iu;
const WINDOWS_ABSOLUTE_PATH = /[A-Za-z]:[\\/][^\s'"`;|<>]*/gu;
const UNC_PATH = /\\\\[^\s'"`;|<>]+/gu;
const FILE_URL = /file:\/\/\/[^\s'"`;|<>]+/giu;

export async function inspectCommand(input: WorkspaceCommandInspection): Promise<WorkspaceCommandDecision> {
  const root = path.resolve(input.workspaceRoot);
  const rootReal = await realpath(root).catch(() => root);
  const workdir = input.workdir === undefined ? root : resolveCandidate(root, input.workdir);
  const workdirDecision = await inspectResolvedPath(root, rootReal, root, workdir, input.workdir ?? root, "workdir_outside_workspace");
  if (!workdirDecision.allowed) return workdirDecision;

  const executable = input.executable?.trim();
  const args = input.args ?? [];
  const executableName = executable === undefined ? "" : path.basename(executable).toLowerCase();
  if (isCmdExecutable(executableName)) return denied(root, "nested_shell", executable ?? "cmd.exe", "CMD executables are not supported; use pwsh or an argv tool.");
  if ((isPythonExecutable(executableName) && args.some((arg) => arg.toLowerCase() === "-c"))
    || (isNodeExecutable(executableName) && args.some((arg) => ["-e", "--eval"].includes(arg.toLowerCase())))) {
    return denied(root, "inline_code", `${executable} ${args.find((arg) => ["-c", "-e", "--eval"].includes(arg.toLowerCase())) ?? ""}`.trim(), "Inline code execution is disabled for workspace-scoped commands.");
  }

  if (executable !== undefined && isExplicitPath(executable, root)) {
    const decision = await inspectPathValue(root, rootReal, workdir, executable);
    if (!decision.allowed) return decision;
  }

  const shellCommand = input.shellCommand ?? "";
  if (shellCommand.length > 0) {
    if (INLINE_SHELL_CODE.test(shellCommand)) return denied(root, "inline_code", matchingExcerpt(shellCommand, INLINE_SHELL_CODE), "Inline Python or Node code is disabled for workspace-scoped commands.");
    if (NESTED_SHELL.test(shellCommand)) return denied(root, "nested_shell", matchingExcerpt(shellCommand, NESTED_SHELL), "Nested shells are disabled for workspace-scoped commands.");
    if (DYNAMIC_EXECUTION.test(shellCommand)) return denied(root, "dynamic_execution", matchingExcerpt(shellCommand, DYNAMIC_EXECUTION), "Dynamic process execution is disabled for workspace-scoped commands.");
    if (ENVIRONMENT_ENUMERATION.test(shellCommand)) return denied(root, "environment_enumeration", matchingExcerpt(shellCommand, ENVIRONMENT_ENUMERATION), "Environment and drive enumeration is disabled for workspace-scoped commands.");
  }

  const values = [
    ...args,
    shellCommand,
  ].filter((value) => value.length > 0);
  for (const value of values) {
    if (DYNAMIC_EXTERNAL_PATH.test(value)) return denied(root, "dynamic_external_path", matchingExcerpt(value, DYNAMIC_EXTERNAL_PATH), "Dynamic user or temporary-directory paths are outside the active workspace boundary.");
    for (const candidate of pathCandidates(value, root)) {
      const decision = await inspectPathValue(root, rootReal, workdir, candidate);
      if (!decision.allowed) return decision;
    }
  }
  for (const [name, value] of Object.entries(input.env ?? {})) {
    const label = `env:${name}`;
    if (DYNAMIC_EXTERNAL_PATH.test(value)) return denied(root, "dynamic_external_path", label, "Dynamic user or temporary-directory paths are outside the active workspace boundary.");
    for (const candidate of pathCandidates(value, root)) {
      const decision = await inspectPathValue(root, rootReal, workdir, candidate);
      if (!decision.allowed) return { ...decision, offendingValue: label };
    }
  }
  return { allowed: true };
}

export function workspaceCommandDeniedResult(decision: Exclude<WorkspaceCommandDecision, { readonly allowed: true }>): ToolResult {
  const output = {
    code: decision.code,
    reason: decision.reason,
    workspaceRoot: decision.workspaceRoot,
    offendingValue: decision.offendingValue,
  };
  const remedy = "Use workspace-relative paths and rely only on the active repository and its command output.";
  return {
    ok: false,
    output,
    error: { code: decision.code, message: decision.message, remedy },
    presentation: { kind: "terminal", title: decision.code, text: `${decision.message}\n${remedy}`, data: output },
  };
}

async function inspectPathValue(root: string, rootReal: string, workdir: string, rawValue: string): Promise<WorkspaceCommandDecision> {
  const normalized = normalizePathToken(rawValue);
  if (normalized.length === 0 || looksLikeNonFileUrl(normalized)) return { allowed: true };
  if (hasTraversal(normalized)) return denied(root, "path_traversal", rawValue, "Parent-directory traversal is outside the active workspace boundary.");
  const resolved = resolveCandidate(workdir, normalized);
  const lexical = await inspectResolvedPath(root, rootReal, workdir, resolved, rawValue, "external_absolute_path");
  if (!lexical.allowed) return lexical;
  const existing = await closestExistingRealPath(resolved, root);
  if (existing !== undefined && !isInside(rootReal, existing)) return denied(root, "symlink_escape", rawValue, "Path resolves through a link outside the active workspace.");
  return { allowed: true };
}

async function inspectResolvedPath(
  root: string,
  rootReal: string,
  _workdir: string,
  resolved: string,
  offendingValue: string,
  reason: "workdir_outside_workspace" | "external_absolute_path",
): Promise<WorkspaceCommandDecision> {
  if (!isInside(root, resolved)) {
    return denied(root, reason, offendingValue, reason === "workdir_outside_workspace" ? "Command workdir is outside the active workspace." : "Command references a path outside the active workspace.");
  }
  const actual = await realpath(resolved).catch(() => undefined);
  if (actual !== undefined && !isInside(rootReal, actual)) return denied(root, "symlink_escape", offendingValue, "Path resolves through a link outside the active workspace.");
  return { allowed: true };
}

function pathCandidates(value: string, root: string): readonly string[] {
  const candidates = new Set<string>();
  for (const match of value.matchAll(/(['"])(.*?)\1/gu)) addPathCandidate(candidates, match[2] ?? "", root);
  for (const match of value.matchAll(WINDOWS_ABSOLUTE_PATH)) addPathCandidate(candidates, match[0], root);
  for (const match of value.matchAll(UNC_PATH)) addPathCandidate(candidates, match[0], root);
  for (const match of value.matchAll(FILE_URL)) addPathCandidate(candidates, match[0], root);
  for (const token of value.split(/[\s;|><(),]+/u)) addPathCandidate(candidates, token, root);
  return [...candidates];
}

function addPathCandidate(candidates: Set<string>, rawToken: string, root: string): void {
  let token = rawToken.trim().replace(/^[`'"=]+|[`'",;]+$/gu, "");
  const assignment = token.indexOf("=");
  if (assignment > 0 && !/^[A-Za-z]:[\\/]/u.test(token)) token = token.slice(assignment + 1);
  if (token.length === 0 || looksLikeNonFileUrl(token) || isCommandSwitch(token)) return;
  if (token.startsWith("file:///")) {
    try { token = fileURLToPath(token); } catch { return; }
  }
  token = token.replace(/::[^\\/]*$/u, "").replace(/[\]})]+$/u, "");
  if (isExplicitPath(token, root) || hasTraversal(token) || token.startsWith(".") || token.includes("/") || token.includes("\\")) candidates.add(token);
}

function normalizePathToken(value: string): string {
  let token = value.trim().replace(/^['"]|['"]$/gu, "").replace(/::[^\\/]*$/u, "");
  if (token.startsWith("file:///")) {
    try { token = fileURLToPath(token); } catch { return ""; }
  }
  const wildcard = token.search(/[?*[]/u);
  if (wildcard >= 0) token = token.slice(0, wildcard);
  return token.replace(/[\]})]+$/u, "");
}

function resolveCandidate(base: string, candidate: string): string {
  if (/^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith("\\\\")) return path.win32.resolve(candidate);
  if (looksWindowsPath(base)) return path.win32.resolve(base, candidate.replaceAll("/", "\\"));
  return path.resolve(base, candidate);
}

function isInside(root: string, candidate: string): boolean {
  const api = looksWindowsPath(root) ? path.win32 : path;
  const relative = api.relative(api.resolve(root), api.resolve(candidate));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

async function closestExistingRealPath(candidate: string, root: string): Promise<string | undefined> {
  const api = looksWindowsPath(root) ? path.win32 : path;
  let current = candidate;
  while (isInside(root, current)) {
    try {
      await access(current);
      return await realpath(current);
    } catch {
      const parent = api.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  return undefined;
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((part) => part === "..");
}

function isExplicitPath(value: string, root: string): boolean {
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("file:///")) return true;
  return !looksWindowsPath(root) && value.startsWith("/");
}

function looksWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function looksLikeNonFileUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) && !value.toLowerCase().startsWith("file://");
}

function isCommandSwitch(value: string): boolean {
  return /^-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value) || /^\/[A-Za-z?]+$/u.test(value);
}

function isPythonExecutable(value: string): boolean {
  return /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/u.test(value);
}

function isNodeExecutable(value: string): boolean {
  return /^node(?:\.exe)?$/u.test(value);
}

function isCmdExecutable(value: string): boolean {
  return value === "cmd" || value === "cmd.exe";
}

function denied(root: string, reason: WorkspaceCommandGuardReason, offendingValue: string, message: string): WorkspaceCommandDecision {
  return { allowed: false, code: "WORKSPACE_COMMAND_DENIED", reason, message, workspaceRoot: root, offendingValue: offendingValue.slice(0, 512) };
}

function matchingExcerpt(value: string, pattern: RegExp): string {
  pattern.lastIndex = 0;
  return (value.match(pattern)?.[0] ?? value).trim().slice(0, 512);
}
