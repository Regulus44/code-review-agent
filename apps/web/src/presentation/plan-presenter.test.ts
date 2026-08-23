import { describe, expect, it } from "vitest";
import type { PlanProjection } from "@code-review-agent/contracts";
import { presentPlan } from "./plan-presenter.js";

const plan: PlanProjection = { content: "Inspect, edit, test", status: "active", updatedAt: "2026-08-23T00:00:00.000Z", lastSequence: 3 };

describe("presentPlan", () => {
  it("exposes review state without claiming that a command surface exists", () => {
    const view = presentPlan(plan);
    expect(view).toMatchObject({ visible: true, status: "active", reviewable: true, editable: false });
    expect(view.unavailableReason).toContain("command surface");
  });

  it("bounds long plan content", () => {
    expect(presentPlan({ ...plan, content: "x".repeat(200) }, { maxChars: 80 }).content.length).toBe(80);
  });
});
