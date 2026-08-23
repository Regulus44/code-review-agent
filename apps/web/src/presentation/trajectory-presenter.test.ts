import { describe, expect, it } from "vitest";
import { brand } from "@code-review-agent/contracts";
import type { TrajectoryProjection, TrajectoryRecord } from "../projection/trajectory.js";
import { buildTrajectoryTimeline, inspectTrajectory, queryTrajectory } from "./trajectory-presenter.js";

const sessionId = brand<string, "SessionId">("ses_presenter");

function record(overrides: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return {
    key: "tool:read",
    kind: "tool",
    label: "read_file",
    status: "completed",
    sourceSeq: 1,
    lastSeq: 2,
    sessionId,
    startedAt: "2026-08-23T00:00:01.000Z",
    endedAt: "2026-08-23T00:00:02.000Z",
    durationMs: 1_000,
    running: false,
    detail: { result: "ok", token: "hidden" },
    ...overrides,
  };
}

function projection(records: readonly TrajectoryRecord[]): TrajectoryProjection {
  return { sessionId, records, lastSequence: 10 };
}

function runningRecord(key: string, sourceSeq: number): TrajectoryRecord {
  const value = record({ key, sourceSeq, status: "running", running: true });
  const mutable = value as { endedAt?: string; durationMs?: number };
  delete mutable.endedAt;
  delete mutable.durationMs;
  return value;
}

describe("trajectory presenter", () => {
  it("filters by query and kind, then groups records into stable lanes", () => {
    const view = queryTrajectory(
      projection([
        record(),
        record({ key: "turn:t1", kind: "turn", label: "Turn t1", sourceSeq: 3, lastSeq: 4 }),
        runningRecord("tool:write", 5),
      ]),
      { query: "tool:read", kinds: ["tool"] },
    );
    expect(view.matchedRecords).toBe(1);
    expect(view.records.map((item) => item.key)).toEqual(["tool:read"]);
    expect(view.lanes.map((lane) => lane.kind)).toEqual(["tool"]);
  });

  it("supports runningOnly and reports limit truncation", () => {
    const records = [record({ key: "tool:1", sourceSeq: 1 }), record({ key: "tool:2", sourceSeq: 2 }), record({ key: "tool:3", sourceSeq: 3 })];
    const view = queryTrajectory(projection(records), { runningOnly: true, limit: 1 });
    expect(view.records).toHaveLength(0);
    expect(view.truncated).toBe(false);
    const running = records.map((_item, index) => runningRecord(`tool:r${index}`, index + 1));
    const limited = queryTrajectory(projection(running), { runningOnly: true, limit: 2 });
    expect(limited.records).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    expect(limited.lanes[0]?.runningCount).toBe(2);
  });

  it("builds timing/source/detail sections without inventing running duration", () => {
    const inspected = inspectTrajectory(runningRecord("tool:running", 1));
    const timing = inspected.sections.find((section) => section.id === "timing");
    const detail = inspected.sections.find((section) => section.id === "detail");
    expect(timing?.entries.find((entry) => entry.label === "Duration")?.value).toBe("running");
    expect(detail?.entries[0]?.value).toContain("[redacted]");
    expect(detail?.entries[0]?.untrusted).toBe(true);
  });

  it("builds a bounded timeline with stable order, nested depth, and explicit timing state", () => {
    const unknownRecord = record({ key: "event:unknown", kind: "event", label: "Unknown", sourceSeq: 1 });
    const unknownMutable = unknownRecord as { startedAt?: string; endedAt?: string; durationMs?: number };
    delete unknownMutable.startedAt;
    delete unknownMutable.endedAt;
    delete unknownMutable.durationMs;
    const view = buildTrajectoryTimeline([
      record({ key: "tool:root", callId: brand<string, "ToolCallId">("root"), sourceSeq: 2, startedAt: "2026-08-23T00:00:00.000Z", endedAt: "2026-08-23T00:00:04.000Z", durationMs: 4_000 }),
      runningRecord("tool:child", 3) as TrajectoryRecord & { parentCallId?: string },
      unknownRecord,
    ].map((item) => item.key === "tool:child" ? { ...item, callId: brand<string, "ToolCallId">("child"), parentCallId: "root" } : item) as readonly TrajectoryRecord[]);
    expect(view.rows.map((row) => row.key)).toEqual(["event:unknown", "tool:root", "tool:child"]);
    expect(view.rows.find((row) => row.key === "tool:child")).toMatchObject({ depth: 1, timing: "running" });
    expect(view.rows.find((row) => row.key === "tool:child")).not.toHaveProperty("widthPercent");
    expect(view.rows.find((row) => row.key === "tool:root")).toMatchObject({ depth: 0, timing: "recorded", widthPercent: 100 });
    expect(view.rows.find((row) => row.key === "event:unknown")?.timing).toBe("unknown");
    expect(view.spanMs).toBe(4_000);
  });

  it("keeps 1000+ records searchable while bounding the rendered ledger and timeline window", () => {
    const records = Array.from({ length: 1_200 }, (_, index) => record({
      key: `tool:${index}`,
      label: `read_file_${index}`,
      sourceSeq: index + 1,
      lastSeq: index + 1,
    }));
    const bounded = queryTrajectory(projection(records), { limit: 200 });
    expect(bounded.records).toHaveLength(200);
    expect(bounded.truncated).toBe(true);
    expect(queryTrajectory(projection(records), { query: "read_file_1199", limit: 200 }).records.map((item) => item.key)).toEqual(["tool:1199"]);
    const timeline = buildTrajectoryTimeline(records, 1_000);
    expect(timeline.rows).toHaveLength(1_000);
    expect(timeline.truncated).toBe(true);
  });
});
