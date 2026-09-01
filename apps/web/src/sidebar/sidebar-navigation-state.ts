/**
 * Browser-local navigation preferences for the Workspace/Session sidebar.
 *
 * This module deliberately owns no Session or Workspace facts.  The reducer
 * only changes view preferences and expansion state; the API/EventStore
 * projection remains the source of truth for what can be navigated.
 */

export type SidebarViewMode = "tree" | "flat";
export type SidebarSort = "recent" | "name" | "path";

export interface SidebarNavigationState {
  readonly viewMode: SidebarViewMode;
  readonly sort: SidebarSort;
  /** Raw input for the current page. Search is intentionally not persisted by default. */
  readonly searchQuery: string;
  readonly showArchived: boolean;
  /** Workspace keys with an explicitly expanded group. Missing means collapsed. */
  readonly expandedWorkspaces: Readonly<Record<string, boolean>>;
  /** Workspace keys with an explicitly expanded five-row Session window. */
  readonly expandedSessionGroups: Readonly<Record<string, boolean>>;
}

export const SIDEBAR_NAVIGATION_STORAGE_KEY = "coding-agent.sidebar.navigation.v1";

export const DEFAULT_SIDEBAR_NAVIGATION_STATE: SidebarNavigationState = {
  viewMode: "tree",
  sort: "recent",
  searchQuery: "",
  showArchived: false,
  expandedWorkspaces: {},
  expandedSessionGroups: {},
};

export type SidebarNavigationAction =
  | { readonly type: "set-view-mode"; readonly viewMode: SidebarViewMode }
  | { readonly type: "set-sort"; readonly sort: SidebarSort }
  | { readonly type: "set-search-query"; readonly searchQuery: string }
  | { readonly type: "clear-search" }
  | { readonly type: "set-show-archived"; readonly showArchived: boolean }
  | { readonly type: "toggle-workspace"; readonly key: string }
  | { readonly type: "set-workspace-expanded"; readonly key: string; readonly expanded: boolean }
  | { readonly type: "ensure-workspace-expanded"; readonly key: string }
  | { readonly type: "toggle-session-group"; readonly key: string }
  | { readonly type: "set-session-group-expanded"; readonly key: string; readonly expanded: boolean }
  | { readonly type: "retain-workspace-keys"; readonly keys: readonly string[] }
  | { readonly type: "remove-workspace-key"; readonly key: string }
  | { readonly type: "reset" };

export interface SidebarNavigationActionCreators {
  readonly setViewMode: (viewMode: SidebarViewMode) => SidebarNavigationAction;
  readonly setSort: (sort: SidebarSort) => SidebarNavigationAction;
  readonly setSearchQuery: (searchQuery: string) => SidebarNavigationAction;
  readonly clearSearch: () => SidebarNavigationAction;
  readonly setShowArchived: (showArchived: boolean) => SidebarNavigationAction;
  readonly toggleWorkspace: (key: string) => SidebarNavigationAction;
  readonly setWorkspaceExpanded: (key: string, expanded: boolean) => SidebarNavigationAction;
  readonly ensureWorkspaceExpanded: (key: string) => SidebarNavigationAction;
  readonly toggleSessionGroup: (key: string) => SidebarNavigationAction;
  readonly setSessionGroupExpanded: (key: string, expanded: boolean) => SidebarNavigationAction;
  readonly retainWorkspaceKeys: (keys: readonly string[]) => SidebarNavigationAction;
  readonly removeWorkspaceKey: (key: string) => SidebarNavigationAction;
  readonly reset: () => SidebarNavigationAction;
}

export const sidebarNavigationActions: SidebarNavigationActionCreators = {
  setViewMode: (viewMode) => ({ type: "set-view-mode", viewMode }),
  setSort: (sort) => ({ type: "set-sort", sort }),
  setSearchQuery: (searchQuery) => ({ type: "set-search-query", searchQuery }),
  clearSearch: () => ({ type: "clear-search" }),
  setShowArchived: (showArchived) => ({ type: "set-show-archived", showArchived }),
  toggleWorkspace: (key) => ({ type: "toggle-workspace", key }),
  setWorkspaceExpanded: (key, expanded) => ({ type: "set-workspace-expanded", key, expanded }),
  ensureWorkspaceExpanded: (key) => ({ type: "ensure-workspace-expanded", key }),
  toggleSessionGroup: (key) => ({ type: "toggle-session-group", key }),
  setSessionGroupExpanded: (key, expanded) => ({ type: "set-session-group-expanded", key, expanded }),
  retainWorkspaceKeys: (keys) => ({ type: "retain-workspace-keys", keys }),
  removeWorkspaceKey: (key) => ({ type: "remove-workspace-key", key }),
  reset: () => ({ type: "reset" }),
};

export function createSidebarNavigationState(
  overrides: Partial<SidebarNavigationState> = {},
): SidebarNavigationState {
  return {
    viewMode: normalizeViewMode(overrides.viewMode),
    sort: normalizeSort(overrides.sort),
    searchQuery: typeof overrides.searchQuery === "string" ? overrides.searchQuery : "",
    showArchived: overrides.showArchived === true,
    expandedWorkspaces: normalizeExpandedRecord(overrides.expandedWorkspaces),
    expandedSessionGroups: normalizeExpandedRecord(overrides.expandedSessionGroups),
  };
}

/** Pure reducer: no DOM, storage, API or EventStore side effects. */
export function reduceSidebarNavigation(
  state: SidebarNavigationState,
  action: SidebarNavigationAction,
): SidebarNavigationState {
  const current = createSidebarNavigationState(state);
  switch (action.type) {
    case "set-view-mode":
      return current.viewMode === normalizeViewMode(action.viewMode)
        ? current
        : { ...current, viewMode: normalizeViewMode(action.viewMode) };
    case "set-sort":
      return current.sort === normalizeSort(action.sort)
        ? current
        : { ...current, sort: normalizeSort(action.sort) };
    case "set-search-query": {
      const searchQuery = typeof action.searchQuery === "string" ? action.searchQuery : String(action.searchQuery ?? "");
      return current.searchQuery === searchQuery ? current : { ...current, searchQuery };
    }
    case "clear-search":
      return current.searchQuery === "" ? current : { ...current, searchQuery: "" };
    case "set-show-archived":
      return current.showArchived === action.showArchived
        ? current
        : { ...current, showArchived: action.showArchived === true };
    case "toggle-workspace":
      return setExpanded(current, "expandedWorkspaces", action.key, !isExpanded(current.expandedWorkspaces, action.key));
    case "set-workspace-expanded":
      return setExpanded(current, "expandedWorkspaces", action.key, action.expanded);
    case "ensure-workspace-expanded":
      return setExpanded(current, "expandedWorkspaces", action.key, true);
    case "toggle-session-group":
      return setExpanded(current, "expandedSessionGroups", action.key, !isExpanded(current.expandedSessionGroups, action.key));
    case "set-session-group-expanded":
      return setExpanded(current, "expandedSessionGroups", action.key, action.expanded);
    case "retain-workspace-keys":
      return retainWorkspaceKeys(current, action.keys);
    case "remove-workspace-key":
      return removeWorkspaceKey(current, action.key);
    case "reset":
      return createSidebarNavigationState();
    default:
      return current;
  }
}

function setExpanded(
  state: SidebarNavigationState,
  field: "expandedWorkspaces" | "expandedSessionGroups",
  key: string,
  expanded: boolean,
): SidebarNavigationState {
  const normalizedKey = normalizeKey(key);
  if (normalizedKey === "") return state;
  const previous = state[field][normalizedKey] === true;
  const nextExpanded = expanded === true;
  if (previous === nextExpanded) return state;
  const next = { ...state[field] };
  // Keep an explicit false entry to mirror DSH's groupExpansion account. It
  // makes the persisted choice deterministic while missing keys still mean
  // the default collapsed state.
  next[normalizedKey] = nextExpanded;
  return { ...state, [field]: next };
}

function isExpanded(record: Readonly<Record<string, boolean>>, key: string): boolean {
  const normalizedKey = normalizeKey(key);
  return normalizedKey !== "" && record[normalizedKey] === true;
}

function retainWorkspaceKeys(
  state: SidebarNavigationState,
  keys: readonly string[],
): SidebarNavigationState {
  const retained = new Set(keys.map(normalizeKey).filter(Boolean));
  return {
    ...state,
    expandedWorkspaces: retainRecordKeys(state.expandedWorkspaces, retained),
    expandedSessionGroups: retainRecordKeys(state.expandedSessionGroups, retained),
  };
}

function removeWorkspaceKey(state: SidebarNavigationState, key: string): SidebarNavigationState {
  const normalizedKey = normalizeKey(key);
  if (normalizedKey === "") return state;
  const workspace = { ...state.expandedWorkspaces };
  const sessions = { ...state.expandedSessionGroups };
  delete workspace[normalizedKey];
  delete sessions[normalizedKey];
  return { ...state, expandedWorkspaces: workspace, expandedSessionGroups: sessions };
}

function retainRecordKeys(
  record: Readonly<Record<string, boolean>>,
  retained: ReadonlySet<string>,
): Readonly<Record<string, boolean>> {
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => typeof value === "boolean" && retained.has(key)));
}

function normalizeExpandedRecord(value: Readonly<Record<string, boolean>> | undefined): Readonly<Record<string, boolean>> {
  if (value === undefined || value === null || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([key, expanded]) => normalizeKey(key) !== "" && typeof expanded === "boolean"));
}

function normalizeKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeViewMode(value: unknown): SidebarViewMode {
  return value === "flat" ? "flat" : "tree";
}

function normalizeSort(value: unknown): SidebarSort {
  return value === "name" || value === "path" ? value : "recent";
}

export interface SidebarNavigationStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

export interface SidebarNavigationPersistenceOptions {
  readonly storage?: SidebarNavigationStorageLike | null;
  readonly key?: string;
  /** Search is page-lifecycle state by default; opt in only if product UX requires it. */
  readonly persistSearchQuery?: boolean;
}

export interface SidebarNavigationPersistence {
  readonly key: string;
  readonly load: () => SidebarNavigationState;
  readonly save: (state: SidebarNavigationState) => void;
  readonly clear: () => void;
}

/**
 * Create a fail-soft localStorage adapter.  Access to localStorage itself can
 * throw (privacy mode, sandboxed iframe, quota), so every operation is
 * guarded and storage failures never escape into the navigation UI.
 */
export function createSidebarNavigationPersistence(
  options: SidebarNavigationPersistenceOptions = {},
): SidebarNavigationPersistence {
  const key = options.key ?? SIDEBAR_NAVIGATION_STORAGE_KEY;
  const storage = options.storage === undefined ? resolveLocalStorage() : options.storage;
  const persistSearchQuery = options.persistSearchQuery === true;
  return {
    key,
    load: () => {
      if (storage === null) return createSidebarNavigationState();
      try {
        const raw = storage.getItem(key);
        if (raw === null) return createSidebarNavigationState();
        const parsed: unknown = JSON.parse(raw);
        return sanitizePersistedState(parsed, persistSearchQuery);
      } catch {
        return createSidebarNavigationState();
      }
    },
    save: (state) => {
      if (storage === null) return;
      try {
        storage.setItem(key, JSON.stringify(serializeSidebarNavigationState(state, { persistSearchQuery })));
      } catch {
        // Fail-soft by design: browser preference persistence must not block UI.
      }
    },
    clear: () => {
      if (storage === null || storage.removeItem === undefined) return;
      try {
        storage.removeItem(key);
      } catch {
        // Ignore storage failures for the same reason as save().
      }
    },
  };
}

export function serializeSidebarNavigationState(
  state: SidebarNavigationState,
  options: Pick<SidebarNavigationPersistenceOptions, "persistSearchQuery"> = {},
): SidebarNavigationState {
  const normalized = createSidebarNavigationState(state);
  return {
    ...normalized,
    searchQuery: options.persistSearchQuery === true ? normalized.searchQuery : "",
  };
}

function sanitizePersistedState(value: unknown, persistSearchQuery: boolean): SidebarNavigationState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return createSidebarNavigationState();
  const candidate = value as Partial<SidebarNavigationState>;
  return createSidebarNavigationState({
    ...(candidate.viewMode === "flat" ? { viewMode: "flat" as const } : {}),
    ...(candidate.sort === "name" || candidate.sort === "path" ? { sort: candidate.sort } : {}),
    searchQuery: persistSearchQuery && typeof candidate.searchQuery === "string" ? candidate.searchQuery : "",
    showArchived: candidate.showArchived === true,
    ...(candidate.expandedWorkspaces === undefined ? {} : { expandedWorkspaces: candidate.expandedWorkspaces }),
    ...(candidate.expandedSessionGroups === undefined ? {} : { expandedSessionGroups: candidate.expandedSessionGroups }),
  });
}

function resolveLocalStorage(): SidebarNavigationStorageLike | null {
  try {
    const storage = globalThis.localStorage;
    return storage === undefined ? null : storage;
  } catch {
    return null;
  }
}
