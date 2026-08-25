import type { ToolCallView } from "../projection/conversation.js";
import { presentBoundedValue } from "./safe-value.js";

export type ToolPresentationKind = "builtin" | "mcp" | "subagent" | "diff" | "terminal" | "generic";
export type ToolRowVariant = "search" | "read" | "bash" | "write" | "edit" | "code" | "others";
export type ToolRowState = "running" | "ok" | "error" | "stopped";

export interface ToolRenderIntent {
  readonly kind: ToolPresentationKind;
  readonly variant: ToolRowVariant;
  readonly title: string;
  readonly sourceLabel: string;
  /** Human-readable target shown in the collapsed row. */
  readonly summary: string;
  readonly status: ToolCallView["status"];
  readonly statusLabel: string;
  readonly state: ToolRowState;
  readonly riskLevel: ToolCallView["riskLevel"];
  readonly details: string;
  readonly input: string | null;
  readonly output: string | null;
  readonly errorSummary: string | null;
  readonly filePath?: string;
  readonly truncated: boolean;
  readonly untrusted: boolean;
  readonly collapsedByDefault: boolean;
}

export interface ToolPresenterOptions {
  readonly maxDetailChars?: number;
}

/**
 * Convert a ToolCallView into render intent. The presenter never executes a
 * tool or upgrades trust; risk/status remain host-provided and unknown output
 * is rendered through a bounded, redacted generic fallback.
 */
export function presentToolCall(tool: ToolCallView, options: ToolPresenterOptions = {}): ToolRenderIntent {
  const kind = classifyTool(tool.name);
  const variant = classifyRowVariant(tool.name);
  const sourceLabel = sourceLabelFor(tool.name, kind);
  const presentedTitle = presentationTitle(tool);
  const title = presentedTitle !== undefined && presentedTitle !== tool.name ? presentedTitle : variantTitle(variant);
  const inputValue = tool.input === undefined ? null : tool.input;
  const outputValue = tool.result === undefined ? null : resultModelView(tool.result) ?? tool.result;
  const input = inputValue === null ? null : presentToolValue(inputValue, options.maxDetailChars ?? 8_000).text;
  const output = outputValue === null ? null : presentToolValue(outputValue, options.maxDetailChars ?? 8_000).text;
  const detailValue = outputValue ?? inputValue ?? (tool.progress?.length ? tool.progress : {});
  const bounded = presentToolValue(detailValue, options.maxDetailChars ?? 8_000);
  const summary = deriveSummary(tool.name, variant, inputValue);
  const state = rowState(tool.status);
  const errorSummary = state === "error" && output !== null ? firstLine(output) : null;
  const filePath = filePathFor(variant, inputValue);
  return {
    kind,
    variant,
    title,
    sourceLabel,
    summary,
    status: tool.status,
    statusLabel: statusLabel(tool.status),
    state,
    riskLevel: tool.riskLevel,
    details: bounded.text,
    input,
    output,
    errorSummary,
    ...(filePath === undefined ? {} : { filePath }),
    truncated: bounded.truncated,
    untrusted: bounded.untrusted,
    collapsedByDefault: true,
  };
}

function presentToolValue(value: unknown, maxChars: number) {
  if (typeof value === "string") {
    const bounded = presentBoundedValue(value, maxChars);
    return { ...bounded, text: bounded.text.replace(/^"|"$/g, "") };
  }
  return presentBoundedValue(value, maxChars);
}

function classifyTool(name: string): ToolPresentationKind {
  if (name.startsWith("mcp__")) return "mcp";
  if (/subagent|agent/i.test(name)) return "subagent";
  if (/diff|patch/i.test(name)) return "diff";
  if (/terminal|command|job/i.test(name)) return "terminal";
  if (name.length > 0) return "builtin";
  return "generic";
}

function sourceLabelFor(name: string, kind: ToolPresentationKind): string {
  if (kind === "mcp") {
    const parts = name.split("__");
    return parts.length >= 3 ? `MCP · ${parts[1]} · ${parts.slice(2).join("__")}` : "MCP";
  }
  if (kind === "subagent") return "Subagent";
  if (kind === "diff") return "Diff/Patch";
  if (kind === "terminal") return "Terminal/Job";
  return kind === "builtin" ? "Tool" : "Event";
}

function presentationTitle(tool: ToolCallView): string | undefined {
  if (typeof tool.presentation !== "object" || tool.presentation === null) return undefined;
  const title = (tool.presentation as Record<string, unknown>)["title"];
  return typeof title === "string" && title.length > 0 ? title : undefined;
}

function resultModelView(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const modelView = (value as Record<string, unknown>)["modelView"];
  return modelView === undefined ? undefined : modelView;
}

function statusLabel(status: ToolCallView["status"]): string {
  switch (status) {
    case "pending":
    case "running": return "Running";
    case "awaiting_permission": return "Needs approval";
    case "completed": return "Completed";
    case "failed":
    case "denied": return "Failed";
    case "cancelled": return "Stopped";
    default: return status.replace(/_/g, " ");
  }
}

function rowState(status: ToolCallView["status"]): ToolRowState {
  if (status === "pending" || status === "running" || status === "awaiting_permission") return "running";
  if (status === "failed" || status === "denied") return "error";
  if (status === "cancelled") return "stopped";
  return "ok";
}

function classifyRowVariant(name: string): ToolRowVariant {
  const value = name.toLowerCase();
  if (/grep|glob|search|find/.test(value)) return "search";
  if (/read|cat|fetch|inspect/.test(value)) return "read";
  if (/bash|pwsh|shell|terminal|command|job|exec/.test(value)) return "bash";
  if (/write|create_file/.test(value)) return "write";
  if (/edit|patch|apply/.test(value)) return "edit";
  if (/code|python|javascript|typescript/.test(value)) return "code";
  return "others";
}

function variantTitle(variant: ToolRowVariant): string {
  switch (variant) {
    case "search": return "Search";
    case "read": return "Read";
    case "bash": return "Bash";
    case "write": return "Write";
    case "edit": return "Edit";
    case "code": return "Code";
    default: return "Tool call";
  }
}

function deriveSummary(name: string, variant: ToolRowVariant, input: unknown): string {
  const record = asRecord(input);
  const keys = variant === "search"
    ? ["query", "pattern", "path", "url"]
    : variant === "read" || variant === "write" || variant === "edit"
      ? ["path", "file_path", "url"]
      : variant === "bash"
        ? ["description", "command", "cmd"]
        : variant === "code"
          ? ["description", "language"]
          : ["description", "target", "name", "id"];
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) return firstLine(value.trim());
  }
  if (record) {
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value.trim().length > 0) return firstLine(value.trim());
    }
  }
  return name || "tool";
}

function filePathFor(variant: ToolRowVariant, input: unknown): string | undefined {
  if (variant !== "read" && variant !== "write" && variant !== "edit") return undefined;
  const record = asRecord(input);
  for (const key of ["path", "file_path"]) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) return firstLine(value.trim());
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? value;
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}
