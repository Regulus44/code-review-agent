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
  if (session === undefined) return { status: "unknown", label: "Context · unknown", detail: "No session projection is available." };
  const diagnostics = session.contextDiagnostics;
  if (diagnostics !== undefined) return presentDurableContextMeter(diagnostics);
  const budget = maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : undefined;
  const usedTokens = estimateMessagesTokens(session.messages.map((message) => ({ role: message.role, content: message.content })));
  const compaction = session.contextCompaction;
  const effectiveUsed = compaction?.estimatedTokens ?? usedTokens;
  const status = compaction?.status === "failed" ? "failed" : compaction?.status === "completed" ? "compacted" : budget === undefined ? "unknown" : "healthy";
  const ratio = budget === undefined ? undefined : Math.min(1, effectiveUsed / budget);
  const label = budget === undefined ? `Context · ${effectiveUsed} tokens` : `Context · ${effectiveUsed}/${budget}`;
  const detail = compaction?.status === "failed" ? `Compaction failed: ${compaction.error ?? "unknown error"}` : compaction?.status === "completed" ? `Compacted ${compaction.droppedMessages} message${compaction.droppedMessages === 1 ? "" : "s"} at sequence ${compaction.lastSequence}${compaction.truncatedToolResults === undefined || compaction.truncatedToolResults === 0 ? "" : `; truncated ${compaction.truncatedToolResults} tool result${compaction.truncatedToolResults === 1 ? "" : "s"}`}.` : "Context is estimated from the replayed session messages.";
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
      ? ` Last compact failed${compact.error === undefined ? "" : `: ${compact.error}`}.`
      : ` Last compact${compact.kind === undefined ? "" : ` (${compact.kind})`}${compact.tokensSaved === undefined ? "" : ` saved ${compact.tokensSaved} tokens`}.`;
  const recoveryDetail = recovery === 0 ? "" : ` Recovery chain: ${recovery} event${recovery === 1 ? "" : "s"}.`;
  const detail = `Token source: ${diagnostics.tokenSource} (${diagnostics.tokenConfidence}); ${diagnostics.percentLeft}% remaining. Thresholds warning/error/auto/blocking: ${diagnostics.warningThreshold}/${diagnostics.errorThreshold}/${diagnostics.autoCompactThreshold}/${diagnostics.blockingThreshold}.${compactDetail}${recoveryDetail}`;
  return {
    status: diagnostics.level,
    label: maxTokens > 0 ? `Context · ${diagnostics.tokenUsage}/${maxTokens}` : `Context · ${diagnostics.tokenUsage} tokens`,
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
  if (diagnostics === undefined) return { status: "unknown", detail: "No durable context diagnostics are available." };
  return {
    status: diagnostics.level,
    detail: `Context ${diagnostics.tokenUsage}/${diagnostics.effectiveWindowTokens} tokens; ${diagnostics.percentLeft}% remaining; source ${diagnostics.tokenSource}/${diagnostics.tokenConfidence}.`,
    diagnostics,
  };
}

export interface ContextDiagnosticsRenderIntent {
  readonly status: ContextDiagnosticsProjection["level"];
  readonly detail: string;
  readonly diagnostics?: ContextDiagnosticsProjection;
}
