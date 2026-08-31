import { describe, expect, it } from "vitest";
import { brand, type SessionSummary, type WorkspaceSummary } from "@code-review-agent/contracts";
import { buildNavigationModel, sessionRelativeTime, workspaceKey, type SidebarNavigationState } from "./navigation-presenter.js";

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

  it("freezes Web selection ownership and derives the active workspace", () => {
    const selected = session("ses_selected", { workspaceRoot: "D:/selected" });
    const other = session("ses_other", { workspaceRoot: "D:/other" });
    const intent = buildNavigationModel([selected, other], { selectedSessionId: selected.id });
    expect(intent.selectedSessionId).toBe(selected.id);
    expect(intent.activeWorkspaceKey).toBe(workspaceKey(selected.workspaceRoot));

    // The legacy bridge name remains source-compatible during the migration,
    // but it has the exact same selection semantics.
    expect(buildNavigationModel([selected], { activeSessionId: selected.id }).selectedSessionId).toBe(selected.id);
  });

  it("keeps a selected Session source distinct from visibility filters", () => {
    const archived = session("ses_archived_selected", { archived: true });
    const intent = buildNavigationModel([archived], { selectedSessionId: archived.id });
    expect(intent.selectedSessionId).toBe(archived.id);
    expect(intent.activeWorkspaceKey).toBeUndefined();
    expect(intent.showArchived).toBe(false);
  });

  it("expresses sidebar browsing state as Web-only data", () => {
    const state = {
      viewMode: "tree",
      sort: "recent",
      searchQuery: "",
      showArchived: false,
      expandedWorkspaces: { "d:/repo": true },
    } satisfies SidebarNavigationState;
    expect(state.expandedWorkspaces["d:/repo"]).toBe(true);
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

  it("honors the durable workspace order before recency fallback", () => {
    const first = session("ses_first", { workspaceRoot: "D:/first", updatedAt: "2026-08-23T12:00:00.000Z" });
    const second = session("ses_second", { workspaceRoot: "D:/second", updatedAt: "2026-08-23T13:00:00.000Z" });
    const model = buildNavigationModel([first, second], { workspaceOrder: ["D:/first", "D:/second"] });
    expect(model.groups.map((group) => group.root)).toEqual(["D:/first", "D:/second"]);
  });

  it("uses workspace lifecycle metadata for labels and archive filtering", () => {
    const active = session("ses_active", { workspaceRoot: "D:/lifecycle" });
    const archived = session("ses_archived_workspace", { workspaceRoot: "D:/archived-workspace" });
    const catalog: WorkspaceSummary[] = [
      { key: workspaceKey("D:/lifecycle"), root: "D:/lifecycle", position: 0, sessionCount: 1, label: "Review workspace" },
      { key: workspaceKey("D:/archived-workspace"), root: "D:/archived-workspace", position: 1, sessionCount: 1, archived: true },
    ];
    const activeModel = buildNavigationModel([active, archived], { workspaceCatalog: catalog });
    expect(activeModel.groups.map((group) => group.label || group.root)).toEqual(["Review workspace"]);
    const archivedModel = buildNavigationModel([active, archived], { showArchived: true, workspaceCatalog: catalog });
    expect(archivedModel.groups.map((group) => group.root)).toEqual(["D:/archived-workspace"]);
  });

  it("hides sessions whose workspace was soft-deleted while retaining their history", () => {
    const deletedWorkspaceSession = session("ses_deleted_workspace", { workspaceRoot: "D:/deleted-workspace" });
    const catalog: WorkspaceSummary[] = [{ key: workspaceKey("D:/repo"), root: "D:/repo", position: 0, sessionCount: 1 }];
    const model = buildNavigationModel([session("ses_active"), deletedWorkspaceSession], { workspaceCatalog: catalog });
    expect(model.groups.map((group) => group.root)).toEqual(["D:/repo"]);
    expect(model.allSessions.map((item) => item.id)).toEqual(["ses_active", "ses_deleted_workspace"]);
  });

  it("supports flat navigation and deterministic name/path sorting", () => {
    const zulu = session("ses_zulu", { title: "Zulu", workspaceRoot: "D:/zulu" });
    const alpha = session("ses_alpha", { title: "Alpha", workspaceRoot: "D:/alpha" });
    const flat = buildNavigationModel([zulu, alpha], { viewMode: "flat", sort: "name" });
    expect(flat.viewMode).toBe("flat");
    expect(flat.sort).toBe("name");
    expect(flat.groups.map((group) => group.root)).toEqual(["D:/alpha", "D:/zulu"]);
    expect(flat.groups.every((group) => group.sessions.every((item) => item.children.length === 0))).toBe(true);
    const byPath = buildNavigationModel([zulu, alpha], { sort: "path" });
    expect(byPath.groups.map((group) => group.root)).toEqual(["D:/alpha", "D:/zulu"]);
  });
});
