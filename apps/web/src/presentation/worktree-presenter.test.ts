import { describe, expect, it } from "vitest";
import type { WorktreeProjection } from "@coding-agent/contracts";
import { presentWorktrees } from "./worktree-presenter.js";

const worktree = (status: WorktreeProjection["status"]): WorktreeProjection => ({ id: `wt_${status}`, repoRoot: "D:/repo", path: `D:/repo-${status}`, status, branch: "feature/test", createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z", lastSequence: 2 });

describe("presentWorktrees", () => {
  it("classifies clean, dirty and conflicted worktrees with safe actions", () => {
    const view = presentWorktrees([worktree("clean"), worktree("dirty"), worktree("conflicted")]);
    expect(view).toMatchObject({ visible: true, clean: 1, dirty: 1, conflicted: 1 });
    expect(view.items[1]).toMatchObject({ canCleanup: true, cleanupReason: expect.stringContaining("force") });
    expect(view.items[2]).toMatchObject({ canAttach: false, cleanupReason: expect.stringContaining("conflict") });
  });

  it("keeps an explicit empty state", () => {
    expect(presentWorktrees([])).toEqual({ visible: false, items: [], clean: 0, dirty: 0, conflicted: 0, summary: "没有工作树" });
  });
});
