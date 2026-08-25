import { describe, expect, it } from "vitest";
import type { InteractionNode, PermissionNode } from "../projection/conversation.js";
import { presentInteraction, presentPermission, presentPendingRequests } from "./request-presenter.js";

const permission = (overrides: Partial<PermissionNode> = {}): PermissionNode => ({
  key: "permission:fixture",
  kind: "permission",
  sequence: 1,
  lastSequence: 1,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  eventType: "permission/requested",
  permissionId: "permission_fixture" as PermissionNode["permissionId"],
  toolCallId: "tool_fixture" as PermissionNode["toolCallId"],
  toolName: "write_file",
  status: "pending",
  reason: "write approval",
  caller: "agent",
  workspaceRoot: "D:/workspace",
  expiresAt: "2026-08-23T00:01:00.000Z",
  input: { path: "secret.txt", token: "do-not-show" },
  ...overrides,
});

const interaction = (overrides: Partial<InteractionNode> = {}): InteractionNode => ({
  key: "interaction:fixture",
  kind: "interaction",
  sequence: 1,
  lastSequence: 1,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  eventType: "interaction/requested",
  interactionId: "interaction_fixture" as InteractionNode["interactionId"],
  toolCallId: "tool_fixture" as InteractionNode["toolCallId"],
  question: "Continue?",
  status: "pending",
  caller: "agent",
  allowFreeform: true,
  expiresAt: "2026-08-23T00:01:00.000Z",
  options: [{ label: "Yes", value: "yes" }],
  ...overrides,
});

describe("request presenters", () => {
  it("disables a permission after its deadline even before the resolved event arrives", () => {
    const view = presentPermission(permission(), { now: Date.parse("2026-08-23T00:02:00.000Z") });
    expect(view.status).toBe("expired");
    expect(view.interactive).toBe(false);
    expect(view.actions).toEqual([]);
    expect(view.recovery).toBe("expired");
    expect(view.details.text).toContain("[redacted]");
  });

  it("marks pending requests on an interrupted session as recoverable", () => {
    const context = { sessionStatus: "interrupted", now: Date.parse("2026-08-23T00:00:30.000Z") };
    const approval = presentPermission(permission(), context);
    const question = presentInteraction(interaction(), context);
    expect(approval).toMatchObject({ status: "pending", recovery: "restored", interactive: true });
    expect(question).toMatchObject({ status: "pending", recovery: "restored", interactive: true });
    expect(approval.recoveryLabel).toContain("Recovered");
    expect(question.recoveryLabel).toContain("Recovered");
  });

  it("preserves terminal interaction status and removes answer actions", () => {
    const view = presentInteraction(interaction({ status: "expired" }), { now: Date.parse("2026-08-23T00:00:30.000Z") });
    expect(view).toMatchObject({ status: "expired", interactive: false, recovery: "expired", actions: [] });
    expect(view.summary).toBe("Question expired");
  });

  it("selects one active request with question priority", () => {
    const approval = permission({ key: "permission:early", sequence: 2 });
    const question = interaction({ key: "interaction:later", sequence: 9 });
    const view = presentPendingRequests([approval, question], { now: Date.parse("2026-08-23T00:00:30.000Z") });
    expect(view.pendingCount).toBe(2);
    expect(view.active?.kind).toBe("interaction");
    expect(view.active?.key).toBe("interaction:later");
  });

  it("does not select expired requests as a Composer takeover", () => {
    const view = presentPendingRequests([permission()], { now: Date.parse("2026-08-23T00:02:00.000Z") });
    expect(view.pending).toEqual([]);
    expect(view.active).toBeUndefined();
  });
});
