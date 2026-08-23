import type { SessionId, SessionSummary, WorkspaceSummary } from "@code-review-agent/contracts";

export interface NavigationSession extends SessionSummary {
  readonly children: readonly NavigationSession[];
}

export interface WorkspaceNavigationGroup {
  readonly key: string;
  readonly root: string;
  readonly label?: string;
  readonly sessions: readonly NavigationSession[];
  readonly latestUpdatedAt?: string;
}

export interface NavigationRenderIntent {
  readonly query: string;
  readonly showArchived: boolean;
  readonly groups: readonly WorkspaceNavigationGroup[];
  readonly allSessions: readonly SessionSummary[];
  readonly recentWorkspaces: readonly string[];
  readonly activeWorkspaceKey?: string;
  readonly emptyState: "none" | "search" | "archived";
}

export interface NavigationOptions {
  readonly showArchived?: boolean;
  readonly query?: string;
  readonly activeSessionId?: SessionId;
  readonly maxDepth?: number;
  readonly workspaceOrder?: readonly string[];
  readonly workspaceCatalog?: readonly WorkspaceSummary[];
}

/**
 * Build the DSH-style Workspace → Session tree as a pure render projection.
 * The DOM shell owns expansion and click state; this function owns filtering,
 * grouping, parent/child lineage and deterministic ordering so refresh and
 * replay cannot produce a second navigation fact model.
 */
export function buildNavigationModel(
  input: readonly SessionSummary[],
  options: NavigationOptions = {},
): NavigationRenderIntent {
  const showArchived = options.showArchived === true;
  const query = normalizeQuery(options.query);
  const maxDepth = boundedDepth(options.maxDepth);
  const allSessions = input.filter((session) => session.deleted !== true);
  const workspaceByKey = new Map((options.workspaceCatalog ?? []).map((workspace) => [workspaceKey(workspace.key), workspace] as const));
  const candidates = allSessions.filter((session) => {
    const workspace = workspaceByKey.get(workspaceKey(session.workspaceRoot));
    // A catalog-backed projection is authoritative: a workspace omitted from
    // the active catalog has been soft-deleted and must not remain navigable
    // merely because its Session history is intentionally retained.
    if (options.workspaceCatalog !== undefined && workspace === undefined) return false;
    if (workspace?.deleted === true) return false;
    const workspaceArchived = workspace?.archived === true;
    return showArchived ? Boolean(session.archived) || workspaceArchived : !session.archived && !workspaceArchived;
  });
  const byId = new Map(candidates.map((session) => [session.id, session]));
  const childrenByParent = new Map<SessionId, SessionSummary[]>();
  for (const session of candidates) {
    if (session.parentSessionId === undefined || !byId.has(session.parentSessionId)) continue;
    const children = childrenByParent.get(session.parentSessionId) ?? [];
    children.push(session);
    childrenByParent.set(session.parentSessionId, children);
  }

  const buildNode = (session: SessionSummary, depth: number, lineage: Set<SessionId>): NavigationSession => {
    if (depth >= maxDepth || lineage.has(session.id)) return { ...session, children: [] };
    const nextLineage = new Set(lineage).add(session.id);
    const children = sortSessions(childrenByParent.get(session.id) ?? [])
      .map((child) => buildNode(child, depth + 1, nextLineage));
    return { ...session, children };
  };

  const roots = sortSessions(candidates
    .filter((session) => session.parentSessionId === undefined || !byId.has(session.parentSessionId)))
    .map((session) => buildNode(session, 0, new Set()));
  const grouped = new Map<string, { root: string; sessions: NavigationSession[] }>();
  for (const session of roots) {
    const root = session.workspaceRoot || ".";
    const key = workspaceKey(root);
    const group = grouped.get(key) ?? { root, sessions: [] };
    group.sessions.push(session);
    grouped.set(key, group);
  }

  const groups = [...grouped.entries()]
    .map(([key, group]) => {
      const sessions = group.sessions.filter((session) => matchesTree(session, query));
      const latestUpdatedAt = latestTimestamp(sessions);
      const workspace = workspaceByKey.get(key);
      return {
        key,
        root: group.root,
        ...(workspace?.label === undefined ? {} : { label: workspace.label }),
        sessions,
        ...(latestUpdatedAt === undefined ? {} : { latestUpdatedAt }),
      } satisfies WorkspaceNavigationGroup;
    })
    .filter((group) => group.sessions.length > 0)
    .sort((left, right) => {
      const order = options.workspaceOrder ?? [];
      const leftPosition = order.findIndex((root) => workspaceKey(root) === left.key);
      const rightPosition = order.findIndex((root) => workspaceKey(root) === right.key);
      if (leftPosition >= 0 || rightPosition >= 0) return (leftPosition < 0 ? Number.MAX_SAFE_INTEGER : leftPosition) - (rightPosition < 0 ? Number.MAX_SAFE_INTEGER : rightPosition);
      return compareTimestamp(right.latestUpdatedAt) - compareTimestamp(left.latestUpdatedAt);
    });
  const activeWorkspaceKey = options.activeSessionId === undefined
    ? undefined
    : groups.find((group) => group.sessions.some((session) => containsSession(session, options.activeSessionId as SessionId)))?.key;

  return {
    query,
    showArchived,
    groups,
    allSessions,
    recentWorkspaces: uniqueWorkspaces(allSessions),
    ...(activeWorkspaceKey === undefined ? {} : { activeWorkspaceKey }),
    emptyState: groups.length > 0 ? "none" : query.length > 0 ? "search" : showArchived ? "archived" : "none",
  };
}

export function workspaceKey(root: string | undefined): string {
  const normalized = String(root ?? ".").replace(/\\/g, "/").replace(/\/+$/u, "") || ".";
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function workspaceLabel(root: string | undefined): string {
  const value = String(root ?? ".").replace(/[\\/]+$/u, "");
  const segments = value.split(/[\\/]/u).filter(Boolean);
  return (segments.at(-1) ?? value) || "Workspace";
}

export function sessionLabel(session: Pick<SessionSummary, "id" | "title">): string {
  return session.title ?? `Session · ${String(session.id).slice(-6)}`;
}

export function sessionRelativeTime(timestamp: string | undefined, now = Date.now()): string {
  if (timestamp === undefined) return "";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "";
  const diff = Math.max(0, now - parsed);
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function matchesTree(session: NavigationSession, query: string): NavigationSession | undefined {
  if (query.length === 0 || matchesSession(session, query)) return session;
  const children = session.children
    .map((child) => matchesTree(child, query))
    .filter((child): child is NavigationSession => child !== undefined);
  return children.length === 0 ? undefined : { ...session, children };
}

function matchesSession(session: SessionSummary, query: string): boolean {
  return `${sessionLabel(session)} ${session.id} ${session.workspaceRoot}`.toLowerCase().includes(query);
}

function containsSession(session: NavigationSession, id: SessionId): boolean {
  return session.id === id || session.children.some((child) => containsSession(child, id));
}

function sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => compareTimestamp(right.updatedAt || right.createdAt) - compareTimestamp(left.updatedAt || left.createdAt));
}

function latestTimestamp(sessions: readonly NavigationSession[]): string | undefined {
  return sessions
    .flatMap((session) => [session.updatedAt, ...session.children.map((child) => child.updatedAt)])
    .sort((left, right) => compareTimestamp(right) - compareTimestamp(left))[0];
}

function compareTimestamp(value: string | undefined): number {
  return value === undefined ? 0 : Date.parse(value) || 0;
}

function normalizeQuery(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function boundedDepth(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined ? Math.min(16, Math.max(1, value)) : 8;
}

function uniqueWorkspaces(sessions: readonly SessionSummary[]): readonly string[] {
  const values = new Map<string, string>();
  for (const session of sessions) {
    const root = session.workspaceRoot || ".";
    if (!values.has(workspaceKey(root))) values.set(workspaceKey(root), root);
  }
  return [...values.values()];
}
