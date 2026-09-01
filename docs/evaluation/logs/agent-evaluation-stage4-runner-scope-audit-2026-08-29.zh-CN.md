# Coding Agent 评测阶段四：Runner 范围审计实施日志

## 阶段目标

阶段四收紧 Agent workspace、候选 patch 和 Grader clean copy 之间的证据链，解决 `.agent-artifacts/` 出现在 Git 状态但没有进入 `agent.diff`、最终 `scopeViolation` 仍为 `false` 的不一致问题。

## 设计决策

- `allChangedFiles` 保留 Git workspace 中的全部变更，包含已跟踪修改、删除、重命名、未跟踪文件和运行产物；
- `.agent-artifacts/**` 是允许的运行时临时产物，单独记录为 `runtimeArtifactFiles`，不进入候选 patch，也不触发范围违规；
- 其他未跟踪文件记录为 `untracked_candidate` 并 fail closed。Git diff 不能可靠表达这类文件，不能把它们静默遗漏到 Grader clean copy；
- `allowedPaths` / `forbiddenPaths` 使用 workspace 相对路径和 glob 匹配。删除文件、重命名源和目标路径都参与判定；
- 候选范围由任务元数据决定，不由 gold patch 文件列表决定。Gold patch 只作为 SWE-bench 基准修复输入；
- Grader 必须同时核对 Runner 的 `scope-audit.json`、原始 Agent workspace 的 Git 状态和 clean copy 应用后得到的候选文件集合。

## 实施内容

### 1. 共享审计实现

新增 `../../scripts/eval-mvp/scope-audit.ts`：

- 解析 `git status --porcelain=v1 --untracked-files=all -z`；
- 处理普通状态、删除、重命名/复制的源与目标路径；
- 输出 `allChangedFiles`、`candidateChangedFiles`、`runtimeArtifactFiles`、`untrackedFiles`、`deletedFiles` 和结构化 `violations`；
- 对候选未跟踪文件、allowed path 外文件和 forbidden path 文件统一设置 `scopeViolation=true`。

新增 `../../scripts/eval-mvp/scope-audit-cli.ts` 作为独立脚本入口，便于 Runner 外部复核和 fixture 调用。

### 2. Agent Runner 证据

修改 `../../scripts/eval-mvp/run-agent-task.ts`：

- 任务元数据支持 `forbiddenPaths` 与可选 `runtimeArtifactPaths`；
- Agent prompt 同时看见 allowed paths、forbidden paths、step 预算和 required checks；
- Agent turn 结束后采集完整 Git porcelain 状态，写入独立 `scope-audit.json`；
- `result.json` 的 `diff` 同时保存全部变更、候选变更、运行产物和审计路径；
- 状态快照和结果 JSON 使用同一 `allChangedFiles`，不再固定写入 `scopeViolation=false`。

### 3. Grader 对账

修改 `../../scripts/eval-mvp/grade-agent-run.ps1`：

- 要求并读取 `scope-audit.json`，校验 schema、任务路径配置和结果摘要；
- 复核原始 Agent workspace 的 Git 状态与审计 `allChangedFiles`；
- 在 clean copy 应用 `agent.diff` 后，核对候选文件集合与审计 `candidateChangedFiles`；
- 范围判定不再使用 gold patch 文件名列表；
- 审计违规、原始 workspace 与 diff 不一致均按 `scope_violation` 处理，并阻止测试结果伪装成通过。

### 4. Fixture 与测试

- `../../scripts/eval-mvp/scope-audit.test.ts` 覆盖 tracked modification、deleted file、rename、untracked candidate、runtime artifact 和 glob allowed paths；
- `../../scripts/eval-mvp/scope-audit-fixture.ps1` 创建临时 Git 仓库，验证 `.agent-artifacts/**` 被排除而 `unexpected.py` 触发违规，删除文件仍被保留在审计中。
- `../../scripts/eval-mvp/scope-audit-grader-fixture.ps1` 使用 Django gold patch 验证 clean candidate 可通过，并在原始 Agent workspace 增加未跟踪文件后确认 Grader fail closed。

## 验收记录

```text
pnpm exec vitest run ../../scripts/eval-mvp/scope-audit.test.ts
pwsh -NoProfile -ExecutionPolicy Bypass -File ../../scripts/eval-mvp/scope-audit-fixture.ps1
pnpm --filter @coding-agent/runtime test
pnpm --filter @coding-agent/tools test
pnpm typecheck
pnpm test
pwsh -NoProfile -ExecutionPolicy Bypass -File ../../scripts/eval-mvp/verify-grader.ps1 -Mode gold -TaskId django__django-16046 -Python D:/Develop/code-review-agent-test/datasets/swebench-lite/pilot-01/runtime/venvs/django__django-16046/Scripts/python.exe
pwsh -NoProfile -ExecutionPolicy Bypass -File ../../scripts/eval-mvp/verify-grader.ps1 -Mode empty -TaskId django__django-16046 -Python D:/Develop/code-review-agent-test/datasets/swebench-lite/pilot-01/runtime/venvs/django__django-16046/Scripts/python.exe
```

脚本级 scope fixture、Runtime/Tools 定向测试、全 workspace 测试和类型检查均通过；Django gold self-test 通过，empty self-test 按预期失败，并继续确认 `django-native` / `tests/runtests.py` adapter。

## 阶段出口与回滚

阶段四完成了 Runner 的完整范围审计和 Grader 对账。回滚时移除 `scope-audit.ts`、CLI、fixture 及 Runner/Grader 的 scope 对账字段即可；阶段一至阶段三的编辑恢复、任务约束和 Django 测试闭环保持不变。
