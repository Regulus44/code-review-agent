import type { SessionEventStore, SessionId } from "@coding-agent/contracts";

export interface TrajectoryFixtureSeed {
  readonly sessionId: SessionId;
  readonly records: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

/** Seed a deterministic, non-tool-executing trajectory for browser pagination and render QA. */
export async function seedTrajectoryFixture(options: {
  readonly store: SessionEventStore;
  readonly sessionId: SessionId;
  readonly records?: number;
}): Promise<TrajectoryFixtureSeed> {
  const count = Math.min(2_000, Math.max(1, Math.floor(options.records ?? 1_250)));
  const firstSequence = (await options.store.list(options.sessionId)).at(-1)?.sequence ?? 0;
  for (let index = 0; index < count; index += 1) {
    const callId = `trajectory_fixture_call_${index + 1}`;
    await options.store.append({
      sessionId: options.sessionId,
      type: "tool/call",
      payload: {
        toolCallId: callId,
        name: index % 2 === 0 ? "read_file" : "grep",
        input: { path: `fixture/${String(index + 1).padStart(4, "0")}.txt`, query: `needle-${index + 1}` },
        riskLevel: "read",
        approvalMode: "deny",
        caller: "agent",
        rootCallId: callId,
      },
    });
    await options.store.append({
      sessionId: options.sessionId,
      type: "tool/result",
      payload: {
        toolCallId: callId,
        name: index % 2 === 0 ? "read_file" : "grep",
        status: "completed",
        result: { ok: true, output: { fixtureIndex: index + 1, matched: index % 3 === 0 } },
      },
    });
  }
  const lastSequence = (await options.store.list(options.sessionId)).at(-1)?.sequence ?? firstSequence;
  return { sessionId: options.sessionId, records: count, firstSequence: firstSequence + 1, lastSequence };
}
