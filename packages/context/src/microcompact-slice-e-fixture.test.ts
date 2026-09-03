import { describe, expect, it } from "vitest";
import { applyMicrocompactPass, evaluateMicrocompactPressure } from "./tool-result-budget.js";
import { buildMicrocompactCheckpoint } from "./microcompact-checkpoint.js";
import { MICROCOMPACT_SLICE_E_BUDGET, MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE, microcompactSliceECheckpointEvents, microcompactSliceELongRetrievalMessages } from "./microcompact-slice-e-fixture.js";

describe("Slice E equivalent long-retrieval fixture", () => {
  const policy = { keepRecentResults: 2, retainRecentResultsRatio: 0.16, microcompactTargetHysteresisTokens: 800 } as const;

  it("keeps all source evidence under low pressure", () => {
    const messages = microcompactSliceELongRetrievalMessages();
    const evaluation = evaluateMicrocompactPressure(messages, 4_000, MICROCOMPACT_SLICE_E_BUDGET, { policy });
    expect(evaluation.strategy).toBe("none");
    expect(evaluation.eligibleToolResultCount).toBe(MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.resultCount);
  });

  it("creates a bounded handoff near the threshold and keeps test evidence", () => {
    const messages = microcompactSliceELongRetrievalMessages();
    const evaluation = evaluateMicrocompactPressure(messages, 9_100, MICROCOMPACT_SLICE_E_BUDGET, { policy });
    const reduced = applyMicrocompactPass(messages, { policy, evaluation });
    const checkpoint = buildMicrocompactCheckpoint({ checkpointId: "mc_slice_e_fixture", messages, events: microcompactSliceECheckpointEvents() });
    expect(evaluation.strategy).toBe("pressure");
    expect(reduced.report.newlyClearedToolCallIds.length).toBeGreaterThan(0);
    expect(checkpoint.filesRead).toEqual([MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.filesRead[0]]);
    expect(checkpoint.testsRun).toEqual([MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.testCommand]);
    expect(JSON.stringify(checkpoint)).not.toContain("fixture output omitted from checkpoint");
  });

  it("reuses the same replacement view after replay", () => {
    const messages = microcompactSliceELongRetrievalMessages();
    const evaluation = evaluateMicrocompactPressure(messages, 9_100, MICROCOMPACT_SLICE_E_BUDGET, { policy });
    const first = applyMicrocompactPass(messages, { policy, evaluation });
    const replay = applyMicrocompactPass(first.messages, { policy, evaluation, alreadyClearedToolCallIds: new Set(first.report.clearedToolCallIds) });
    expect(replay.messages).toEqual(first.messages);
    expect(replay.report.newlyClearedToolCallIds).toEqual([]);
  });
});
