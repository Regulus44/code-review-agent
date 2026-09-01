# Coding Agent 评测阶段三：任务约束与测试闭环实施日志

## 阶段目标

阶段三把阶段二的编辑恢复能力接入任务执行闭环，确保 Agent 能看到评测任务的预算、修改范围和验收要求，并且使用仓库原生测试入口完成验证。通用 system prompt 只增加跨仓库成立的行为规则，不写入 Django 私有测试目标或 gold patch 内容。

## 参考与边界

- Claude Code `D:\Develop\claude-code\src\utils\context.ts`：将 context window、输出预算和执行步数视为不同资源；本阶段沿用 Runner 的 `maxSteps` 注入，不把它伪装成 token 预算；
- DSH `D:\Develop\deepseek-harness-fork\packages\fs\tool-str-replace-editor\src\index.ts`：精确编辑失败后重新读取并使用当前唯一上下文；
- 当前仓库 `packages/runtime/src/system-prompt.ts`：静态任务执行、安全、workspace 和验证规则；
- 当前仓库 `../../scripts/eval-mvp/run-agent-task.ts`：公开任务 prompt、Session API 启动和事件采集；
- 当前仓库 `../../scripts/eval-mvp/grade-agent-run.ps1`：Agent diff 应用、Django/pytest adapter、FAIL_TO_PASS/PASS_TO_PASS 判分。

阶段三不实现 Runner 范围审计的最终收敛；未跟踪文件与 `.agent-artifacts/` 的完整一致性仍留给阶段四。

## 实施内容

### 1. 通用 Agent 规则

修改 `packages/runtime/src/system-prompt.ts`：

- `taskExecutionSection()` 明确 `TEXT_NOT_FOUND`、`TEXT_NOT_UNIQUE`、`EDIT_NOT_OBSERVED`、`EDIT_STALE`、`EDIT_CONFLICT` 的恢复动作：停止重复调用、重读当前文件、使用新鲜唯一上下文和观察版本；
- `workspaceSection()` 明确任务提供的 allowed paths 是 workspace 之外的第二层硬边界，并要求保留无关用户改动；
- `safetySection()` 将编辑失败重读要求写入安全规则；
- `verificationSection()` 要求使用任务/仓库定义的原生测试、构建或诊断入口，并报告实际命令、参数和退出状态。

新增 `packages/runtime/src/system-prompt.test.ts`，验证上述规则存在且不泄露具体 Django 任务信息。

### 2. 任务 prompt 契约

修改 `../../scripts/eval-mvp/run-agent-task.ts`：

- 解析任务元数据中的 `requiredChecks`；
- 将预算、allowed paths 和 required checks 一起注入发送给 Agent 的 scoped prompt；
- 没有 `requiredChecks` 时使用通用的“执行仓库原生验证并报告命令/退出码”兜底要求；
- 保留既有 `maxSteps` 的 `1–512` 约束和公开/private 数据隔离。

修改外部任务元数据 `D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01\public\tasks\django__django-16046\task.json`：问题描述明确要求同时处理 `None` 与空字符串，并保留数字与字符串的既有行为；`failToPass`、`passToPass` 继续只由 Grader 使用。

### 3. 测试工具提示与 Django adapter

修改 `packages/tools/src/prompt-catalog.ts` 的 `run_tests` 说明：优先遵循任务 requiredChecks 和仓库 adapter，使用原生 runner，不因习惯替换为通用 pytest；失败结果必须依据 stack、输出和退出码诊断。

评测脚本的 clean copy 在 Windows 上统一关闭 `core.autocrlf`、启用 `core.longpaths` 并执行 checkout normalization，避免换行转换或长路径导致 Grader 把干净副本误判为有修改。Django adapter 继续调用 `tests/runtests.py`，不把 hidden test 细节注入 Agent。

## 验收记录

```text
pnpm --filter @code-review-agent/runtime test
pnpm --filter @code-review-agent/tools test
pnpm typecheck
pwsh -NoProfile -ExecutionPolicy Bypass -File ../../scripts/eval-mvp/verify-grader.ps1 -Mode gold -TaskId django__django-16046 -Python D:/Develop/coding-agent-test/datasets/swebench-lite/pilot-01/runtime/venvs/django__django-16046/Scripts/python.exe
pwsh -NoProfile -ExecutionPolicy Bypass -File ../../scripts/eval-mvp/verify-grader.ps1 -Mode empty -TaskId django__django-16046 -Python D:/Develop/coding-agent-test/datasets/swebench-lite/pilot-01/runtime/venvs/django__django-16046/Scripts/python.exe
```

结果：Runtime 76 项、Tools 75 项、类型检查全部通过；Django gold self-test 通过，empty self-test 按预期判定失败；gold 日志确认使用 `django-native` 与 `tests/runtests.py`。

## 阶段出口与回滚

阶段三完成了通用任务约束、编辑失败恢复提示、requiredChecks 传递和仓库原生测试验收。回滚时移除本阶段 system prompt 规则、Runner requiredChecks 注入、Django 公开描述修订、adapter checkout normalization 及其测试即可；阶段一、阶段二的工具与事件契约保持不变。
