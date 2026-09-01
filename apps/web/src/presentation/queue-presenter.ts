import type { SessionProjection, TurnId, TurnProjection } from "@coding-agent/contracts";

export type QueueItemStatus = "queued" | "running";

export interface QueueItemView {
  readonly turnId: TurnId;
  readonly status: QueueItemStatus;
  readonly position: number;
  readonly queuePosition?: number;
  readonly message: string;
  readonly createdAt: string;
  readonly cancellable: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
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
    .sort((left, right) => {
      if (left.status === "running" && right.status !== "running") return -1;
      if (right.status === "running" && left.status !== "running") return 1;
      return (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER) || left.lastSequence - right.lastSequence;
    }) ?? [];
  const queued = turns.filter((turn) => turn.status === "queued");
  const items = turns.map((turn, index) => {
    const queuePosition = turn.status === "queued"
      ? (turn.queuePosition ?? (queued.findIndex((item) => item.id === turn.id) + 1))
      : undefined;
    return {
    turnId: turn.id,
    status: turn.status,
    position: index + 1,
    ...(queuePosition === undefined ? {} : { queuePosition }),
    message: bounded(turn.userMessage ?? "排队中的回合", maxMessageChars),
    createdAt: turn.createdAt,
    cancellable: true,
    canMoveUp: turn.status === "queued" && (queuePosition ?? 1) > 1,
    canMoveDown: turn.status === "queued" && (queuePosition ?? 1) < queued.length,
    };
  });
  const active = items.find((item) => item.status === "running");
  return {
    visible: items.length > 0,
    pendingCount: items.filter((item) => item.status === "queued").length,
    ...(active === undefined ? {} : { activeTurnId: active.turnId }),
    items,
    reorderSupported: queued.length > 1,
    reorderReason: queued.length > 1 ? "" : "Queue reorder requires at least two queued turns.",
  };
}

function bounded(value: string, maxChars: number): string {
  const limit = Math.max(32, Math.floor(maxChars));
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
