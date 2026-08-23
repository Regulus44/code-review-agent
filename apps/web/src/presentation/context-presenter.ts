import type { SessionProjection } from "@code-review-agent/contracts";
import { estimateMessagesTokens } from "@code-review-agent/compaction";

export interface ContextMeterRenderIntent {
  readonly status: "unknown" | "healthy" | "compacted" | "failed";
  readonly label: string;
  readonly usedTokens?: number;
  readonly maxTokens?: number;
  readonly ratio?: number;
  readonly detail: string;
}

export function presentContextMeter(session: SessionProjection | undefined, maxTokens?: number): ContextMeterRenderIntent {
  if (session === undefined) return { status: "unknown", label: "Context · unknown", detail: "No session projection is available." };
  const budget = maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : undefined;
  const usedTokens = estimateMessagesTokens(session.messages.map((message) => ({ role: message.role, content: message.content })));
  const compaction = session.contextCompaction;
  const effectiveUsed = compaction?.estimatedTokens ?? usedTokens;
  const status = compaction?.status === "failed" ? "failed" : compaction?.status === "completed" ? "compacted" : budget === undefined ? "unknown" : "healthy";
  const ratio = budget === undefined ? undefined : Math.min(1, effectiveUsed / budget);
  const label = budget === undefined ? `Context · ${effectiveUsed} tokens` : `Context · ${effectiveUsed}/${budget}`;
  const detail = compaction?.status === "failed" ? `Compaction failed: ${compaction.error ?? "unknown error"}` : compaction?.status === "completed" ? `Compacted ${compaction.droppedMessages} message${compaction.droppedMessages === 1 ? "" : "s"} at sequence ${compaction.lastSequence}.` : "Context is estimated from the replayed session messages.";
  return { status, label, ...(budget === undefined ? {} : { maxTokens: budget, ratio: ratio as number }), usedTokens: effectiveUsed, detail };
}
