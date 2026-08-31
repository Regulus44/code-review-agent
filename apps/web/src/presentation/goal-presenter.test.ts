import { describe, expect, it } from "vitest";
import type { GoalProjection } from "@code-review-agent/contracts";
import { presentGoalBar } from "./goal-presenter.js";

const goal = (overrides: Partial<GoalProjection> = {}): GoalProjection => ({
  id: "goal_fixture" as GoalProjection["id"],
  title: "Ship Phase 8",
  status: "active",
  successCriteria: ["Presenter exists", "Replay passes"],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  lastSequence: 4,
  ...overrides,
});

describe("presentGoalBar", () => {
  it("selects the latest durable goal and keeps criterion evidence explicit", () => {
    const view = presentGoalBar([goal({ lastSequence: 2 }), goal({ lastSequence: 4 })]);
    expect(view).toMatchObject({ visible: true, title: "Ship Phase 8", status: "active", canPause: false });
    expect(view.criteria.every((item) => item.state === "unknown")).toBe(true);
    expect(view.completion.label).toBe("0/2 项标准已满足");
    expect(view.unavailableReason).toContain("幂等目标操作接口");
  });

  it("marks all criteria satisfied only after a completed goal", () => {
    const view = presentGoalBar([goal({ status: "completed" })]);
    expect(view.completion).toMatchObject({ satisfied: 2, total: 2 });
    expect(view.statusLabel).toBe("已完成");
  });

  it("exposes host-backed pause and resume actions without inventing a command", () => {
    expect(presentGoalBar([goal()], { commandSurfaceAvailable: true })).toMatchObject({ canPause: true, canResume: false, canClear: true });
    expect(presentGoalBar([goal({ status: "paused" })], { commandSurfaceAvailable: true })).toMatchObject({ statusLabel: "已暂停", canPause: false, canResume: true });
  });

  it("returns an explicit empty state", () => {
    expect(presentGoalBar([])).toMatchObject({ visible: false, status: "unknown" });
  });
});
