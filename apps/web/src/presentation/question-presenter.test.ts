import { describe, expect, it } from "vitest";
import type { InteractionProjection } from "@code-review-agent/contracts";
import { presentQuestionBatch } from "./question-presenter.js";

const interaction = (overrides: Partial<InteractionProjection> = {}): InteractionProjection => ({
  id: "interaction_fixture" as InteractionProjection["id"],
  toolCallId: "tool_fixture" as InteractionProjection["toolCallId"],
  turnId: "turn_fixture" as NonNullable<InteractionProjection["turnId"]>,
  question: "Continue?",
  options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
  allowFreeform: true,
  status: "pending",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  expiresAt: "2026-08-23T00:01:00.000Z",
  lastSequence: 4,
  ...overrides,
});

describe("presentQuestionBatch", () => {
  it("groups questions and derives expiry before a resolved event", () => {
    const view = presentQuestionBatch([interaction(), interaction({ id: "interaction_two" as InteractionProjection["id"], status: "answered", answer: "yes" })], { batchId: "turn_fixture", now: Date.parse("2026-08-23T00:00:30.000Z") });
    expect(view).toMatchObject({ visible: true, pendingCount: 1, resolvedCount: 1, expiredCount: 0 });
    expect(view.questions[0]).toMatchObject({ canAnswer: true, canCancel: true, recovery: "pending" });
  });

  it("marks deadline-expired questions as non-interactive and supports recovered ids", () => {
    const view = presentQuestionBatch([interaction()], { now: Date.parse("2026-08-23T00:02:00.000Z"), restoredIds: new Set(["interaction_fixture"]) });
    expect(view).toMatchObject({ pendingCount: 0, expiredCount: 1 });
    expect(view.questions[0]).toMatchObject({ status: "expired", canAnswer: false, canCancel: false });
  });
});
