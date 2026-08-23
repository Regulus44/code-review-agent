import type { WorktreeProjection } from "@code-review-agent/contracts";

export interface WorktreeRenderIntent {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly branch: string;
  readonly status: WorktreeProjection["status"];
  readonly statusLabel: string;
  readonly attached: boolean;
  readonly dirty: boolean;
  readonly conflicted: boolean;
  readonly canAttach: boolean;
  readonly canSwitch: boolean;
  readonly canCleanup: boolean;
  readonly cleanupReason: string;
}

export interface WorktreesRenderIntent {
  readonly visible: boolean;
  readonly items: readonly WorktreeRenderIntent[];
  readonly clean: number;
  readonly dirty: number;
  readonly conflicted: number;
  readonly summary: string;
}

export function presentWorktrees(worktrees: readonly WorktreeProjection[] | undefined, activeWorktreeId?: string): WorktreesRenderIntent {
  const items = (worktrees ?? []).map((worktree) => {
    const dirty = worktree.status === "dirty";
    const conflicted = worktree.status === "conflicted";
    const removed = worktree.status === "removed";
    return {
      id: worktree.id,
      label: worktree.branch ?? worktree.id,
      path: worktree.path,
      branch: worktree.branch ?? "detached",
      status: worktree.status,
      statusLabel: worktree.status === "clean" ? "Clean" : worktree.status === "dirty" ? "Dirty" : worktree.status === "conflicted" ? "Conflict" : worktree.status === "attached" ? "Attached" : worktree.status === "removed" ? "Removed" : "Failed",
      attached: worktree.status === "attached" || worktree.sessionId !== undefined,
      canSwitch: !removed && !conflicted && worktree.id !== activeWorktreeId,
      dirty,
      conflicted,
      canAttach: !removed && !conflicted,
      canCleanup: !removed,
      cleanupReason: conflicted ? "Resolve the Git conflict before cleanup." : dirty ? "Cleanup requires force because the worktree has uncommitted changes." : "Host validates the worktree before removing it.",
    };
  });
  const clean = items.filter((item) => item.status === "clean" || item.status === "attached").length;
  const dirty = items.filter((item) => item.dirty).length;
  const conflicted = items.filter((item) => item.conflicted).length;
  return { visible: items.length > 0, items, clean, dirty, conflicted, summary: items.length === 0 ? "No worktrees" : `${clean} clean · ${dirty} dirty · ${conflicted} conflicted` };
}
