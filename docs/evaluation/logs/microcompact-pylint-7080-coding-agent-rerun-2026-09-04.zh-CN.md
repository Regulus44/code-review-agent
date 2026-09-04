# Pylint-7080 Coding Agent 直驱重测记录（2026-09-04）

## 执行方式

本次采用 Codex 启动本仓库 Coding Agent API Host 的方式执行，没有调用
`scripts/eval-mvp/run-agent-task.ts`、`run-pilot.ps1` 或任何 grader。临时 API 使用独立端口
`3211` 和独立 SQLite；Coding Agent session 为
`ses_b2d9e7ad-8764-4b46-aa00-f1f1d63fa0a9`。

- Provider/model：`deepseek/deepseek-v4-flash`
- 基准 workspace：`D:\\Develop\\coding-agent-test\\datasets\\swebench-lite\\medium-11\\runtime\\workspaces\\pylint-dev__pylint-7080`
- active workspace：`D:\\Develop\\coding-agent-test\\datasets\\swebench-lite\\medium-11\\runtime\\active-workspaces\\pylint-7080-coding-agent-20260904`
- base commit：`3c5eca2d`
- permission preset：`workspace-full-access`

只把任务描述和 active workspace 发送给 Coding Agent；基准 workspace、code-review-agent 仓库、gold
patch、hidden test、凭据和其他任务均未作为任务输入。

## Coding Agent 结果

任务最终状态为 `completed`。Coding Agent 在 active workspace 中完成最小修复：

- `pylint/lint/expand_modules.py`：在 `ignore-paths` 正则匹配前调用 `os.path.normpath()`，去掉
  `./`/`.\\` 前缀。
- `tests/lint/unittest_lint.py`：增加 pyproject.toml + `pylint --recursive=y .` 回归测试。
- `tests/test_self.py`：增加当前目录和 `./directory` 两种递归调用的回归测试。

验证结果：

- 临时复现、`src`/`.`/`./src` 变体均按预期忽略生成目录。
- `python -m pytest tests/lint/unittest_lint.py tests/lint/unittest_expand_modules.py tests/test_self.py::TestRunTC::test_ignore_paths_recursive_current_dir -q`：`62 passed`。
- `TestRunTC` 对照：修复前后均有 16 个 Python 3.13 + astroid 2.11 的既有失败；修复后 `89 passed`，基线 `88 passed`，未增加回归。
- active workspace 最终只有 3 个预期源文件修改；`.agent-artifacts/` 与 `.agent-trash/` 是运行时辅助目录，未进入源代码 diff。

## Microcompact 事件证据

API EventStore 共记录 2,359 个事件、73 个 step、117 个 tool call。每个 `step/started` 都包含
`toolResultBudget.microcompact` 诊断，统计如下：

- `strategy=none`：73/73
- `checkpoint.status=not_needed`：73/73
- `clearedResultCount=0`：73/73
- `context/microcompacted` receipt：0
- `context/microcompact_checkpoint` / `..._failed`：0
- 最高 model-view token：152,804
- Pressure-V2 threshold：793,600；target：785,600
- eligible tool results 最高：87

因此，旧版“累计 10 个工具结果就清理”的问题在真实任务中已被消除：即使 eligible 结果达到 87
个，完整上下文仍远低于 pressure threshold，Coding Agent 没有清理早期证据，也没有生成 checkpoint
或重复读取来恢复被清理内容。可见的重复读取集中在有意复核的
`tests/test_self.py`（5 次）、`pylint/lint/pylinter.py`（3 次）和
`tests/lint/unittest_lint.py`（3 次），没有发生 microcompact 后的恢复性重读。

## 结论与边界

本次重测确认 Pressure-V2 在真实 Pylint 长任务中生效，具体确认项是“低于全局压力时不因结果数量
触发 microcompact”。这次任务没有接近 793,600 token 阈值，因此没有验证 pressure-triggered
checkpoint/clearing 的正向路径；该路径仍由 Slice E fixture 和 Runtime/Storage/Web 合同测试覆盖。

此前误启动的旧 runner 因 credential metadata 路径错误在 Agent loop 前退出，没有产生有效评测结果，
不纳入本记录。
