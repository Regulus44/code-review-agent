import type { PlanProjection } from "@code-review-agent/contracts";
import { presentBoundedValue, type BoundedDisplayValue } from "./safe-value.js";

export interface PlanRenderIntent {
  readonly visible: boolean;
  readonly status: PlanProjection["status"];
  readonly statusLabel: string;
  readonly content: string;
  readonly reviewable: boolean;
  readonly editable: boolean;
  readonly detail: BoundedDisplayValue;
  readonly unavailableReason?: string;
}

export interface PlanPresenterOptions {
  readonly commandSurfaceAvailable?: boolean;
  readonly maxChars?: number;
}

export function presentPlan(plan: PlanProjection | undefined, options: PlanPresenterOptions = {}): PlanRenderIntent {
  const content = bounded(plan?.content ?? "", options.maxChars ?? 6_000);
  const status = plan?.status ?? "cleared";
  const commandSurfaceAvailable = options.commandSurfaceAvailable === true;
  return {
    visible: content.length > 0 || status !== "cleared",
    status,
    statusLabel: status === "draft" ? "Draft" : status === "active" ? "Active" : status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Cleared",
    content,
    reviewable: status === "draft" || status === "active",
    editable: commandSurfaceAvailable && !["approved", "cleared"].includes(status),
    detail: presentBoundedValue({ content, updatedAt: plan?.updatedAt ?? "unknown", sequence: plan?.lastSequence ?? 0 }, options.maxChars ?? 6_000),
    ...(commandSurfaceAvailable ? {} : { unavailableReason: "Plan editing and review commands are deferred until the host exposes an idempotent command surface." }),
  };
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.trim();
  const limit = Math.max(64, Math.floor(maxChars));
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
