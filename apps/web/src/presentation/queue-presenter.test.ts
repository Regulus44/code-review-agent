import { describe, expect, it } from "vitest";
import type { SessionProjection } from "@code-review-agent/contracts";
import { presentQueue } from "./queue-presenter.js";

const session = (turns: SessionProjection["turns"]): SessionProjection => ({
  id: "ses_queue" as SessionProjection["id"],
  workspaceRoot: ".",
  permissionPreset: "ask-on-write",
  archived: false,
  deleted: false,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:03.000Z",
  status: "queued",
  lastSequence: 3,
  messages: [],
  turns,
  tasks: [],
  goals: [],
  plan: { content: "", status: "cleared", updatedAt: "2026-08-23T00:00:00.000Z", lastSequence: 0 },
  todos: [],
  interactions: [],
  toolCalls: [],
  permissions: [],
});

describe("presentQueue", () => {
  it("orders active and queued turns from durable sequence", () => {
    const intent = presentQueue(session([
      { id: "turn_2" as never, status: "queued", createdAt: "2026-08-23T00:00:02.000Z", updatedAt: "2026-08-23T00:00:02.000Z", userMessage: "second", lastSequence: 3 },
      { id: "turn_1" as never, status: "running", createdAt: "2026-08-23T00:00:01.000Z", updatedAt: "2026-08-23T00:00:01.000Z", userMessage: "first", lastSequence: 2 },
    ]));
    expect(intent).toMatchObject({ visible: true, pendingCount: 1, activeTurnId: "turn_1", reorderSupported: false });
    expect(intent.items.map((item) => [item.turnId, item.position, item.status])).toEqual([
      ["turn_1", 1, "running"],
      ["turn_2", 2, "queued"],
    ]);
  });

  it("uses bounded, whitespace-normalized messages and explicit empty state", () => {
    const intent = presentQueue(session([
      { id: "turn_1" as never, status: "queued", createdAt: "2026-08-23T00:00:01.000Z", updatedAt: "2026-08-23T00:00:01.000Z", userMessage: "  a   b  ", lastSequence: 1 },
    ]), 32);
    expect(intent.items[0]?.message).toBe("a b");
    expect(presentQueue(session([]))).toMatchObject({ visible: false, pendingCount: 0, items: [] });
  });
});
