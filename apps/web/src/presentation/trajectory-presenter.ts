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
  readonly id: "overview" | "timing" | "source" | "detail";
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
  return {
    key: record.key,
    title: record.label,
    kind: record.kind,
    status: record.status,
    running: record.running,
    sections: [
      {
        id: "overview",
        title: "Overview",
        entries: compactEntries([
          entry("Kind", record.kind),
          entry("Status", record.status),
          entry("Running", record.running ? "yes" : "no"),
          entry("Record key", record.key),
        ]),
      },
      {
        id: "timing",
        title: "Timing",
        entries: compactEntries([
          entry("Started", record.startedAt ?? "unknown"),
          entry("Ended", record.endedAt ?? (record.running ? "running" : "unknown")),
          entry("Duration", formatDuration(record.durationMs, record.running)),
        ]),
      },
      {
        id: "source",
        title: "Source",
        entries: compactEntries([
          entry("Source sequence", String(record.sourceSeq)),
          entry("Last sequence", String(record.lastSeq)),
          entry("Session", String(record.sessionId)),
          entry("Turn", record.turnId === undefined ? "unknown" : String(record.turnId)),
          entry("Task", record.taskId === undefined ? "unknown" : String(record.taskId)),
          entry("Call", record.callId === undefined ? "unknown" : String(record.callId)),
          entry("Root call", record.rootCallId ?? "unknown"),
          entry("Parent call", record.parentCallId ?? "unknown"),
        ]),
      },
      {
        id: "detail",
        title: "Rendered detail",
        entries: [
          {
            label: "Untrusted event data",
            value: detail.text,
            untrusted: detail.untrusted,
            truncated: detail.truncated,
          },
        ],
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

function formatDuration(durationMs: number | undefined, running: boolean): string {
  if (running) return "running";
  if (durationMs === undefined) return "unknown";
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`;
}
