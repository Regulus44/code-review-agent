import { describe, expect, it } from "vitest";
import { brand, type SessionSummary } from "@code-review-agent/contracts";
import { buildNavigationModel, sessionRelativeTime, workspaceKey } from "./navigation-presenter.js";

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: brand<string, "SessionId">(id),
    workspaceRoot: "D:/repo",
    permissionPreset: "ask-on-write",
    archived: false,
    deleted: false,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
    status: "idle",
    lastSequence: 1,
    ...overrides,
  };
}

describe("buildNavigationModel", () => {
  it("groups workspaces case-insensitively on Windows and keeps recent roots unique", () => {
    const model = buildNavigationModel([
      session("ses_a", { workspaceRoot: "D:/Repo" }),
      session("ses_b", { workspaceRoot: "d:\\repo\\", updatedAt: "2026-08-23T11:00:00.000Z" }),
    ]);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.sessions.map((item) => item.id)).toEqual(["ses_b", "ses_a"]);
    expect(model.recentWorkspaces).toEqual(["D:/Repo"]);
    expect(workspaceKey("D:/Repo")).toBe(workspaceKey("d:\\repo\\"));
  });

  it("retains parent/child lineage and filters archived/deleted roots", () => {
    const parent = session("ses_parent", { title: "Parent" });
    const child = session("ses_child", { title: "Child", parentSessionId: parent.id, childMode: "one-shot", childProvider: "fixture" });
    const archived = session("ses_archived", { archived: true });
    const deleted = session("ses_deleted", { deleted: true });
    const model = buildNavigationModel([parent, child, archived, deleted]);
    expect(model.groups[0]?.sessions[0]?.children[0]?.id).toBe("ses_child");
    expect(model.allSessions.map((item) => item.id)).toEqual(["ses_parent", "ses_child", "ses_archived"]);
    expect(buildNavigationModel([parent, child], { activeSessionId: child.id }).activeWorkspaceKey).toBe(workspaceKey(parent.workspaceRoot));
    expect(buildNavigationModel([parent, archived], { showArchived: true }).groups[0]?.sessions[0]?.id).toBe("ses_archived");
  });

  it("keeps ancestors when a child matches search", () => {
    const parent = session("ses_parent", { title: "Review" });
    const child = session("ses_child", { title: "Security scan", parentSessionId: parent.id });
    const model = buildNavigationModel([parent, child], { query: "security" });
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.sessions[0]?.id).toBe("ses_parent");
    expect(model.groups[0]?.sessions[0]?.children.map((item) => item.id)).toEqual(["ses_child"]);
    expect(model.emptyState).toBe("none");
  });

  it("returns explicit empty states and bounded relative times", () => {
    const sessions = [session("ses_a")];
    expect(buildNavigationModel(sessions, { query: "missing" }).emptyState).toBe("search");
    expect(buildNavigationModel(sessions, { showArchived: true }).emptyState).toBe("archived");
    expect(sessionRelativeTime("2026-08-23T09:59:30.000Z", Date.parse("2026-08-23T10:00:00.000Z"))).toBe("now");
    expect(sessionRelativeTime("invalid", Date.now())).toBe("");
  });
});
