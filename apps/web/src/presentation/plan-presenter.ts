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
    statusLabel: status === "draft" ? "草稿" : status === "active" ? "进行中" : status === "approved" ? "已批准" : status === "rejected" ? "已拒绝" : "已清除",
    content,
    reviewable: status === "draft" || status === "active",
    editable: commandSurfaceAvailable && !["approved", "cleared"].includes(status),
    detail: presentBoundedValue({ content, updatedAt: plan?.updatedAt ?? "unknown", sequence: plan?.lastSequence ?? 0 }, options.maxChars ?? 6_000),
    ...(commandSurfaceAvailable ? {} : { unavailableReason: "主机尚未提供幂等计划操作接口，编辑和审查暂不可用。" }),
  };
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.trim();
  const limit = Math.max(64, Math.floor(maxChars));
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
