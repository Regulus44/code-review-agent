import { describe, expect, it } from "vitest";
import { beginComposerSubmit, createComposerState, settleComposerSubmit } from "./composer-state.js";

describe("composer submit transaction", () => {
  it("keeps the draft until host admission commits", () => {
    const initial = createComposerState();
    const started = beginComposerSubmit(initial, "  inspect the diff  ");
    expect(started.attempt).toEqual({ id: 1, draft: "inspect the diff" });
    expect(started.state).toMatchObject({ phase: "submitting", draft: "inspect the diff" });
    expect(settleComposerSubmit(started.state, started.attempt!, "committed")).toMatchObject({ phase: "idle" });
  });

  it("retains the exact snapshot after a failed request", () => {
    const started = beginComposerSubmit(createComposerState(), "keep this prompt") as { state: ReturnType<typeof createComposerState>; attempt: { id: number; draft: string } };
    expect(settleComposerSubmit(started.state, started.attempt, "failed", "network unavailable")).toMatchObject({ phase: "error", draft: "keep this prompt", error: "network unavailable" });
  });

  it("ignores stale settlements and duplicate submissions while pending", () => {
    const started = beginComposerSubmit(createComposerState(), "first");
    expect(beginComposerSubmit(started.state, "second").attempt).toBeUndefined();
    const stale = { id: 99, draft: "stale" };
    expect(settleComposerSubmit(started.state, stale, "committed")).toBe(started.state);
  });
});
