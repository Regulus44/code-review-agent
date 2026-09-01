# Coding Agent 评测 workspace-full-access 边界改造

日期：2026-08-30  
实现提交：`09aacbb feat(eval): add workspace-scoped full access mode`  
改造前基线：`88642a9 refactor(eval): remove grader flow from simple agent benchmark`

## 背景

对最近一次 `deepseek-v4-flash` Easy 批次的 `events.jsonl` 复核发现，`mwaskom__seaborn-2848` 曾通过 PowerShell 枚举 workspace 外的数据集目录，并读取公开任务元数据、运行时元数据和 FAIL_TO_PASS/PASS_TO_PASS 信息；部分任务还读取了系统安装版本或临时下载版本的源码。这些运行不能作为纯 Agent 能力结果。

问题的直接原因是评测 Session 使用 `danger-full-access`，而旧评测 Prompt 没有重复声明防污染边界。系统 Prompt 虽然已有通用 workspace 规则，但权限名称和评测任务说明没有把“完整权限只属于当前 workspace”表达成单独、稳定的评测契约。

本阶段按当前决策只实施两项改造：

1. 新增 `workspace-full-access` 权限预设；
2. 在系统 Prompt 和评测任务 Prompt 中明确 workspace 与防污染限制。

既有 `events.jsonl` 轨迹继续用于运行后审计。本阶段不引入容器、独立操作系统账户、子进程环境变量清理或 Grader。

## 权限预设实现

新增 `workspace-full-access` 作为正式 `PermissionPreset`。它对可见工具采用自动读、自动写、自动执行和自动网络审批，与评测所需的无人工确认操作一致；其授权语义明确限定为当前 Session 的 workspace。

主要代码入口：

- `packages/contracts/src/index.ts`：公共 `PermissionPreset` 类型；
- `packages/tools/src/permissions.ts`：权限策略及自动审批模式；
- `packages/storage/src/index.ts`：事件回放和 Session projection 的合法值校验；
- `apps/api/src/server.ts`：Session 创建、模式切换的 API 输入校验；
- `packages/subagent/src/descriptor.ts`、`packages/tools/src/subagent.ts`：子 Agent descriptor 和工具 schema；
- `apps/web/index.html`、`apps/web/src/presentation/settings-presenter.ts`：Web 模式选项及用户说明。

原有 `danger-full-access` 暂时保留以兼容历史 Session、测试和其他非评测入口。Easy 评测不再使用该模式。

## Prompt 边界

`packages/runtime/src/system-prompt.ts` 的 workspace 段新增稳定规则：

- 文件、搜索、Git 和命令操作必须留在 active workspace；
- 不读取、枚举或使用父目录、同级目录、其他任务 workspace；
- 不访问数据集元数据、历史评测结果、reference/gold patch、隐藏测试或凭据存储；
- 可以执行解释器、编译器、包管理器和依赖，但不得把外部安装或下载版本的源码当作答案参考；
- `workspace-full-access` 表示 workspace 内无需交互审批，不扩大 workspace 边界。

`../../scripts/eval-mvp/run-agent-task.ts` 在每条任务的 `problemStatement` 后附加同一含义的中文评测边界。这样评测任务不再只依赖通用系统提示，也不会重新引入 step、超时、命令白名单或 Grader 条件。

评测入口的 API Host 和 Session 创建参数都已从 `danger-full-access` 改为 `workspace-full-access`。

## 文档同步

以下当前执行文档已经统一使用 `workspace-full-access`：

- `docs/evaluation/coding-agent-simple-evaluation-plan.zh-CN.md`；
- `docs/evaluation/agent-evaluation-guide.zh-CN.md`；
- `docs/evaluation/coding-agent-bench-mvp.zh-CN.md`；
- `docs/evaluation/coding-agent-test-runner-reference.zh-CN.md`；
- `docs/evaluation/coding-agent-evaluation-environment-grader-dsh-research.zh-CN.md`。

## 验证记录

```text
pnpm typecheck
通过

pnpm exec vitest run packages/runtime/src/system-prompt.test.ts packages/tools/src/index.test.ts apps/api/src/server.test.ts apps/web/src/presentation/settings-presenter.test.ts
4 files passed，84 tests passed

pnpm build:web
TypeScript build 与 browser bundle 均通过

git diff --check
通过
```

测试覆盖：

- `workspace-full-access` 可以无审批运行仓库测试命令；
- API 可以创建并持久化该模式的 Session；
- Web presenter 能完整处理新增枚举值；
- 系统 Prompt 同时包含 workspace-only、评测元数据、gold patch 和外部源码限制。

## 结果边界

本次改造建立的是正式权限语义、双层 Prompt 约束和可审计轨迹，不是操作系统级文件系统隔离。

结构化文件、搜索和 Git 工具继续通过 `WorkspaceResolver` 执行真实路径边界检查。任意 PowerShell/Python 命令仍可能表达 workspace 外的绝对路径；在不采用容器、受限账户或进程沙箱的前提下，Prompt 负责事前约束，`events.jsonl` 负责事后发现。发生越界读取、外部实现参考或评测元数据访问时，该次运行必须标记为 `contaminated`，不得计入解决率。

## 后续评测要求

旧 Easy v4flash 批次保留作历史证据，但不作为干净能力基线。重新运行 Easy 批次时必须满足：

- 每条任务从干净 workspace 开始；
- Session 的 `permissionPreset` 为 `workspace-full-access`；
- `user/message` 中存在固定评测边界；
- 运行后检查 `events.jsonl` 中的工具路径和 shell 命令；
- 命中 workspace 外数据集、其他任务、历史结果、外部参考源码或凭据路径时，结果记为 `contaminated`。

## 回滚

如需整体撤销本阶段，可回退实现提交 `09aacbb`，恢复到 `88642a9`。回滚会移除新增 preset、Web 选项和 Prompt 边界，并使评测入口重新失去本阶段建立的 workspace 专用权限语义。
