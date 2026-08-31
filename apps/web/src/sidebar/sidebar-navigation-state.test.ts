import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_NAVIGATION_STATE,
  SIDEBAR_NAVIGATION_STORAGE_KEY,
  createSidebarNavigationPersistence,
  createSidebarNavigationState,
  reduceSidebarNavigation,
  serializeSidebarNavigationState,
} from "./sidebar-navigation-state.js";

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("sidebar navigation reducer", () => {
  it("updates view, sort, archive and lifecycle search state immutably", () => {
    const initial = createSidebarNavigationState();
    const next = reduceSidebarNavigation(initial, { type: "set-view-mode", viewMode: "flat" });
    const sorted = reduceSidebarNavigation(next, { type: "set-sort", sort: "path" });
    const archived = reduceSidebarNavigation(sorted, { type: "set-show-archived", showArchived: true });
    const searched = reduceSidebarNavigation(archived, { type: "set-search-query", searchQuery: "  hello  " });

    expect(initial).toEqual(DEFAULT_SIDEBAR_NAVIGATION_STATE);
    expect(searched).toMatchObject({ viewMode: "flat", sort: "path", showArchived: true, searchQuery: "  hello  " });
    expect(searched).not.toBe(initial);
    expect(reduceSidebarNavigation(searched, { type: "clear-search" }).searchQuery).toBe("");
  });

  it("tracks workspace and session-group expansion and prunes stale keys", () => {
    let state = createSidebarNavigationState();
    state = reduceSidebarNavigation(state, { type: "toggle-workspace", key: "repo-a" });
    state = reduceSidebarNavigation(state, { type: "toggle-session-group", key: "repo-a" });
    state = reduceSidebarNavigation(state, { type: "ensure-workspace-expanded", key: "repo-b" });
    expect(state.expandedWorkspaces).toEqual({ "repo-a": true, "repo-b": true });
    expect(state.expandedSessionGroups).toEqual({ "repo-a": true });

    state = reduceSidebarNavigation(state, { type: "remove-workspace-key", key: "repo-a" });
    expect(state.expandedWorkspaces).toEqual({ "repo-b": true });
    expect(state.expandedSessionGroups).toEqual({});
    state = reduceSidebarNavigation(state, { type: "retain-workspace-keys", keys: ["repo-c"] });
    expect(state.expandedWorkspaces).toEqual({});

    state = reduceSidebarNavigation(createSidebarNavigationState(), { type: "toggle-workspace", key: "repo-a" });
    state = reduceSidebarNavigation(state, { type: "toggle-workspace", key: "repo-a" });
    expect(state.expandedWorkspaces).toEqual({ "repo-a": false });
  });
});

describe("sidebar navigation local persistence", () => {
  it("restores preferences while keeping search page-lifecycle scoped", () => {
    const storage = memoryStorage();
    const persistence = createSidebarNavigationPersistence({ storage });
    const state = reduceSidebarNavigation(
      reduceSidebarNavigation(createSidebarNavigationState(), { type: "set-sort", sort: "name" }),
      { type: "set-search-query", searchQuery: "needle" },
    );
    persistence.save(state);

    expect(storage.values.has(SIDEBAR_NAVIGATION_STORAGE_KEY)).toBe(true);
    expect(JSON.parse(storage.values.get(SIDEBAR_NAVIGATION_STORAGE_KEY)!).searchQuery).toBe("");
    expect(persistence.load()).toMatchObject({ sort: "name", searchQuery: "" });
    expect(serializeSidebarNavigationState(state, { persistSearchQuery: true }).searchQuery).toBe("needle");
  });

  it("fails soft for corrupt payloads and storage exceptions", () => {
    const corrupt = memoryStorage({ [SIDEBAR_NAVIGATION_STORAGE_KEY]: "{not-json" });
    expect(createSidebarNavigationPersistence({ storage: corrupt }).load()).toEqual(DEFAULT_SIDEBAR_NAVIGATION_STATE);

    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    const persistence = createSidebarNavigationPersistence({ storage: throwing });
    expect(() => persistence.load()).not.toThrow();
    expect(() => persistence.save(createSidebarNavigationState())).not.toThrow();
    expect(() => persistence.clear()).not.toThrow();
  });

  it("sanitizes unknown persisted values", () => {
    const storage = memoryStorage({
      [SIDEBAR_NAVIGATION_STORAGE_KEY]: JSON.stringify({
        viewMode: "unknown",
        sort: "wat",
        showArchived: "yes",
        expandedWorkspaces: { repo: true, ignored: false, "": true },
        expandedSessionGroups: { repo: true },
      }),
    });
    expect(createSidebarNavigationPersistence({ storage }).load()).toEqual({
      ...DEFAULT_SIDEBAR_NAVIGATION_STATE,
      expandedWorkspaces: { repo: true, ignored: false },
      expandedSessionGroups: { repo: true },
    });
  });
});
