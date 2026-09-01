# Agent 评测重跑与 Windows Grader 修复日志（2026-08-29）

## 目的

在四阶段 Agent 改造完成后，使用真实的 `yayi-deepreasoning-ds-v4pro` provider 重跑 Django `django__django-16046`，并验证 Agent、范围审计、Django 原生测试和 Grader clean copy 的完整链路。

## 实施修改

### Grader clean copy 的换行规范化

修改 `../../scripts/eval-mvp/grade-agent-run.ps1`：

- clone 时显式使用 `core.autocrlf=false` 和 `core.eol=lf`；
- 设置仓库配置后使用 `git checkout-index --all --force` 重新物化跟踪文件；
- 将规范化过程写入 `grader.log`。

原因是 Windows 用户级 Git 配置可能启用 `core.autocrlf=true`。如果 clean copy 被检出为 CRLF，Agent 生成的 LF patch 会在测试前的 `git apply` 阶段失败。

### Scope audit fixture 对齐正式 Grader

修改 `../../scripts/eval-mvp/scope-audit-grader-fixture.ps1`：

- fixture clone 与 clean copy 使用相同的 LF 规范化策略；
- 合成 diff 使用无 BOM 的 LF 编码保存，避免 PowerShell `Set-Content` 将 Git 输出改成 CRLF；
- fixture Grader 调用启用 `-InstallDependencies`，不依赖系统 Python 是否预装 Django 测试依赖。

## 真实 Agent 重跑

- 任务：`django__django-16046`
- Provider：`yayi-deepreasoning-ds-v4pro`
- Model：`deepreasoning-ds-v4pro`
- 最大步数：32
- 实际步数：26
- Tool calls：31
- Agent 状态：`completed`
- 修改文件：`django/utils/numberformat.py`
- Scope violation：`false`
- Security violation：`false`

结果目录：

`D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01\results\v4pro-rerun-0829\django__django-16046\v4pro-rerun-0829-20260829070927651`

## Grader 结果

- FAIL_TO_PASS：`passed`
- PASS_TO_PASS：`passed`
- 测试适配器：Django native `tests/runtests.py`
- 测试环境：任务专用 venv，自动安装 `pytest<9`、`asgiref`、`pytz`、`sqlparse` 等依赖
- 最终状态：`passed`

Grader 结果文件：

`D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01\results\v4pro-rerun-0829\django__django-16046\v4pro-rerun-0829-20260829070927651\grader-20260829-151420600\grader-result.json`

## 回归验证

以下检查均通过：

- `pnpm test`
- `pnpm typecheck`
- `../../scripts/eval-mvp/scope-audit-grader-fixture.ps1`
- Django `django__django-16046` 真实 Agent + Grader 重跑

## 结论

四阶段改造后的 Agent 已能在当前真实 provider 下完成该 Django 任务；此前的 `infra_error` 已定位并修复为 Windows Git 换行导致的候选 patch 应用问题。修复后，Agent 运行、候选 diff 应用、Django 原生测试和范围/安全审计全部闭环通过。

## Windows 控制台窗口修复补充

批量运行时发现 Runner 外层启动的 `pwsh`/`node` 进程会短暂弹出控制台窗口。已暂停并终止该批次，随后完成以下修改：

- `../../scripts/eval-mvp/run-pilot.ps1` 和 `../../scripts/eval-mvp/grade-agent-run.ps1` 的 `ProcessStartInfo` 设置 `CreateNoWindow=true`；
- `../../scripts/eval-mvp/run-agent-task.ts` 的 Git `execFile` 调用设置 `windowsHide=true`；
- `../../scripts/eval-mvp/scope-audit-cli.ts` 的 Git 调用设置 `windowsHide=true`。

验证结果：`pnpm typecheck`、`@code-review-agent/tools` 测试和 `scope-audit.test.ts` 均通过。下一次批量评测应使用这些修复后的 Runner。
