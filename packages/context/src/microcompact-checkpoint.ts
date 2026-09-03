import type { AgentEvent, ChatMessage } from "@coding-agent/contracts";

export const MICROCOMPACT_CHECKPOINT_ALGORITHM = "pressure-v2.m1" as const;
export const DEFAULT_MICROCOMPACT_CHECKPOINT_MAX_CHARS = 8_192;

export interface MicrocompactCheckpoint {
  readonly version: 1;
  readonly checkpointId: string;
  readonly sourceSequenceStart: number;
  readonly sourceSequenceEnd: number;
  readonly coveredToolCallIds: readonly string[];
  readonly primaryRequest: string;
  readonly filesRead: readonly string[];
  readonly filesChanged: readonly string[];
  readonly verifiedFindings: readonly string[];
  readonly testsRun: readonly string[];
  readonly pendingWork: readonly string[];
  readonly nextStep: string;
  readonly generatedBy: "deterministic";
  readonly algorithmVersion: typeof MICROCOMPACT_CHECKPOINT_ALGORITHM;
  readonly maxChars: number;
}

export interface BuildMicrocompactCheckpointOptions {
  readonly events: readonly AgentEvent[];
  readonly messages: readonly ChatMessage[];
  readonly checkpointId: string;
  readonly maxChars?: number;
  readonly sourceSequenceStart?: number;
  readonly sourceSequenceEnd?: number;
}

/** Build a bounded, deterministic handoff without persisting tool output bodies. */
export function buildMicrocompactCheckpoint(options: BuildMicrocompactCheckpointOptions): MicrocompactCheckpoint {
  const maxChars = boundedMaxChars(options.maxChars);
  const relevant = options.events.filter((event) => event.type === "tool/call" || event.type === "tool/result" || event.type === "diff/preview" || event.type === "user/message" || event.type === "assistant/message" || event.type === "step/ended");
  const sequences = relevant.map((event) => event.sequence);
  const sourceSequenceStart = options.sourceSequenceStart ?? (sequences.length === 0 ? 0 : Math.min(...sequences));
  const sourceSequenceEnd = options.sourceSequenceEnd ?? (sequences.length === 0 ? sourceSequenceStart : Math.max(...sequences));
  const calls = relevant.filter((event) => event.type === "tool/call");
  const results = relevant.filter((event) => event.type === "tool/result");
  const coveredToolCallIds = unique(calls.map((event) => stringValue(event.payload["toolCallId"])).filter(Boolean));
  const filesRead = unique(calls.filter((event) => ["read_file", "grep", "glob", "web_fetch", "web_search"].includes(stringValue(event.payload["name"]))).flatMap((event) => extractPaths(event.payload["input"])));
  const filesChanged = unique(calls.filter((event) => ["edit_file", "write_file", "apply_patch"].includes(stringValue(event.payload["name"]))).flatMap((event) => extractPaths(event.payload["input"])));
  const testsRun = unique(calls.filter((event) => ["run_tests", "run_command", "bash", "pwsh"].includes(stringValue(event.payload["name"]))).map((event) => summarizeCommand(event.payload["input"])) .filter(Boolean));
  const verifiedFindings = unique(results.filter((event) => successResult(event.payload["result"])).map(() => "Tool result completed successfully."));
  const primaryRequest = latestUserRequest(options.messages);
  const pendingWork = options.messages.some((message) => message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) ? ["(unknown)"] : [];
  const nextStep = filesChanged.length > 0 ? "Run targeted tests and review the resulting diff." : "Continue from the latest verified tool result.";
  return {
    version: 1,
    checkpointId: options.checkpointId,
    sourceSequenceStart,
    sourceSequenceEnd,
    coveredToolCallIds: coveredToolCallIds.slice(0, 256),
    primaryRequest: boundText(primaryRequest || "(unknown)", maxChars),
    filesRead: filesRead.slice(0, 128),
    filesChanged: filesChanged.slice(0, 128),
    verifiedFindings: verifiedFindings.slice(0, 64),
    testsRun: testsRun.slice(0, 64),
    pendingWork: pendingWork.slice(0, 32),
    nextStep: boundText(nextStep, 512),
    generatedBy: "deterministic",
    algorithmVersion: MICROCOMPACT_CHECKPOINT_ALGORITHM,
    maxChars,
  };
}

export function validateMicrocompactCheckpoint(checkpoint: MicrocompactCheckpoint): void {
  if (checkpoint.version !== 1 || checkpoint.algorithmVersion !== MICROCOMPACT_CHECKPOINT_ALGORITHM || checkpoint.generatedBy !== "deterministic") throw new Error("CHECKPOINT_SCHEMA_INVALID");
  if (!checkpoint.checkpointId || checkpoint.checkpointId.length > 128) throw new Error("CHECKPOINT_ID_INVALID");
  if (checkpoint.sourceSequenceStart < 0 || checkpoint.sourceSequenceEnd < checkpoint.sourceSequenceStart) throw new Error("CHECKPOINT_SEQUENCE_INVALID");
  const totalChars = JSON.stringify(checkpoint).length;
  if (totalChars > checkpoint.maxChars) throw new Error("CHECKPOINT_TOO_LARGE");
}

function latestUserRequest(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

function extractPaths(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (item: unknown, key?: string): void => {
    if (typeof item === "string") {
      if (key && /path|file|filename|target/i.test(key)) {
        const normalized = item.replace(/^[A-Za-z]:[\\/]+/, "").replace(/^[\\/]+/, "").replace(/\\/g, "/");
        if (normalized && !normalized.includes("..")) paths.push(normalized.slice(0, 240));
      }
      return;
    }
    if (Array.isArray(item)) { for (const child of item.slice(0, 64)) visit(child, key); return; }
    if (typeof item === "object" && item !== null) for (const [childKey, child] of Object.entries(item).slice(0, 64)) visit(child, childKey);
  };
  visit(value);
  return paths;
}

function summarizeCommand(value: unknown): string {
  if (typeof value === "string") return boundText(value, 240);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const command = record["command"] ?? record["cmd"] ?? record["args"];
    if (typeof command === "string") return boundText(command, 240);
    if (Array.isArray(command)) return boundText(command.filter((item): item is string => typeof item === "string").join(" "), 240);
  }
  return "";
}

function successResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record["ok"] === true || record["status"] === "completed" || record["status"] === "succeeded";
}

function unique(values: readonly string[]): string[] { return [...new Set(values.filter((value) => value.length > 0))]; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function boundedMaxChars(value: number | undefined): number { return typeof value === "number" && Number.isFinite(value) && value >= 512 ? Math.floor(value) : DEFAULT_MICROCOMPACT_CHECKPOINT_MAX_CHARS; }
function boundText(value: string, maxChars: number): string { return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, maxChars); }
