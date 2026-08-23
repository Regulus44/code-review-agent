import type { ToolCallView } from "../projection/conversation.js";
import { presentBoundedValue } from "./safe-value.js";

export interface LspSourceLocation {
  readonly uri: string;
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly endLine?: number;
  readonly endCharacter?: number;
  readonly preview: string;
}

export interface LspDiagnosticView {
  readonly severity: string;
  readonly message: string;
  readonly source?: string;
  readonly location?: LspSourceLocation;
}

export interface LspRenderIntent {
  readonly visible: boolean;
  readonly method: "diagnostics" | "definition" | "references" | "unknown";
  readonly status: "completed" | "failed" | "running" | "unknown";
  readonly serverId: string;
  readonly path: string;
  readonly diagnostics: readonly LspDiagnosticView[];
  readonly locations: readonly LspSourceLocation[];
  readonly error?: string;
  readonly restartState: "none" | "requested" | "restarted" | "crashed" | "unknown";
  readonly summary: string;
}

/** Convert an LSP tool call into a bounded source-location/diagnostic surface. */
export function presentLspTool(tool: ToolCallView, maxItems = 64): LspRenderIntent {
  const method = methodOf(tool.name, tool.result);
  const payload = asRecord(tool.result);
  const output = asRecord(payload?.output) ?? payload;
  const rawResult = output?.result;
  const locations = normalizeLocations(rawResult, maxItems);
  const diagnostics = normalizeDiagnostics(rawResult, maxItems, stringValue(output?.path));
  const error = stringValue(asRecord(payload?.error)?.message);
  const restartState = restartOf(tool);
  const status = tool.status === "completed" ? "completed" : tool.status === "failed" ? "failed" : tool.status === "running" || tool.status === "pending" ? "running" : "unknown";
  const visible = method !== "unknown" || diagnostics.length > 0 || locations.length > 0 || error !== undefined || restartState !== "none";
  return {
    visible,
    method,
    status,
    serverId: stringValue(output?.serverId) ?? "unknown",
    path: stringValue(output?.path) ?? "unknown",
    diagnostics,
    locations,
    ...(error === undefined ? {} : { error: bounded(error, 500) }),
    restartState,
    summary: summary(method, status, diagnostics.length, locations.length, restartState),
  };
}

function methodOf(name: string, result: unknown): LspRenderIntent["method"] {
  const value = stringValue(asRecord(asRecord(result)?.output)?.method) ?? name;
  if (/diagnostic/i.test(value)) return "diagnostics";
  if (/definition/i.test(value)) return "definition";
  if (/references?/i.test(value)) return "references";
  return "unknown";
}

function normalizeLocations(value: unknown, maxItems: number): readonly LspSourceLocation[] {
  const candidates = Array.isArray(value) ? value : asRecord(value)?.locations;
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, Math.max(1, Math.min(256, Math.floor(maxItems)))).flatMap((item): LspSourceLocation[] => {
    const record = asRecord(item);
    const range = asRecord(record?.range);
    const start = asRecord(range?.start) ?? asRecord(record?.start);
    const end = asRecord(range?.end) ?? asRecord(record?.end);
    const uri = stringValue(record?.uri) ?? stringValue(record?.targetUri);
    const line = integer(start?.line);
    const character = integer(start?.character);
    if (uri === undefined || line === undefined || character === undefined) return [];
    const path = uri.replace(/^file:\/\//u, "");
    const endLine = integer(end?.line);
    const endCharacter = integer(end?.character);
    return [{ uri: bounded(uri, 1_000), path: bounded(path, 1_000), line, character, ...(endLine === undefined ? {} : { endLine }), ...(endCharacter === undefined ? {} : { endCharacter }), preview: `${path}:${line + 1}:${character + 1}` }];
  });
}

function normalizeDiagnostics(value: unknown, maxItems: number, sourcePath?: string): readonly LspDiagnosticView[] {
  const candidates = asRecord(value)?.items ?? value;
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, Math.max(1, Math.min(256, Math.floor(maxItems)))).flatMap((item): LspDiagnosticView[] => {
    const record = asRecord(item);
    const message = stringValue(record?.message);
    if (message === undefined) return [];
    const severityValue = record?.severity;
    const location = normalizeLocations([record?.location === undefined ? { uri: record?.uri ?? (sourcePath === undefined ? undefined : `file://${sourcePath}`), range: record?.range } : record.location], 1)[0];
    return [{ severity: severityLabel(severityValue), message: bounded(message, 1_000), ...(stringValue(record?.source) === undefined ? {} : { source: bounded(String(record?.source), 200) }), ...(location === undefined ? {} : { location }) }];
  });
}

function restartOf(tool: ToolCallView): LspRenderIntent["restartState"] {
  const text = presentBoundedValue([tool.progress, tool.result], 2_000).text;
  if (/restart_requested/iu.test(text)) return "requested";
  if (/restarted/iu.test(text)) return "restarted";
  if (/LSP_SERVER_CRASHED|crashed/iu.test(text)) return "crashed";
  return tool.status === "unknown" ? "unknown" : "none";
}

function summary(method: LspRenderIntent["method"], status: LspRenderIntent["status"], diagnostics: number, locations: number, restart: LspRenderIntent["restartState"]): string {
  const subject = method === "diagnostics" ? `${diagnostics} diagnostic${diagnostics === 1 ? "" : "s"}` : `${locations} location${locations === 1 ? "" : "s"}`;
  return `LSP ${method} · ${status} · ${subject}${restart === "none" ? "" : ` · ${restart}`}`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined; }
function severityLabel(value: unknown): string { return value === 1 ? "error" : value === 2 ? "warning" : value === 3 ? "info" : value === 4 ? "hint" : typeof value === "string" ? value : "unknown"; }
function bounded(value: string, max: number): string { const normalized = value.trim(); return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(1, max - 1))}…`; }
