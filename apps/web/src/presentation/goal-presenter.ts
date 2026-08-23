import type { GoalProjection, GoalStatus } from "@code-review-agent/contracts";
import { presentBoundedValue, type BoundedDisplayValue } from "./safe-value.js";

export interface GoalCriterionView {
  readonly text: string;
  readonly state: "open" | "satisfied" | "unknown";
}

export interface GoalRenderIntent {
  readonly visible: boolean;
  readonly id?: string;
  readonly title: string;
  readonly status: GoalStatus | "unknown";
  readonly statusLabel: string;
  readonly criteria: readonly GoalCriterionView[];
  readonly completion: { readonly satisfied: number; readonly total: number; readonly label: string };
  readonly detail: BoundedDisplayValue;
  readonly canEdit: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canClear: boolean;
  readonly unavailableReason?: string;
}

export interface GoalPresenterOptions {
  readonly commandSurfaceAvailable?: boolean;
  readonly maxDetailChars?: number;
}

/**
 * Present the latest durable goal. The browser never invents criterion
 * completion: only a terminal completed goal is considered satisfied; other
 * criteria remain `unknown` until the host records finer-grained evidence.
 */
export function presentGoalBar(
  goals: readonly GoalProjection[] | undefined,
  options: GoalPresenterOptions = {},
): GoalRenderIntent {
  const goal = [...(goals ?? [])].sort((left, right) => right.lastSequence - left.lastSequence)[0];
  if (goal === undefined) {
    return {
      visible: false,
      title: "No active goal",
      status: "unknown",
      statusLabel: "No goal",
      criteria: [],
      completion: { satisfied: 0, total: 0, label: "No success criteria" },
      detail: presentBoundedValue({}, options.maxDetailChars ?? 4_000),
      canEdit: false,
      canPause: false,
      canResume: false,
      canClear: false,
      unavailableReason: "The session has not recorded a durable goal.",
    };
  }
  const criteria = goal.successCriteria.map((text) => ({
    text: bounded(text, 240),
    state: goal.status === "completed" ? "satisfied" as const : "unknown" as const,
  }));
  const satisfied = criteria.filter((item) => item.state === "satisfied").length;
  const commandSurfaceAvailable = options.commandSurfaceAvailable === true;
  return {
    visible: true,
    id: String(goal.id),
    title: bounded(goal.title || "Untitled goal", 180),
    status: goal.status,
    statusLabel: statusLabel(goal.status),
    criteria,
    completion: {
      satisfied,
      total: criteria.length,
      label: criteria.length === 0 ? "No success criteria" : `${satisfied}/${criteria.length} criteria satisfied`,
    },
    detail: presentBoundedValue({ budget: goal.budget, result: goal.result, reason: goal.reason }, options.maxDetailChars ?? 4_000),
    canEdit: commandSurfaceAvailable && goal.status === "active",
    canPause: commandSurfaceAvailable && goal.status === "active",
    canResume: commandSurfaceAvailable && (goal.status === "paused" || goal.status === "blocked"),
    canClear: commandSurfaceAvailable && !["completed", "cancelled"].includes(goal.status),
    ...(commandSurfaceAvailable ? {} : { unavailableReason: "Goal controls are deferred until the host exposes an idempotent command surface." }),
  };
}

function statusLabel(status: GoalStatus): string {
  return status === "active" ? "Active" : status === "paused" ? "Paused" : status === "completed" ? "Completed" : status === "blocked" ? "Blocked" : "Cancelled";
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const limit = Math.max(24, Math.floor(maxChars));
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
