import { describe, expect, it } from "vitest";
import { brand, type SessionSummary } from "@code-review-agent/contracts";
import {
  COLLAPSED_SESSION_LIMIT,
  navigationEmptyMessage,
  presentSidebarNavigation,
  windowSessionGroup,
} from "./sidebar-presenter.js";

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

describe("presentSidebarNavigation", () => {
  it("normalizes view options and exposes active group plus empty copy", () => {
    const selected = session("ses_selected", { workspaceRoot: "D:/selected" });
    const projection = presentSidebarNavigation([selected], {
      activeSessionId: selected.id,
      query: "  SELECTED  ",
      viewMode: "invalid" as never,
      sort: "invalid" as never,
    });

    expect(projection.query).toBe("selected");
    expect(projection.viewMode).toBe("tree");
    expect(projection.sort).toBe("recent");
    expect(projection.activeGroupKey).toBe(projection.activeWorkspaceKey);
    expect(projection.emptyMessage).toBe("No sessions match this search.");
  });

  it("keeps selection separate from visibility filters", () => {
    const archived = session("ses_archived", { archived: true });
    const projection = presentSidebarNavigation([archived], { selectedSessionId: archived.id });

    expect(projection.selectedSessionId).toBe(archived.id);
    expect(projection.activeGroupKey).toBeUndefined();
    expect(projection.emptyMessage).toBe("No active sessions. Create a session to start coding.");
  });
});

describe("windowSessionGroup", () => {
  it("applies the DSH-style five-row default and overflow count", () => {
    const values = [1, 2, 3, 4, 5, 6, 7];
    const collapsed = windowSessionGroup(values, false);
    expect(COLLAPSED_SESSION_LIMIT).toBe(5);
    expect(collapsed.visible).toEqual([1, 2, 3, 4, 5]);
    expect(collapsed.hiddenCount).toBe(2);
    expect(windowSessionGroup(values, true).visible).toEqual(values);
  });
});

describe("navigationEmptyMessage", () => {
  it("prioritizes search, archived, and active empty states", () => {
    expect(navigationEmptyMessage({ emptyState: "search", query: "x", showArchived: false })).toBe("No sessions match this search.");
    expect(navigationEmptyMessage({ emptyState: "archived", query: "", showArchived: true })).toBe("No archived sessions.");
    expect(navigationEmptyMessage({ emptyState: "none", query: "", showArchived: false })).toBe("No active sessions. Create a session to start coding.");
  });
});
