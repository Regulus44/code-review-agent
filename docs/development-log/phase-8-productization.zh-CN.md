# Phase 8 开发日志

## 2026-08-24：8.2 Worktree 收口

本次工作属于 Phase 8.2，解决 Workspace/Worktree runtime、事件回放、安全和 Web 诊断问题。A2A 保持 deferred，不在本次范围内。

### 已完成

- `GitWorktreeManager` 支持主仓库和 linked worktree 识别；所有 Git 调用使用无 shell 的 `execFile`；
- Worktree create、attach、switch、cleanup 通过 `worktree/*` 事件进入 EventStore，并投影到 Session；
- active worktree 的路径进入工具执行、权限请求和 system prompt；主 Session `workspaceRoot` 不被覆盖；
- 增加每个 Session 的 Worktree operation lock，避免并发创建相同路径或分支；
- pending create 在 Git side effect 已发生但事件尚未追加时可以恢复并补写事件；
- dirty/conflicted cleanup 默认拒绝，主仓库永远不能 cleanup，重复路径返回 `WORKTREE_EXISTS`；
- Web API、SSE、SessionStore、Worktree presenter 和 Details panel 已接入；
- 新增 linked worktree、SQLite reopen/replay、并发创建、pending recovery、API client 和 presenter 测试；
- 新增 `scripts/phase8-worktree-gate.mjs` 与 `pnpm test:phase8:worktree`，覆盖真实 API、临时 Git 仓库、SQLite 重启、dirty protection、强制清理和 Web bundle。

### 验证

```text
pnpm typecheck                         ✓
pnpm --filter @code-review-agent/workspace test  ✓ (6 tests)
pnpm --filter @code-review-agent/runtime test    ✓ (24 tests)
pnpm --filter @code-review-agent/storage test    ✓ (12 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (26 tests)
pnpm --filter @code-review-agent/web test        ✓ (98 tests)
pnpm build:web                          ✓
pnpm test:phase7:browser                ✓
pnpm test:phase8:worktree               ✓
git diff --check                        ✓
```

### 尚未关闭

本记录对应的代码已建立独立的 Phase 8.2 Git checkpoint；Phase 8.1 Compaction、8.0 Web parity、8.3 LSP/Code Mode、8.4 可靠性和 8.5 产品化仍未完成。
