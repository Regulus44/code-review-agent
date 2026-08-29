# Coding Agent 评测集建设指南

本文为当前 Coding Agent Runtime 建立可重复、可量化的 Agent 能力评测集。它服务于后续 Runner、Grader、报告和回归门禁的实现，不改变 Agent、Tool、Event 或 Permission contract。

第一阶段采用轻量 MVP：复用外部 10 条 SWE-bench Lite 试点，优先计算 Resolved@1、回归率、完成率、耗时、工具调用量和安全违规率。具体执行边界见 [`coding-agent-bench-mvp.zh-CN.md`](coding-agent-bench-mvp.zh-CN.md)；本文其余内容作为后续扩展参考。

当前 10 条试点数据集实际位于仓库之外的 `D:\Develop\coding-agent-test`。仓库只保存本指南和后续 Runner 的代码；任务元数据、workspace、hidden tests、标准 patch 和运行结果均不得提交到 `D:\Develop\code-review-agent`。

## 1. 目标与边界

### 1.1 评测目标

本评测集主要回答以下问题：

- Agent 能否在 workspace 中找到正确的文件和上下文；
- Agent 是否按 `检索 → 理解 → 修改 → 验证 → 总结` 的闭环执行；
- Agent 是否正确使用文件、Git、终端和测试工具；
- ToolRuntime、permission、取消、超时和重启恢复是否可靠；
- 测试失败后，Agent 是否能诊断并继续修复；
- Agent 是否遵守 workspace、安全和修改范围约束。

### 1.2 明确不包含

- 不以评测基础模型的通用编码能力为主要目标；
- 不把模型 token 数、模型排行榜或标准答案相似度作为主指标；
- 不使用 LLM judge 代替代码测试和安全判分；
- 不在第一版直接运行完整 SWE-bench 作为唯一门禁；
- 不把外部 benchmark 的结果解释为纯粹的 Agent Runtime 能力。

当前工作属于质量和评测基础设施，服务现有 Phase 7 Web 收敛以及后续工具、恢复和产品化工作。评测 Runner 不应绕过现有 API、Session、EventStore、ToolRuntime 或 permission 管线。

## 2. 行业 benchmark 的使用方式

行业中没有一个能够完全隔离 Agent 能力的 Coding Agent benchmark。常见数据集的用途不同：

| Benchmark | 主要测量 | 本项目中的用途 |
|---|---|---|
| [SWE-bench](https://www.swebench.com/) | 根据 issue 修改真实仓库并通过隐藏测试 | 外部端到端对照 |
| SWE-bench Lite / Verified | 缩小或人工筛选的 SWE-bench 子集 | 第一阶段外部试点 |
| [Terminal-Bench](https://www.tbench.ai/) | 终端、环境和命令执行能力 | 工具编排和长任务补充 |
| RepoBench / CrossCodeEval | 仓库上下文检索和代码补全 | 非主评测，偏模型能力 |
| AgentBench 等通用 Agent 集 | 通用环境交互 | 当前阶段暂不接入 |

第一版建议从 SWE-bench Lite 或 Verified 中固定 10 条任务。若能取得 JavaScript/TypeScript 任务，优先选择同语言任务；否则可用 Python 任务验证 Runner，但需要在报告中标注语言和环境差异。

SWE-bench 任务应被视为外部 E2E 检查。它同时受到模型、Agent Loop、工具、依赖安装、测试环境和任务难度影响，因此不能单独定位 Agent Runtime 的具体缺陷。

## 3. 两条评测轨道

### 3.1 Agent Core Track

使用 scripted model 或 recorded model response，固定模型输出的工具调用序列，隔离 Runtime 行为。典型场景包括：

- 工具 schema 错误和 malformed tool call；
- `read_file → edit_file → run_tests` 多 step 上下文传递；
- 写入或执行权限请求、批准、拒绝和取消；
- 工具失败后的重试与恢复；
- Session 重启后 pending permission 和 queued turn 恢复；
- 同一 command 重复提交的幂等性；
- 事件 sequence、tool/result 配对和 turn 状态闭合；
- workspace 路径越界、输出泄露和禁止工具调用。

这一轨道的结果主要反映 Agent Runtime、ToolRuntime 和状态恢复实现。

### 3.2 Agent E2E Track

使用固定的真实模型、模型参数、权限模式和任务集，比较不同 Agent 版本。典型链路为：

```text
用户需求 → 搜索/读取 → 计划 → 编辑 → 权限处理 → 测试 → 失败恢复 → 总结
```

这一轨道最接近用户体验，但结果应描述为“固定模型下的端到端 Agent 性能”，不能宣称完全消除了模型因素。

## 4. 评测集组成

最终规模控制在 50 条以内，建议第一版结构如下：

| 类型 | 数量 | 说明 |
|---|---:|---|
| Agent Core scripted tasks | 15 | 权限、恢复、取消、事件和工具管线 |
| 单文件 Bug 修复 | 10 | 搜索、读取、精确编辑和验证 |
| 跨文件修改 | 8 | 查找调用方、接口保持一致 |
| 测试、配置和诊断 | 7 | 定位失败、选择正确命令和配置入口 |
| 当前项目历史缺陷 | 5 | 从本仓库历史修复提交反推任务 |
| 外部 benchmark 任务 | 5 | SWE-bench Lite/Verified 或 Terminal-Bench |

在开始制作 50 条之前，先制作 10 条试点集：4 条简单单文件任务、3 条跨文件任务、2 条失败恢复或权限任务、1 条当前项目历史缺陷。

10 条任务适合验证评测基础设施，不适合做稳定的性能结论。每条任务占 10 个百分点，应重点观察失败分类和判分器正确性。

## 5. 任务包格式

每条任务必须是一个可复制、可独立运行的实验包：

```text
benchmarks/
  swebench-pilot/
    manifest.json
    tasks/
      task-01/
        task.json
        workspace/
        visible-tests/
        hidden/
    results/
```

推荐的 `task.json`：

```json
{
  "id": "repo__issue-123",
  "source": "swebench-lite",
  "repo": "owner/repository",
  "baseCommit": "abc123",
  "category": "single_file_bugfix",
  "problemStatement": "原始 issue 或经过最小整理的用户需求",
  "permissionPreset": "workspace-write",
  "timeoutMs": 600000,
  "allowedCommands": [
    {
      "command": "pnpm",
      "args": ["test"]
    }
  ],
  "requiredChecks": [
    "inspect_before_write",
    "verify_after_write"
  ],
  "allowedPaths": ["src/**", "tests/**"],
  "forbiddenPaths": ["grader/**", "hidden/**"]
}
```

SWE-bench 数据中的 `patch`、`test_patch`、`FAIL_TO_PASS` 和 `PASS_TO_PASS` 应由 Grader 使用，不能进入 Agent 可见的 workspace 或 prompt。标准修复 patch 也不得暴露给 Agent。

## 6. 从开源数据集制作 10 条试点集

### 6.1 固定数据版本

记录以下信息：

- 数据集名称和版本或 commit；
- 任务 ID；
- 原始仓库和 `base_commit`；
- 任务筛选理由；
- 依赖安装方式；
- 测试命令和预期耗时；
- 任务是否包含已知 flaky test、外部服务或特殊系统依赖。

不要每次运行都重新随机抽样。试点集一旦确定，应保存 manifest，后续 Agent 版本使用完全相同的任务。

### 6.2 任务筛选规则

优先选择：

- 依赖可以预先安装的任务；
- 测试运行时间稳定且较短的任务；
- 不依赖网络、数据库、GPU 或外部凭据的任务；
- 修改范围清晰、适合在 5～10 个 Agent step 内完成的任务；
- 不需要复杂生成代码或特定操作系统行为的任务。

避免选择：

- 测试本身不稳定的任务；
- 需要访问外部服务的任务；
- 仓库安装成本远高于任务本身的任务；
- 标准 patch 明显已经被公开 Agent 轨迹污染的任务；
- 只能通过人工视觉或主观判断才能确定结果的任务。

### 6.3 当前项目历史任务

可以从当前仓库的历史修复提交制作真实任务：

```text
修复提交的 parent commit
→ 编写用户可见需求
→ 把修复提交中的回归测试放到 hidden grader
→ Agent 在 parent commit 上工作
→ 在干净副本中应用 Agent diff
→ 运行 hidden tests 验证行为
```

这类任务可以覆盖当前 TypeScript Runtime、ToolRuntime、Session 和 Web API 的真实问题，并且不需要重新设计业务场景。

## 7. Runner 设计

Runner 必须走当前项目的 API 和事件链路，不能直接调用内部私有方法模拟成功。

各实施阶段的上游入口、当前项目映射和退出条件见 [`coding-agent-test-runner-reference.zh-CN.md`](coding-agent-test-runner-reference.zh-CN.md) 的“实施阶段的证据矩阵”。后续 Runner/Grader PR 必须引用该矩阵中的 `direct`、`local-contract` 或 `adaptation` 证据等级，避免把参考行为误当作已实现能力。

单任务执行流程：

```text
1. checkout base_commit
2. 创建一次性 workspace
3. 预先安装依赖
4. 启动固定版本的 API
5. POST /v1/sessions 创建 Session
6. 发送 problem_statement
7. 通过 SSE 或 events API 收集完整事件
8. 仅自动批准 manifest 中的测试/构建命令
9. 等待 turn/ended 或超时
10. 保存 Git diff 和事件日志
11. 在干净副本中应用 Agent diff
12. 应用 hidden test patch
13. 运行 FAIL_TO_PASS、PASS_TO_PASS 和构建检查
14. 检查禁止路径、安全违规和修改范围
15. 输出单任务 JSON 结果
```

当前 Agent 的 Session、turn、step、tool、permission 和 diff 事件可直接作为过程评分输入。Runner 还应保存：

- Agent 版本和 Git commit；
- 模型 provider、模型名和模型配置摘要；
- 任务环境版本；
- 开始时间、结束时间和超时状态；
- 完整事件日志；
- 最终 diff；
- 判分命令和退出码。

## 8. Grader 和安全隔离

### 8.1 结果判分

主指标为：

\[
Resolved@1 = \frac{一次运行完整通过的任务数}{任务总数}
\]

任务完整通过必须同时满足：

- `FAIL_TO_PASS` 全部通过；
- `PASS_TO_PASS` 没有回归；
- 构建、类型检查或基础测试通过；
- 没有修改禁止路径；
- Agent 正常结束 turn。

### 8.2 过程判分

过程指标采用事件和 Git diff 自动计算：

| 指标 | 自动判定 |
|---|---|
| Inspect-before-write | 首次写操作前有 `glob`、`grep` 或 `read_file` |
| Verify-after-write | 修改后执行测试、构建或诊断 |
| Recovery rate | 首次失败后继续执行并最终通过 |
| Permission correctness | 正确等待、批准、拒绝或取消 permission |
| Scope discipline | 只修改任务允许的路径 |
| Tool efficiency | step、工具调用、重复调用和耗时 |
| Event correctness | sequence 单调、调用结果配对、状态闭合 |

建议综合分为：

\[
AgentScore = 0.7 \times Resolved@1 + 0.3 \times ProcessScore
\]

安全违规使用硬门槛。以下行为应使该任务直接失败，并单独计入违规率：

- 读取或修改 hidden grader；
- 访问 workspace 外路径；
- 修改禁止文件或删除测试；
- 泄露环境变量、API key、token 或私有文件内容；
- 绕过 ToolRuntime、permission 或审计管线。

### 8.3 干净副本判分

Grader 必须在 Agent workspace 之外运行，并在干净副本中完成：

```text
base commit
→ 应用 Agent diff
→ 应用 hidden test patch
→ 运行测试和构建
```

这样可以避免 Agent 通过修改测试、删除判分器或留下本地生成文件获得虚假成功。

## 9. 运行和报告规范

开发阶段每条任务运行一次，用于快速回归。准备发布时每条任务运行三次，用于观察随机性和一致性。

报告至少包含：

- `Resolved@1`；
- `Pass@3`；
- 回归率；
- 安全违规率；
- 各任务类别成功率；
- P50/P90 耗时；
- P50/P90 step 数和工具调用数；
- 首次测试失败后的恢复成功率；
- 失败原因分类；
- Agent 版本、模型配置和数据集版本。

50 条任务中每条任务代表 2 个百分点；10 条试点中每条任务代表 10 个百分点。因此小规模阶段不应仅根据总分决定版本优劣，而应结合任务级结果和失败轨迹。

新旧版本比较必须使用相同任务和相同环境。正式比较时优先使用配对统计：记录新版本成功、旧版本失败以及相反情况；连续指标可使用 bootstrap 置信区间。

## 10. 推荐实施顺序

### 第一步：10 条试点

- 固定 SWE-bench Lite/Verified 的 10 条任务；
- 实现任务 manifest；
- 实现 workspace 隔离；
- 实现 Session/API 驱动；
- 保存完整事件；
- 实现 hidden grader；
- 产出单任务 JSON 和汇总 Markdown。

### 第二步：Agent Core 测试

- 增加 scripted model；
- 增加权限、取消、超时和重启恢复任务；
- 增加事件不变量断言；
- 将这部分接入 PR Smoke。

### 第三步：扩展到 30～50 条

- 增加当前项目历史缺陷；
- 增加跨文件和测试诊断任务；
- 增加少量 Terminal-Bench 或其他外部任务；
- 建立 Nightly Regression；
- 对失败任务持续归档和去重。

## 11. 验收标准

评测基础设施达到可用状态，需要满足：

- 同一任务在相同版本下可重复运行；
- Agent 看不到 hidden grader 和标准 patch；
- Runner 可以记录完整 Session 事件；
- Grader 能区分 Agent 失败、测试失败和环境失败；
- hidden tests、回归测试和禁止路径检查均可自动执行；
- 结果报告能按任务类别、Agent 版本和失败原因比较；
- 至少有一条任务能验证 permission 或恢复流程；
- 评测失败不会修改正式仓库或共享数据库。

## 12. 目录和命名建议

仓库内的 Runner 代码可以使用以下结构；实际任务数据保持在外部数据根目录：

```text
benchmarks/
  swebench-pilot/
    manifest.json
    tasks/
    graders/
    results/

packages/evals/
  src/
    runner.ts
    grader.ts
    event-metrics.ts
    report.ts
```

`packages/evals` 只依赖公共 contracts 和可调用的 API/Runtime 接口，不应把隐藏答案、测试 patch 或 provider secret 编译进公共包。

当前外部数据根目录结构为：

```text
D:\Develop\coding-agent-test\
  datasets\swebench-lite\pilot-01\
    public\
    private\
    runtime\workspaces\
    results\
  sources\swebench-lite\test.parquet
  tools\
    bootstrap-swebench-pilot.ps1
    prepare-swebench-task.ps1
    validate-swebench-pilot.ps1
```

Runner 只向 Agent 暴露 `runtime\workspaces\<task-id>`，不得把 `public\manifest.json`、`private\` 或 `runtime\metadata\` 目录整体传给 Agent。

