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
