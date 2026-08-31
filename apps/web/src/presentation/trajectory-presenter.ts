import type { TrajectoryKind, TrajectoryProjection, TrajectoryRecord } from "../projection/trajectory.js";
import { presentBoundedValue, type BoundedDisplayValue } from "./safe-value.js";

export interface TrajectoryQueryOptions {
  readonly query?: string;
  readonly kinds?: readonly TrajectoryKind[];
  readonly runningOnly?: boolean;
  readonly limit?: number;
}

export interface TrajectoryLane {
  readonly kind: TrajectoryKind;
  readonly records: readonly TrajectoryRecord[];
  readonly runningCount: number;
}

export interface TrajectoryLedgerView {
  readonly sessionId: TrajectoryProjection["sessionId"];
  readonly records: readonly TrajectoryRecord[];
  readonly lanes: readonly TrajectoryLane[];
  readonly totalRecords: number;
  readonly matchedRecords: number;
  readonly lastSequence: number;
  readonly query: string;
  readonly truncated: boolean;
}

export type TrajectoryTiming = "recorded" | "running" | "unknown";

export interface TrajectoryTimelineRow {
  readonly key: string;
  readonly kind: TrajectoryKind;
  readonly label: string;
  readonly status: string;
  readonly sourceSeq: number;
  readonly lastSeq: number;
  readonly running: boolean;
  readonly depth: number;
  readonly timing: TrajectoryTiming;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly offsetMs?: number;
  readonly widthPercent?: number;
}

export interface TrajectoryTimelineView {
  readonly rows: readonly TrajectoryTimelineRow[];
  readonly startAt?: string;
  readonly endAt?: string;
  readonly spanMs?: number;
  readonly truncated: boolean;
}

export interface TrajectoryInspectorEntry {
  readonly label: string;
  readonly value: string;
  readonly untrusted?: boolean;
  readonly truncated?: boolean;
}

export interface TrajectoryInspectorSection {
  readonly id: "overview" | "options" | "usage" | "timing" | "diff" | "request" | "catalog" | "rendered" | "raw" | "source" | "input" | "output" | "schema" | "detail";
  readonly title: string;
  readonly entries: readonly TrajectoryInspectorEntry[];
}

export interface TrajectoryInspectorView {
  readonly key: string;
  readonly title: string;
  readonly kind: TrajectoryKind;
  readonly status: string;
  readonly running: boolean;
  readonly sections: readonly TrajectoryInspectorSection[];
}

const LANE_ORDER: readonly TrajectoryKind[] = ["turn", "step", "assistant", "tool", "task", "permission", "interaction", "event"];

/**
 * Query the immutable trajectory projection without changing its ordering or
 * facts. Search is bounded and uses the same redaction policy as inspectors.
 */
export function queryTrajectory(projection: TrajectoryProjection, options: TrajectoryQueryOptions = {}): TrajectoryLedgerView {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const kinds = options.kinds === undefined ? undefined : new Set(options.kinds);
  const candidates = projection.records.filter((record) => {
    if (kinds !== undefined && !kinds.has(record.kind)) return false;
    if (options.runningOnly === true && !record.running) return false;
    if (query.length === 0) return true;
    return searchableRecord(record).includes(query);
  });
  const limit = Math.min(1_000, Math.max(1, Math.floor(options.limit ?? 200)));
  const records = candidates.slice(0, limit);
  const lanes = LANE_ORDER.flatMap((kind): TrajectoryLane[] => {
    const laneRecords = records.filter((record) => record.kind === kind);
    return laneRecords.length === 0 ? [] : [{ kind, records: laneRecords, runningCount: laneRecords.filter((record) => record.running).length }];
  });
  return {
    sessionId: projection.sessionId,
    records,
    lanes,
    totalRecords: projection.records.length,
    matchedRecords: candidates.length,
    lastSequence: projection.lastSequence,
    query: options.query?.trim() ?? "",
    truncated: candidates.length > records.length,
  };
}

/**
 * Build a bounded, time-aware timeline from the same queried records used by
 * the ledger. Missing timestamps remain unknown and running records never get
 * a fabricated end or duration.
 */
export function buildTrajectoryTimeline(records: readonly TrajectoryRecord[], maxRows = 1_000): TrajectoryTimelineView {
  const ordered = [...records].sort((left, right) => left.sourceSeq - right.sourceSeq || left.key.localeCompare(right.key));
  const boundedRows = ordered.slice(0, Math.min(1_000, Math.max(1, Math.floor(maxRows))));
  const starts = boundedRows.flatMap((record) => {
    const timestamp = record.startedAt === undefined ? NaN : Date.parse(record.startedAt);
    return Number.isFinite(timestamp) ? [timestamp] : [];
  });
  const ends = boundedRows.flatMap((record) => {
    const timestamp = record.endedAt === undefined ? NaN : Date.parse(record.endedAt);
    return Number.isFinite(timestamp) ? [timestamp] : [];
  });
  const startMs = starts.length === 0 ? undefined : Math.min(...starts);
  const endMs = ends.length === 0 ? undefined : Math.max(...ends);
  const spanMs = startMs !== undefined && endMs !== undefined && endMs >= startMs ? endMs - startMs : undefined;
  const callRecords = new Map(boundedRows.flatMap((record) => record.callId === undefined ? [] : [[String(record.callId), record] as const]));
  const depths = new Map<string, number>();
  const depthOf = (record: TrajectoryRecord, trail: ReadonlySet<string> = new Set()): number => {
    const existing = depths.get(record.key);
    if (existing !== undefined) return existing;
    if (record.parentCallId === undefined || record.kind !== "tool" || trail.has(record.key)) {
      depths.set(record.key, 0);
      return 0;
    }
    const parent = callRecords.get(record.parentCallId);
    const depth = parent === undefined ? 1 : Math.min(8, depthOf(parent, new Set([...trail, record.key])) + 1);
    depths.set(record.key, depth);
    return depth;
  };
  const rows = boundedRows.map((record): TrajectoryTimelineRow => {
    const started = record.startedAt === undefined ? undefined : Date.parse(record.startedAt);
    const ended = record.endedAt === undefined ? undefined : Date.parse(record.endedAt);
    const recorded = started !== undefined && ended !== undefined && Number.isFinite(started) && Number.isFinite(ended) && ended >= started;
    const timing: TrajectoryTiming = recorded ? "recorded" : record.running ? "running" : "unknown";
    const offsetMs = startMs !== undefined && started !== undefined && Number.isFinite(started) ? Math.max(0, started - startMs) : undefined;
    const widthPercent = recorded && spanMs !== undefined && spanMs > 0 ? Math.max(2, Math.min(100, ((ended - started) / spanMs) * 100)) : undefined;
    return {
      key: record.key,
      kind: record.kind,
      label: record.label,
      status: record.status,
      sourceSeq: record.sourceSeq,
      lastSeq: record.lastSeq,
      running: record.running,
      depth: depthOf(record),
      timing,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
      ...(offsetMs === undefined ? {} : { offsetMs }),
      ...(widthPercent === undefined ? {} : { widthPercent }),
    };
  });
  return {
    rows,
    ...(startMs === undefined ? {} : { startAt: new Date(startMs).toISOString() }),
    ...(endMs === undefined ? {} : { endAt: new Date(endMs).toISOString() }),
    ...(spanMs === undefined ? {} : { spanMs }),
    truncated: ordered.length > rows.length,
  };
}

/** Build bounded inspector sections for a selected record. */
export function inspectTrajectory(record: TrajectoryRecord, maxDetailChars = 8_000): TrajectoryInspectorView {
  const detail = presentBoundedValue(record.detail, maxDetailChars);
  const raw = asRecord(record.detail);
  const value = (keys: readonly string[]): unknown => readPath(raw, keys);
  const boundedEntry = (label: string, candidate: unknown): TrajectoryInspectorEntry => {
    if (candidate === undefined) return entry(label, "未知");
    const display = presentBoundedValue(candidate, Math.min(maxDetailChars, 2_000));
    return { label, value: display.text, untrusted: display.untrusted, truncated: display.truncated };
  };
  const detailEntry: TrajectoryInspectorEntry = {
    label: "不受信任的事件数据",
    value: detail.text,
    untrusted: detail.untrusted,
    truncated: detail.truncated,
  };
  return {
    key: record.key,
    title: record.label,
    kind: record.kind,
    status: record.status,
    running: record.running,
    sections: [
      {
        id: "overview",
        title: "概览",
        entries: compactEntries([
          entry("类型", record.kind),
          entry("状态", localizeStatus(record.status)),
          entry("运行中", record.running ? "是" : "否"),
          entry("记录键", record.key),
        ]),
      },
      {
        id: "options",
        title: "选项",
        entries: [
          boundedEntry("选项", value(["options"])),
          boundedEntry("模型", value(["model"])),
          boundedEntry("推理", value(["reasoning", "reasoningEffort"])),
          boundedEntry("温度", value(["temperature"])),
          boundedEntry("最大 token", value(["maxTokens", "max_tokens"])),
        ],
      },
      {
        id: "usage",
        title: "用量",
        entries: [
          boundedEntry("用量", value(["usage"])),
          boundedEntry("输入 token", value(["inputTokens", "input_tokens", "usage", "input"])),
          boundedEntry("输出 token", value(["outputTokens", "output_tokens", "usage", "output"])),
          boundedEntry("TTFT", value(["ttftMs", "ttft_ms"])),
          boundedEntry("提供方", value(["provider"])),
        ],
      },
      {
        id: "timing",
        title: "时间",
        entries: compactEntries([
          entry("开始", record.startedAt ?? "未知"),
          entry("结束", record.endedAt ?? (record.running ? "运行中" : "未知")),
          entry("耗时", formatDuration(record.durationMs, record.running)),
        ]),
      },
      {
        id: "diff",
        title: "Diff",
        entries: [
          boundedEntry("Diff", value(["diff"])),
          boundedEntry("Patch", value(["patch"])),
          boundedEntry("修改前", value(["before"])),
          boundedEntry("修改后", value(["after"])),
        ],
      },
      {
        id: "request",
        title: "请求",
        entries: [
          boundedEntry("请求", value(["request"])),
          boundedEntry("权限", value(["permissionId", "permission"])),
          boundedEntry("交互", value(["interactionId", "interaction"])),
          boundedEntry("问题", value(["question"])),
        ],
      },
      {
        id: "catalog",
        title: "工具目录",
        entries: [
          boundedEntry("工具", value(["toolName", "name"])),
          boundedEntry("风险", value(["riskLevel", "risk"])),
          boundedEntry("来源", value(["source"])),
          boundedEntry("Schema", value(["inputSchema", "schema"])),
        ],
      },
      {
        id: "rendered",
        title: "渲染结果",
        entries: [detailEntry],
      },
      {
        id: "raw",
        title: "原始数据",
        entries: [detailEntry],
      },
      {
        id: "source",
        title: "来源",
        entries: compactEntries([
          entry("来源序列", String(record.sourceSeq)),
          entry("最后序列", String(record.lastSeq)),
          entry("会话", String(record.sessionId)),
          entry("回合", record.turnId === undefined ? "未知" : String(record.turnId)),
          entry("任务", record.taskId === undefined ? "未知" : String(record.taskId)),
          entry("调用", record.callId === undefined ? "未知" : String(record.callId)),
          entry("根调用", record.rootCallId ?? "未知"),
          entry("父调用", record.parentCallId ?? "未知"),
        ]),
      },
      {
        id: "input",
        title: "输入",
        entries: [boundedEntry("输入", value(["input", "arguments"]))],
      },
      {
        id: "output",
        title: "输出",
        entries: [boundedEntry("输出", value(["output", "result"]))],
      },
      {
        id: "schema",
        title: "Schema",
        entries: [boundedEntry("Schema", value(["schema", "inputSchema"]))],
      },
      {
        id: "detail",
        title: "渲染详情",
        entries: [detailEntry],
      },
    ],
  };
}

function searchableRecord(record: TrajectoryRecord): string {
  const detail = presentBoundedValue(record.detail, 2_000).text;
  return [record.key, record.kind, record.label, record.status, record.turnId, record.taskId, record.callId, detail]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLocaleLowerCase();
}

function compactEntries(entries: readonly (TrajectoryInspectorEntry | undefined)[]): readonly TrajectoryInspectorEntry[] {
  return entries.filter((entry): entry is TrajectoryInspectorEntry => entry !== undefined);
}

function entry(label: string, value: string): TrajectoryInspectorEntry {
  return { label, value };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function readPath(record: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): unknown {
  if (record === undefined) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function formatDuration(durationMs: number | undefined, running: boolean): string {
  if (running) return "运行中";
  if (durationMs === undefined) return "未知";
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`;
}

function localizeStatus(value: string): string {
  return ({ queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", canceled: "已取消", stopped: "已停止", interrupted: "已中断", pending: "待处理", expired: "已过期" } as Record<string, string>)[value] ?? value;
}
