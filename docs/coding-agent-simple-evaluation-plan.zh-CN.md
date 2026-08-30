# Coding Agent 简化评测方案

> 状态：当前实际评测方案  
> 目标：用最接近 Web 端真实使用的方式，观察 Coding Agent 是否能够解决代码任务。  
> 原则：先评测 Agent 能力，暂不把 Runner、Grader、权限协议和环境编排本身做成新的复杂系统。

`workspace-full-access` 与防污染 Prompt 的实现记录见 [`development-log/workspace-full-access-evaluation-boundary-2026-08-30.zh-CN.md`](development-log/workspace-full-access-evaluation-boundary-2026-08-30.zh-CN.md)。

命令与测试工具的应用层 workspace 防外溢方案见 [`workspace-command-guard-plan.zh-CN.md`](workspace-command-guard-plan.zh-CN.md)。

评测 Prompt 固定模板见 `scripts/eval-mvp/evaluation-prompt.ts`。模板正文保持不变，每条任务只替换任务描述和当前 workspace 路径；Windows 进程统一以隐藏窗口方式执行。

## 1. 我们到底要测什么

只回答一个核心问题：

> 给 Agent 一个真实代码任务、一个干净 workspace 和完整操作权限，它能不能把问题解决？

这里的 Agent 能力包括：

- 能否理解任务描述；
- 能否定位相关代码；
- 能否做出正确修改；
- 能否根据需要读取错误、运行命令或安装依赖；
- 能否在修改后得到一个有效结果。

不把以下内容当成当前阶段的主要目标：

- 设计复杂的 benchmark 协议；
- 建立多层 Runner/Grader 服务；
- 强制所有任务遵循相同的测试命令；
- 把 Agent 的运行时间、step 数或工具调用数预先写成任务限制；
- 为每个历史仓库永久改造一套运行环境。

## 2. 最小评测逻辑

一条任务只需要经过下面的流程：

```text
准备干净 workspace
  → 使用和 Web 端相同的 Agent/provider/model
  → 授予当前 workspace `workspace-full-access`
  → 发送任务描述
  → 观察 Agent 自主读取、修改、运行和安装依赖
  → Agent 完成后保存对话、完整事件轨迹和代码差异
  → 通过轻量轨迹门禁检查证据完整性和 workspace 边界
  → 在仓库自己的环境和测试入口上做一次结果验证
  → 记录成功、失败或环境阻塞
```

这里的“统一”只统一外层操作流程，不统一仓库内部命令。Django 使用 Django 自己的测试入口，Python 包使用自己的测试入口，Node 项目使用 npm/vitest 等原生命令。

## 3. 一条任务怎么操作

### 3.1 准备 workspace

每条任务都从对应的 base commit 或干净源码开始。任务完成后不要继续在同一个目录运行下一条任务，避免前一条任务的修改污染后一条任务。

准备内容只有：

- 任务对应的仓库源码；
- 任务描述；
- 当前 Agent 使用的 provider/model 配置；
- 一个独立的 workspace 目录。

默认直接使用当前机器的 base 环境。只有 Agent 在实际运行中发现缺少依赖时，才允许它在 workspace 内自行安装。评测人员不需要事先为每个历史任务制作专用虚拟环境。

### 3.2 给 Agent 的内容

发送真实任务描述，并附加固定的 workspace 边界说明，例如：

```text
请修复这个仓库中的问题：

<任务描述>

请直接在当前 workspace 中完成修改。你拥有当前 workspace 的完整访问权限，可以读取文件、运行命令、安装需要的依赖并执行测试。完成后说明修改内容和验证结果。

所有操作必须留在当前 workspace 内；不得读取、枚举或使用父目录、同级目录、数据集元数据、其他任务、历史结果、参考补丁、隐藏测试、凭据文件或外部版本源码来推导修复。
```

不再额外塞入以下内容：

- “必须在 32 步内完成”；
- “测试必须在 300000ms 内完成”；
- 人工列出的命令白名单；
- 强制使用 pytest；
- 预先指定虚拟环境；
- 过多的允许/禁止路径说明。

workspace 本身就是边界。评测 Session 使用 `workspace-full-access`：Agent 可以自由操作 workspace 内的文件和命令，但权限名称和系统 Prompt 都明确不授权访问 workspace 外内容。评测数据、其他任务和秘密凭据不放入这个 workspace。

### 3.3 运行期间怎么观察

Agent 不需要感知评测超时时间，也不需要为了满足某个计数器刻意加快或减慢。评测人员只需要像使用 Web Agent 一样观察：

- Agent 是否仍在持续分析或执行；
- 是否出现明显重复、卡死或系统异常；
- 是否已经形成代码修改和最终答复；
- 是否需要人工停止。

如果机器进程完全失去响应，可以由评测人员手动停止，并记录为“运行中断”。这个操作是为了保护机器，不把它伪装成 Agent 的代码能力结论。

### 3.4 Agent 是否必须运行测试

不必须。

很多任务只需要读取代码、理解错误路径和修改实现，Agent 可以不运行测试就完成。运行测试是 Agent 自主选择的诊断手段，不应成为每条任务的强制前置条件。

但 Agent 结束后，评测人员应尽量使用仓库自己的测试入口做一次外部验证。这样可以把两个问题分开：

- Agent 是否做出了正确修改；
- Agent 是否主动运行过测试。

前者是主结果，后者只能作为附加观察信息。

## 4. 结果验证怎么做

结果验证不需要复杂 Grader。只做三件事：

1. 查看 Agent 的代码差异，确认确实修改了目标代码；
2. 使用该仓库原生测试入口执行相关测试；
3. 如果条件允许，再执行少量原有回归测试。

测试命令由任务所属仓库决定：

| 仓库类型 | 验证方式示例 |
|---|---|
| Django | `python tests/runtests.py ...` |
| 普通 Python 项目 | 项目自己的 pytest、unittest 或 tox 入口 |
| Node/TypeScript 项目 | `npm test`、`pnpm test`、vitest 或项目文档指定命令 |
| 其他项目 | README、CI 或仓库脚本中记录的原生入口 |

如果测试因为依赖、版本或操作系统原因无法启动，不要直接记为 Agent 失败，应记录为“环境阻塞”，并保存实际报错。

## 5. 依赖处理原则

依赖处理遵循一个简单原则：

> 不为评测框架预先制造复杂环境；允许 Agent 在当前 workspace 内自行解决实际依赖问题。

具体做法：

- 优先使用当前 base 环境；
- Agent 需要时可以运行 `pip install`、`npm install`、`pnpm install` 或仓库自己的安装命令；
- 不要求评测人员提前为每条任务创建 venv；
- 不因为某个历史仓库使用旧版本依赖，就提前对所有任务做环境改造；
- 依赖安装失败时，记录失败命令和原始输出，不把它误判成代码修复失败。

如果某条任务确实需要隔离环境，可以人工为该条任务准备，但它属于运行准备，不属于 Agent 能力评分规则。

## 6. 最小结果记录

每条任务保留一个简单结果文件，并同时保存事件轨迹文件，例如：

```json
{
  "taskId": "django__django-16046",
  "provider": "deepseek",
  "model": "当前实际使用的模型",
  "workspace": "任务 workspace 路径",
  "status": "solved",
  "traceStatus": "complete",
  "boundaryStatus": "clean",
  "trace": {
    "eventsPath": "events.jsonl",
    "reportPath": "trace.json"
  },
  "agentRanTests": true,
  "validation": {
    "command": "python tests/runtests.py ...",
    "status": "passed",
    "output": "关键输出摘要"
  },
  "notes": "Agent 定位并修复了目标逻辑"
}
```

当前阶段只需要四类最终状态：

- `solved`：Agent 修改有效，外部验证通过；
- `unsolved`：Agent 正常结束，但修改没有解决问题；
- `environment_blocked`：依赖、版本、平台或测试环境导致无法可靠验证；
- `interrupted`：进程异常、人工停止或系统故障导致任务未完成。

不要为了追求形式上的统一，把所有错误都转换成同一个 `test_failed`。

`events.jsonl` 和 `trace.json` 是每条运行的强制证据产物。`traceStatus=partial/missing`
时记为 `invalid_trace`，不得计入 Agent 能力结果；`boundaryStatus=contaminated` 时单独记为污染运行，
也不得计入能力结果。`boundaryStatus=blocked` 只说明 Guard 成功拦截了越界尝试，不等同于 Agent 失败。

## 7. 十条任务的小批量执行方式

当前先选择 10 条相对简单、环境可处理的 SWE-bench Lite 任务，串行执行：

```text
任务 1：准备干净 workspace → Web Agent → 验证 → 记录
任务 2：准备干净 workspace → Web Agent → 验证 → 记录
...
任务 10：准备干净 workspace → Web Agent → 验证 → 记录
```

每条任务都使用同一个实际 Agent 入口和同一套 provider/model 配置。批次只做最简单的统计：

```text
解决率 = solved 数量 / 可可靠验证的任务数量
```

`environment_blocked` 不计入 Agent 解决率分母，但必须单独报告数量和原因。

## 8. 需要观察的附加信息

这些信息可以顺手记录，但不改变主判定：

- Agent 是否主动读取了相关文件；
- Agent 是否运行了测试；
- Agent 是否安装了依赖；
- Agent 是否重复尝试；
- Agent 最终修改了哪些文件；
- Agent 是否给出了清晰的完成说明。
- 轨迹是否完整、是否存在 Guard 拒绝以及是否出现未拦截的 workspace 外引用。

这些是帮助改进 Agent 体验的观察数据。轨迹门禁只做事件审计，不限制 Agent 的 step、命令、依赖安装或测试选择。

## 9. 与旧方案的关系

之前的 Runner/Grader 设计更偏向“可复现 benchmark 基础设施”，加入了步数、超时、任务级 venv、命令白名单、hidden patch、scope audit 和多层错误分类。这些能力以后如果确实需要，可以逐步增加，但不应成为当前 Agent 能力评测的前置条件。

当前以本文为实际执行准则：

- Web Agent 流程保持不变；
- workspace 保持隔离；
- 使用 `workspace-full-access`，完整权限仅授予当前 workspace；
- 不人为限制 Agent 的 step、命令和依赖安装；
- 测试由 Agent 自主决定是否运行，评测人员在结束后做外部验证；
- 每条运行先通过 `events.jsonl`/`trace.json` 轨迹门禁，再解释 Agent 结果；
- 优先记录真实结果，不让评测框架的复杂性替代 Agent 能力结论。

## 10. 当前不做的事情

本阶段不做：

- 不重新设计完整 Runner 框架；
- 不为每个仓库建立独立协议；
- 不强制所有仓库使用同一个测试框架；
- 不预先给 Agent 设置 step 或可感知的任务时间预算；
- 不因为某次环境失败就修改历史仓库源码；
- 不把环境问题、Grader 问题和 Agent 能力问题混为一个分数。
