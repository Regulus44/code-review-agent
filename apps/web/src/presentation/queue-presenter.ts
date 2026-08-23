import type { SessionProjection, TurnId, TurnProjection } from "@code-review-agent/contracts";

export type QueueItemStatus = "queued" | "running";

export interface QueueItemView {
  readonly turnId: TurnId;
  readonly status: QueueItemStatus;
  readonly position: number;
  readonly message: string;
  readonly createdAt: string;
  readonly cancellable: boolean;
}

export interface QueueRenderIntent {
  readonly visible: boolean;
  readonly pendingCount: number;
  readonly activeTurnId?: TurnId;
  readonly items: readonly QueueItemView[];
  readonly reorderSupported: boolean;
  readonly reorderReason: string;
}

/**
 * Present the host-owned turn queue without creating a second queue fact in
 * the browser. Ordering comes from the durable TurnProjection sequence.
 */
export function presentQueue(session?: SessionProjection, maxMessageChars = 180): QueueRenderIntent {
  const turns = session?.turns
    .filter((turn): turn is TurnProjection & { readonly status: QueueItemStatus } => turn.status === "queued" || turn.status === "running")
    .sort((left, right) => left.lastSequence - right.lastSequence) ?? [];
  const items = turns.map((turn, index) => ({
    turnId: turn.id,
    status: turn.status,
    position: index + 1,
    message: bounded(turn.userMessage ?? "Queued turn", maxMessageChars),
    createdAt: turn.createdAt,
    cancellable: true,
  }));
  const active = items.find((item) => item.status === "running");
  return {
    visible: items.length > 0,
    pendingCount: items.filter((item) => item.status === "queued").length,
    ...(active === undefined ? {} : { activeTurnId: active.turnId }),
    items,
    // The current host contract exposes cancellation but not queue reorder.
    // Keep that limitation explicit instead of simulating a reorder locally.
    reorderSupported: false,
    reorderReason: "Ordering is managed by the AgentHost; reordering is not available yet.",
  };
}

function bounded(value: string, maxChars: number): string {
  const limit = Math.max(32, Math.floor(maxChars));
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
