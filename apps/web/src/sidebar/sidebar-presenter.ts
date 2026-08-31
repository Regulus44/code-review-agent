import type { SessionId, SessionSummary, WorkspaceSummary } from "@code-review-agent/contracts";
import {
  buildNavigationModel,
  type NavigationRenderIntent,
  type NavigationSort,
  type NavigationViewMode,
} from "../presentation/navigation-presenter.js";

/**
 * Web-only view input for the WorkspaceBrowser. Durable Session/Workspace
 * facts still come from the API/Event projection and are never stored here.
 */
export interface SidebarPresenterOptions {
  readonly showArchived?: boolean;
  readonly query?: string;
  readonly selectedSessionId?: SessionId;
  /** @deprecated Keep the legacy bridge name source-compatible while callers migrate. */
  readonly activeSessionId?: SessionId;
  readonly viewMode?: NavigationViewMode;
  readonly sort?: NavigationSort;
  readonly workspaceOrder?: readonly string[];
  readonly workspaceCatalog?: readonly WorkspaceSummary[];
}

export interface SidebarNavigationProjection extends NavigationRenderIntent {
  /** Alias used by browser adapters that think in terms of the active group. */
  readonly activeGroupKey?: string;
  /** Stable copy for DOM empty-state renderers. */
  readonly emptyMessage: string;
}

/**
 * Single navigation projection entry point used by both the browser renderer
 * and any future non-DOM adapter. Keeping this wrapper separate from the DOM
 * prevents index.html from becoming a second navigation fact source.
 */
export function presentSidebarNavigation(
  sessions: readonly SessionSummary[],
  options: SidebarPresenterOptions = {},
): SidebarNavigationProjection {
  const normalized: SidebarPresenterOptions = {
    ...(options.showArchived === true ? { showArchived: true } : {}),
    ...(options.query === undefined ? {} : { query: String(options.query) }),
    ...(options.selectedSessionId === undefined && options.activeSessionId === undefined
      ? {}
      : { selectedSessionId: options.selectedSessionId ?? options.activeSessionId }),
    ...(options.viewMode === "flat" ? { viewMode: "flat" as const } : { viewMode: "tree" as const }),
    ...(options.sort === "name" || options.sort === "path" ? { sort: options.sort } : { sort: "recent" as const }),
    ...(options.workspaceOrder === undefined ? {} : { workspaceOrder: [...options.workspaceOrder] }),
    ...(options.workspaceCatalog === undefined ? {} : { workspaceCatalog: [...options.workspaceCatalog] }),
  };
  const navigation = buildNavigationModel(sessions, normalized);
  return {
    ...navigation,
    ...(navigation.activeWorkspaceKey === undefined ? {} : { activeGroupKey: navigation.activeWorkspaceKey }),
    emptyMessage: navigationEmptyMessage(navigation),
  };
}

export function navigationEmptyMessage(intent: Pick<NavigationRenderIntent, "emptyState" | "query" | "showArchived">): string {
  if (intent.emptyState === "search" || intent.query.length > 0) return "No sessions match this search.";
  if (intent.emptyState === "archived" || intent.showArchived) return "No archived sessions.";
  return "No active sessions. Create a session to start coding.";
}

export function countNavigationSessions(
  sessions: readonly { readonly children: readonly unknown[] }[],
): number {
  return sessions.reduce((total, session) => {
    const children = session.children as readonly { readonly children: readonly unknown[] }[];
    return total + 1 + countNavigationSessions(children);
  }, 0);
}

interface NavigationNodeLike {
  readonly id: SessionId;
  readonly children: readonly NavigationNodeLike[];
}

export function navigationContainsSession(
  session: NavigationNodeLike,
  selectedSessionId: SessionId | undefined,
): boolean {
  if (selectedSessionId === undefined) return false;
  if (session.id === selectedSessionId) return true;
  return session.children.some((child) => navigationContainsSession(child, selectedSessionId));
}

export const COLLAPSED_SESSION_LIMIT = 5;

export interface SessionGroupWindow<T> {
  readonly visible: readonly T[];
  readonly hiddenCount: number;
  readonly expanded: boolean;
}

/**
 * DSH-style per-workspace overflow window. The browser keeps the expanded
 * keys in ephemeral UI state for M2; M4 will move that state to a reducer and
 * persistence adapter without changing this projection contract.
 */
export function windowSessionGroup<T>(
  sessions: readonly T[],
  expanded: boolean,
  limit = COLLAPSED_SESSION_LIMIT,
): SessionGroupWindow<T> {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : COLLAPSED_SESSION_LIMIT;
  if (expanded || sessions.length <= safeLimit) {
    return { visible: sessions, hiddenCount: 0, expanded };
  }
  return { visible: sessions.slice(0, safeLimit), hiddenCount: sessions.length - safeLimit, expanded: false };
}
