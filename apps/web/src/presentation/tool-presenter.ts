import type { ToolCallView } from "../projection/conversation.js";

export type ToolPresentationKind = "builtin" | "mcp" | "subagent" | "diff" | "terminal" | "generic";

export interface ToolRenderIntent {
  readonly kind: ToolPresentationKind;
  readonly title: string;
  readonly sourceLabel: string;
  readonly summary: string;
  readonly status: ToolCallView["status"];
  readonly riskLevel: ToolCallView["riskLevel"];
  readonly details: string;
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
  const sourceLabel = sourceLabelFor(tool.name, kind);
  const title = presentationTitle(tool) ?? tool.name;
  const detailValue = resultModelView(tool.result) ?? tool.result ?? tool.input ?? tool.progress ?? {};
  const bounded = boundedJson(redactValue(detailValue), Math.max(256, options.maxDetailChars ?? 8_000));
  const summary = `${sourceLabel} · ${statusLabel(tool.status)}`;
  return {
    kind,
    title,
    sourceLabel,
    summary,
    status: tool.status,
    riskLevel: tool.riskLevel,
    details: bounded.text,
    truncated: bounded.truncated,
    untrusted: true,
    collapsedByDefault: tool.status !== "awaiting_permission" && tool.status !== "failed",
  };
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
  return status.replace(/_/g, " ");
}

function boundedJson(value: unknown, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 32))}\n… [output truncated]`, truncated: true };
}

function redactValue(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]));
}

function isSensitiveKey(key: string): boolean {
  return /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i.test(key);
}
