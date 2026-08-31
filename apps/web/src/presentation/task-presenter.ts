import type { TaskProjection } from "@code-review-agent/contracts";
import { presentBoundedValue, type BoundedDisplayValue } from "./safe-value.js";

export interface TaskRenderIntent {
  readonly title: string;
  readonly status: TaskProjection["status"];
  readonly mode: string;
  readonly provider: string;
  readonly summary: string;
  readonly lineage: string;
  readonly artifacts: readonly string[];
  readonly details: BoundedDisplayValue;
  readonly cancellable: boolean;
  readonly resumable: boolean;
}

export interface TaskPresenterOptions {
  readonly live?: boolean;
  readonly resumable?: boolean;
  readonly maxDetailChars?: number;
}

/**
 * Convert a durable TaskProjection into bounded render intent. The presenter
 * does not infer authority or execute task commands; live/resumable flags are
 * supplied by the host catalog when available.
 */
export function presentTask(task: TaskProjection, options: TaskPresenterOptions = {}): TaskRenderIntent {
  const title = task.title ?? task.report?.summary ?? `任务 ${String(task.id)}`;
  const reportSummary = task.report?.summary;
  const summary = reportSummary ?? (typeof task.result === "string" ? task.result : task.status);
  const details = presentBoundedValue({
    result: task.result,
    report: task.report,
    diagnostics: task.diagnostics,
    terminalReason: task.terminalReason,
  }, options.maxDetailChars ?? 8_000);
  return {
    title,
    status: task.status,
    mode: task.mode ?? "unknown",
    provider: task.provider ?? "unknown",
    summary,
    lineage: lineageLabel(task),
    artifacts: (Array.isArray(task.artifacts) ? task.artifacts : []).map((artifact) => artifact.label || artifact.path || artifact.id).slice(0, 32),
    details,
    cancellable: options.live === true && (task.status === "queued" || task.status === "running" || task.status === "waiting"),
    resumable: options.resumable === true,
  };
}

function lineageLabel(task: TaskProjection): string {
  const parent = task.parentTaskId === undefined ? "根任务" : `父任务 ${String(task.parentTaskId)}`;
  const child = task.childSessionId === undefined ? "无子会话" : `子会话 ${String(task.childSessionId)}`;
  return `${parent} · ${child} · 深度 ${task.delegationDepth ?? 0}`;
}
