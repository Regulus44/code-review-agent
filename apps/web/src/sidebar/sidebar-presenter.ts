import type { SessionId, SessionStatus, SessionSummary, WorkspaceSummary } from "@code-review-agent/contracts";
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

/**
 * Optional Web-only signals that can make a row actionable without changing
 * the host-backed SessionSummary contract. The current sidebar only supplies
 * these for the selected Session when the richer SessionStore projection is
 * available; all other rows derive their state from SessionSummary.status.
 */
export interface SessionStatusPresentationOptions {
  readonly pendingInteraction?: boolean;
  readonly pendingPermission?: boolean;
  readonly runningChild?: boolean;
}

export type SessionDisplayStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export interface SessionStatusPresentation {
  readonly status: SessionDisplayStatus;
  readonly cssClass: "queued" | "running" | "completed" | "failed" | "stopped";
  readonly label: string;
  readonly ariaLabel: string;
}

/**
 * Derive the small, stable status vocabulary shown by Session rows. Raw host
 * status remains available on SessionSummary for details; this projection
 * intentionally gives pending interaction/permission an attention-first
 * visual priority and maps the idle host state to a completed row state.
 */
export function presentSessionStatus(
  session: Pick<SessionSummary, "status">,
  options: SessionStatusPresentationOptions = {},
): SessionStatusPresentation {
  const rawStatus = session.status as SessionStatus;
  const status: SessionDisplayStatus = options.pendingInteraction === true || options.pendingPermission === true || rawStatus === "queued"
    ? "pending"
    : rawStatus === "failed"
      ? "failed"
      : rawStatus === "stopped" || rawStatus === "interrupted"
        ? "stopped"
        : rawStatus === "running" || options.runningChild === true
          ? "running"
          : "completed";
  const label = status === "pending"
    ? "Needs attention"
    : status === "running"
      ? "Running"
      : status === "completed"
        ? "Completed"
        : status === "failed"
          ? "Failed"
          : "Stopped";
  return {
    status,
    cssClass: status === "pending" ? "queued" : status,
    label,
    ariaLabel: `Session status: ${label}`,
  };
}
