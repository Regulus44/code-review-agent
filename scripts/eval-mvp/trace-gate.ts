import path from "node:path";
import { inspectCommand, type WorkspaceCommandGuardReason, type WorkspaceCommandInspection } from "../../packages/tools/src/workspace-command-guard.ts";

export type TraceStatus = "complete" | "partial" | "missing";
export type BoundaryStatus = "clean" | "blocked" | "contaminated" | "unknown";

export interface TraceEvent {
  readonly sequence: number;
  readonly type: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface BoundaryReference {
  readonly sequence: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly reason: WorkspaceCommandGuardReason;
  readonly offendingValue: string;
  readonly blocked: boolean;
}

export interface TraceGateResult {
  readonly status: TraceStatus;
  readonly boundaryStatus: BoundaryStatus;
  readonly eventCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly turnStarted: boolean;
  readonly sequenceContinuous: boolean;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly unmatchedToolCallIds: readonly string[];
  readonly orphanToolResultIds: readonly string[];
  readonly guardDenials: readonly { readonly toolCallId: string; readonly reason: string }[];
  readonly blockedBoundaryReferences: readonly BoundaryReference[];
  readonly unblockedBoundaryReferences: readonly BoundaryReference[];
  readonly issues: readonly string[];
}

export interface TraceGateInput {
  readonly events: readonly TraceEvent[];
  readonly workspaceRoot: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly turnStatus?: string;
  readonly exportError?: string;
}

const BOUNDARY_REASONS = new Set<WorkspaceCommandGuardReason>([
  "workdir_outside_workspace",
  "external_absolute_path",
  "path_traversal",
  "symlink_escape",
  "dynamic_external_path",
]);

const COMMAND_TOOLS = new Set(["run_command", "run_tests", "pwsh", "bash", "terminal_open", "terminal_send"]);

export async function validateTrace(input: TraceGateInput): Promise<TraceGateResult> {
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const issues: string[] = [];
  if (input.exportError !== undefined) issues.push("event_export_failed");
  if (events.length === 0) {
    return emptyResult(input.exportError === undefined ? ["events_missing"] : issues);
  }

  const firstSequence = events[0]!.sequence;
  const lastSequence = events.at(-1)!.sequence;
  const sequenceContinuous = firstSequence === 1 && events.every((event, index) => event.sequence === index + 1);
  if (!sequenceContinuous) issues.push("event_sequence_not_continuous");

  const calls = new Map<string, TraceEvent[]>();
  const results = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const toolCallId = stringField(event.payload, "toolCallId");
    if (toolCallId === undefined) continue;
    const target = event.type === "tool/call" ? calls : event.type === "tool/result" ? results : undefined;
    if (target === undefined) continue;
    target.set(toolCallId, [...(target.get(toolCallId) ?? []), event]);
  }
  const duplicateCalls = [...calls].filter(([, values]) => values.length !== 1).map(([id]) => id);
  const duplicateResults = [...results].filter(([, values]) => values.length !== 1).map(([id]) => id);
  if (duplicateCalls.length > 0) issues.push("duplicate_tool_calls");
  if (duplicateResults.length > 0) issues.push("duplicate_tool_results");
  const unmatchedToolCallIds = [...calls.keys()].filter((id) => !results.has(id));
  const orphanToolResultIds = [...results.keys()].filter((id) => !calls.has(id));
  if (unmatchedToolCallIds.length > 0) issues.push("unmatched_tool_calls");
  if (orphanToolResultIds.length > 0) issues.push("orphan_tool_results");

  const sessionCreated = events.find((event) => event.type === "session/created");
  if (sessionCreated === undefined) issues.push("session_created_missing");
  else if (!samePath(stringField(sessionCreated.payload, "workspaceRoot"), input.workspaceRoot)) issues.push("session_workspace_mismatch");
  if (input.sessionId !== undefined && events.some((event) => event.sessionId !== undefined && event.sessionId !== input.sessionId)) issues.push("event_session_mismatch");
  for (const callEvents of calls.values()) {
    const callWorkspace = stringField(callEvents[0]!.payload, "workspaceRoot");
    if (callWorkspace !== undefined && !samePath(callWorkspace, input.workspaceRoot)) {
      issues.push("tool_workspace_mismatch");
      break;
    }
  }
  const turnStarted = input.turnId === undefined
    ? events.some((event) => event.type === "turn/started")
    : events.some((event) => event.type === "turn/started" && event.turnId === input.turnId);
  if (input.turnId !== undefined && !turnStarted) issues.push("turn_started_missing");
  if (input.turnId !== undefined && terminalTurn(input.turnStatus) && !events.some((event) => event.type === "turn/ended" && event.turnId === input.turnId)) issues.push("terminal_turn_event_missing");

  const guardDenials: { toolCallId: string; reason: string }[] = [];
  for (const [toolCallId, resultEvents] of results) {
    const guard = guardDenial(resultEvents[0]!);
    if (guard !== undefined) guardDenials.push({ toolCallId, reason: guard });
  }

  const blockedBoundaryReferences: BoundaryReference[] = [];
  const unblockedBoundaryReferences: BoundaryReference[] = [];
  let unknownBoundaryReference = false;
  for (const [toolCallId, callEvents] of calls) {
    const call = callEvents[0]!;
    const toolName = stringField(call.payload, "name") ?? "unknown";
    const inspection = inspectionFor(toolName, call.payload["input"], input.workspaceRoot);
    if (inspection === undefined) continue;
    const decision = await inspectCommand(inspection);
    if (decision.allowed || !BOUNDARY_REASONS.has(decision.reason)) continue;
    const result = results.get(toolCallId)?.[0];
    if (result === undefined) {
      unknownBoundaryReference = true;
      continue;
    }
    const blocked = COMMAND_TOOLS.has(toolName) ? guardDenial(result) !== undefined : result.payload["status"] !== "completed";
    const reference: BoundaryReference = { sequence: call.sequence, toolCallId, toolName, reason: decision.reason, offendingValue: decision.offendingValue, blocked };
    (blocked ? blockedBoundaryReferences : unblockedBoundaryReferences).push(reference);
  }

  let boundaryStatus: BoundaryStatus = "clean";
  if (unblockedBoundaryReferences.length > 0 || issues.includes("tool_workspace_mismatch") || issues.includes("session_workspace_mismatch")) boundaryStatus = "contaminated";
  else if (unknownBoundaryReference) boundaryStatus = "unknown";
  else if (blockedBoundaryReferences.length > 0 || guardDenials.length > 0) boundaryStatus = "blocked";

  const status: TraceStatus = issues.length === 0 ? "complete" : "partial";
  return {
    status,
    boundaryStatus,
    eventCount: events.length,
    firstSequence,
    lastSequence,
    turnStarted,
    sequenceContinuous,
    toolCallCount: [...calls.values()].reduce((count, value) => count + value.length, 0),
    toolResultCount: [...results.values()].reduce((count, value) => count + value.length, 0),
    unmatchedToolCallIds,
    orphanToolResultIds,
    guardDenials,
    blockedBoundaryReferences,
    unblockedBoundaryReferences,
    issues,
  };
}

function inspectionFor(toolName: string, value: unknown, workspaceRoot: string): WorkspaceCommandInspection | undefined {
  if (!isRecord(value)) return undefined;
  const args = stringArray(value["args"]);
  if (toolName === "run_command") return { workspaceRoot, ...(stringField(value, "executable") === undefined ? {} : { executable: stringField(value, "executable") }), args };
  if (toolName === "run_tests") return { workspaceRoot, ...(stringField(value, "command") === undefined ? {} : { executable: stringField(value, "command") }), args };
  if (toolName === "pwsh" || toolName === "bash") return { workspaceRoot, ...(stringField(value, "workdir") === undefined ? {} : { workdir: stringField(value, "workdir") }), ...(stringField(value, "command") === undefined ? {} : { shellCommand: stringField(value, "command") }) };
  if (toolName === "terminal_open") return { workspaceRoot, ...(stringField(value, "cwd") === undefined ? {} : { workdir: stringField(value, "cwd") }), ...(stringField(value, "executable") === undefined ? {} : { executable: stringField(value, "executable") }), args, ...(isStringRecord(value["env"]) ? { env: value["env"] } : {}) };
  if (toolName === "terminal_send") return { workspaceRoot, ...(stringField(value, "text") === undefined ? {} : { shellCommand: stringField(value, "text") }) };
  const pathValue = stringField(value, "path");
  if (["read_file", "grep", "write_file", "edit_file", "delete_file", "git_diff", "git_log", "git_show", "read_image"].includes(toolName) && pathValue !== undefined) return { workspaceRoot, args: [pathValue] };
  return undefined;
}

function guardDenial(event: TraceEvent): string | undefined {
  const result = event.payload["result"];
  if (!isRecord(result)) return undefined;
  const error = result["error"];
  const output = result["output"];
  const code = isRecord(error) ? stringField(error, "code") : undefined;
  if (code !== "WORKSPACE_COMMAND_DENIED" && (!isRecord(output) || stringField(output, "code") !== "WORKSPACE_COMMAND_DENIED")) return undefined;
  return isRecord(output) ? stringField(output, "reason") ?? "workspace_command_denied" : "workspace_command_denied";
}

function emptyResult(issues: readonly string[]): TraceGateResult {
  return { status: "missing", boundaryStatus: "unknown", eventCount: 0, firstSequence: 0, lastSequence: 0, turnStarted: false, sequenceContinuous: false, toolCallCount: 0, toolResultCount: 0, unmatchedToolCallIds: [], orphanToolResultIds: [], guardDenials: [], blockedBoundaryReferences: [], unblockedBoundaryReferences: [], issues };
}

function terminalTurn(value: string | undefined): boolean {
  return value !== undefined && ["completed", "failed", "stopped", "interrupted"].includes(value);
}

function samePath(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  return process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
