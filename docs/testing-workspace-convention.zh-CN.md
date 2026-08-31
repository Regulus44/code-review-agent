# 测试 Workspace 使用约定

> 生效日期：2026-08-31
>
> 目的：让 Web 左侧导航保持稳定，同时保留评测任务所需的文件与权限隔离。

## 已采用的导航基线

默认保留两个长期 Workspace：

| 用途 | Workspace 根目录 | 导航标签 |
| --- | --- | --- |
| 日常开发 | `D:\\Develop\\code-review-agent` | 主项目目录名 |
| 普通测试、浏览器 smoke、手工验证 | `D:\\Develop\\coding-agent-test` | `Test workspace` |

历史 smoke、benchmark 和临时目录通过 Workspace Archive 隐藏，不删除 Session、事件或评测产物。恢复入口使用 Web 的 Archived 视图或 `POST /v1/workspaces/{key}/archive` 搭配 `archived: false`。

当前清理结果：46 个历史 Workspace 中，43 个已归档；默认导航保留主项目、`Test workspace` 和历史 `.` 根目录。`.` 是旧测试产生的默认根，不再用于新测试。

## 使用规则

1. 普通开发测试统一在 `D:\\Develop\\coding-agent-test` 下创建 Session，不为每次 smoke 新建顶层目录。
2. 评测任务仍必须为每个任务保留独立的 clone/workspace 根。这个隔离是权限边界和 trace-gate 的一部分，不能为了减少导航项而把不同任务合并到同一个实际根目录。
3. 评测产物、数据库、事件和 diff 继续写入 `D:\\Develop\\coding-agent-test\\datasets\\...`；任务达到终态后，将对应的临时 Workspace 归档，而不是删除其文件。
4. 批量归档前检查 Session 没有 `running`、`waiting` 或 `queued` 状态；每个归档请求携带唯一 `idempotency-key`。
5. 新的临时 smoke 根目录必须在测试计划中声明用途和回收时机；默认不应出现在长期可见导航中。

## 实施入口与责任边界

| 模块 | 文件/入口 | 后续约定 |
| --- | --- | --- |
| Web 导航 | `apps/web/src/presentation/navigation-presenter.ts`、`apps/web/src/sidebar/workspace-row.ts` | 消费 Workspace catalog 的归档状态与标签；不按 basename 合并不同根目录。 |
| API | `apps/api/src/server.ts` 的 `POST /v1/workspaces/{key}/archive`、`POST /v1/workspaces/{key}/label` | 提供可恢复的导航生命周期操作；归档不删除文件或事件。 |
| Runtime | `packages/runtime/src/index.ts` 的 `archiveWorkspace()` / `renameWorkspace()` | 通过 `workspace/updated` 事件记录状态，保持事件回放一致。 |
| 评测 Runner | `scripts/eval-mvp/run-agent-task.ts` | 继续使用每任务独立 clone；在共享宿主场景完成结果落盘后归档临时 Workspace。 |
| Web 测试 Fixture | `apps/web/tests/fixture.mjs` | 临时数据库与 `mkdtemp` 仅用于隔离测试，不应把这些根目录注册到长期宿主 Workspace。 |

## 验收清单

- 默认 `GET /v1/workspaces` 只返回长期 Workspace 和明确保留的历史项。
- 重启 API、SSE 重连和事件回放后，归档状态与标签保持一致。
- 归档前后 Session、`events.jsonl`、diff、trace 和数据库仍可读取。
- 评测 trace-gate 仍报告每个任务独立的 `workspaceRoot`，不会因导航清理而改变安全边界。
- 后续普通测试复用 `Test workspace`，不新增同级 `workspace` 分类。

