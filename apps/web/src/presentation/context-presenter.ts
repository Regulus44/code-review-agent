import type { ContextDiagnosticsProjection, SessionProjection } from "@code-review-agent/contracts";
import { estimateMessagesTokens } from "@code-review-agent/compaction";

export interface ContextMeterRenderIntent {
  readonly status: "unknown" | "healthy" | "warning" | "error" | "auto_compact" | "blocking" | "compacted" | "failed";
  readonly label: string;
  readonly usedTokens?: number;
  readonly maxTokens?: number;
  readonly ratio?: number;
  readonly detail: string;
  readonly source?: "provider" | "estimate" | "stale_usage";
  readonly confidence?: "exact" | "high" | "medium" | "low";
  readonly percentLeft?: number;
}

export function presentContextMeter(session: SessionProjection | undefined, maxTokens?: number): ContextMeterRenderIntent {
  if (session === undefined) return { status: "unknown", label: "上下文 · 未知", detail: "没有可用的会话投影。" };
  const diagnostics = session.contextDiagnostics;
  if (diagnostics !== undefined) return presentDurableContextMeter(diagnostics);
  const budget = maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : undefined;
  const usedTokens = estimateMessagesTokens(session.messages.map((message) => ({ role: message.role, content: message.content })));
  const compaction = session.contextCompaction;
  const effectiveUsed = compaction?.estimatedTokens ?? usedTokens;
  const status = compaction?.status === "failed" ? "failed" : compaction?.status === "completed" ? "compacted" : budget === undefined ? "unknown" : "healthy";
  const ratio = budget === undefined ? undefined : Math.min(1, effectiveUsed / budget);
  const label = budget === undefined ? `上下文 · ${effectiveUsed} tokens` : `上下文 · ${effectiveUsed}/${budget}`;
  const detail = compaction?.status === "failed" ? `上下文压缩失败：${compaction.error ?? "未知错误"}` : compaction?.status === "completed" ? `已在序列 ${compaction.lastSequence} 压缩 ${compaction.droppedMessages} 条消息${compaction.truncatedToolResults === undefined || compaction.truncatedToolResults === 0 ? "" : `，截断 ${compaction.truncatedToolResults} 个工具结果`}。` : "上下文 token 数根据回放后的会话消息估算。";
  return { status, label, ...(budget === undefined ? {} : { maxTokens: budget, ratio: ratio as number }), usedTokens: effectiveUsed, detail };
}

function presentDurableContextMeter(diagnostics: ContextDiagnosticsProjection): ContextMeterRenderIntent {
  const maxTokens = diagnostics.effectiveWindowTokens;
  const ratio = maxTokens > 0 ? Math.min(1, diagnostics.tokenUsage / maxTokens) : undefined;
  const compact = diagnostics.lastCompaction;
  const recovery = diagnostics.recoveryChain.length;
  const compactDetail = compact === undefined
    ? ""
    : compact.status === "failed"
      ? ` 上次压缩失败${compact.error === undefined ? "" : `：${compact.error}`}。`
      : ` 上次压缩${compact.kind === undefined ? "" : `（${compact.kind}）`}${compact.tokensSaved === undefined ? "" : `，节省 ${compact.tokensSaved} tokens`}。`;
  const recoveryDetail = recovery === 0 ? "" : ` 恢复链：${recovery} 个事件。`;
  const detail = `Token 来源：${diagnostics.tokenSource}（${diagnostics.tokenConfidence}）；剩余 ${diagnostics.percentLeft}%。阈值（警告/错误/自动压缩/阻断）：${diagnostics.warningThreshold}/${diagnostics.errorThreshold}/${diagnostics.autoCompactThreshold}/${diagnostics.blockingThreshold}.${compactDetail}${recoveryDetail}`;
  return {
    status: diagnostics.level,
    label: maxTokens > 0 ? `上下文 · ${diagnostics.tokenUsage}/${maxTokens}` : `上下文 · ${diagnostics.tokenUsage} tokens`,
    usedTokens: diagnostics.tokenUsage,
    ...(maxTokens > 0 && ratio !== undefined ? { maxTokens, ratio } : {}),
    detail,
    source: diagnostics.tokenSource,
    confidence: diagnostics.tokenConfidence,
    percentLeft: diagnostics.percentLeft,
  };
}

export function presentContextDiagnostics(session: SessionProjection | undefined): ContextDiagnosticsRenderIntent {
  const diagnostics = session?.contextDiagnostics;
  if (diagnostics === undefined) return { status: "unknown", detail: "暂无持久化上下文诊断信息。" };
  return {
    status: diagnostics.level,
    detail: `上下文 ${diagnostics.tokenUsage}/${diagnostics.effectiveWindowTokens} tokens；剩余 ${diagnostics.percentLeft}%；来源 ${diagnostics.tokenSource}/${diagnostics.tokenConfidence}。`,
    diagnostics,
  };
}

export interface ContextDiagnosticsRenderIntent {
  readonly status: ContextDiagnosticsProjection["level"];
  readonly detail: string;
  readonly diagnostics?: ContextDiagnosticsProjection;
}
