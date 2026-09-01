import { describe, expect, it } from "vitest";
import { brand, type AgentEvent } from "@coding-agent/contracts";
import { projectTrajectory } from "./trajectory.js";

const sessionId = brand<string, "SessionId">("ses_trajectory");
const turnId = brand<string, "TurnId">("turn_trajectory");

function event(sequence: number, type: AgentEvent["type"], payload: Record<string, unknown>): AgentEvent {
  return {
    eventId: `evt_${sequence}`,
    sequence,
    schemaVersion: 1,
    sessionId,
    turnId,
    type,
    createdAt: `2026-08-23T00:00:0${sequence}.000Z`,
    payload,
  };
}

describe("Trajectory projection", () => {
  it("associates turn, step, assistant and tool records with stable source sequences", () => {
    const projection = projectTrajectory(sessionId, [
      event(1, "turn/started", {}),
      event(2, "step/started", { step: 1 }),
      event(3, "assistant/chunk", { text: "hello" }),
      event(4, "tool/call", { toolCallId: "tool_1", name: "read_file", parentCallId: "root" }),
      event(5, "tool/result", { toolCallId: "tool_1", status: "completed", result: { ok: true } }),
      event(6, "step/ended", { step: 1, status: "completed" }),
      event(7, "turn/ended", { status: "completed" }),
    ]);

    expect(projection.records.map((record) => record.kind)).toEqual(["turn", "step", "assistant", "tool"]);
    expect(projection.records.find((record) => record.kind === "tool")).toMatchObject({ sourceSeq: 4, durationMs: 1000, running: false, parentCallId: "root" });
  });

  it("does not fabricate duration for a still-running record", () => {
    const projection = projectTrajectory(sessionId, [event(1, "tool/call", { toolCallId: "tool_1", name: "read_file" })]);
    expect(projection.records[0]).toMatchObject({ running: true, status: "pending", startedAt: "2026-08-23T00:00:01.000Z" });
    expect(projection.records[0]).not.toHaveProperty("durationMs");
  });

  it("deduplicates replayed sequence frames", () => {
    const first = event(1, "agent/error", { message: "failed" });
    const projection = projectTrajectory(sessionId, [first, first]);
    expect(projection.records).toHaveLength(1);
    expect(projection.lastSequence).toBe(1);
  });
});
