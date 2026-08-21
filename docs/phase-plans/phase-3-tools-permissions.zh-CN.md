# Phase 3：工具运行时与权限

## 目标

把“模型能调用工具”变成可审计、可取消、可展示、可审批的统一 Tool Runtime。内置工具只保留本地 workspace 和进程安全基元，所有工具都经过同一条执行管线。

## 参考入口

DSH：

- `D:/Develop/deepseek-harness-fork/packages/core/tools`
- `D:/Develop/deepseek-harness-fork/packages/fs/tool-fs`
- `D:/Develop/deepseek-harness-fork/packages/fs/tool-fs-search`
- `D:/Develop/deepseek-harness-fork/packages/shell`
- `D:/Develop/deepseek-harness-fork/packages/subprocess`
- `D:/Develop/deepseek-harness-fork/packages/interaction`

Claude Code：

- `D:/Develop/claude-code/src/tools.ts`
- `D:/Develop/claude-code/src/Tool.ts`
- `D:/Develop/claude-code/src/hooks/toolPermission`
- `D:/Develop/claude-code/packages/builtin-tools/src/tools`
- `D:/Develop/claude-code/src/services/tools/StreamingToolExecutor.ts`

## 交付物

- `ToolRegistry`、schema validation 和 ToolDefinition；
- parallel/exclusive 调度、进度、取消和错误合成；
- workspace resolver、路径穿越防护和输出预算；
- `read_file`、`glob`、`grep`、`edit_file`、`write_file`；
- `git_status`、`git_diff`、`run_command`、`run_tests`；
- permission policy、approval request/resolved 和审计事件；
- Tool call、diff、terminal 和 permission Web 卡片。

## 工作流任务

### 工具协议

1. 定义工具名称、JSON Schema、风险级别、执行模式和 presentation；
2. 所有调用先生成 `tool/call`，再执行；
3. 工具进度和结果进入事件日志；
4. 结果按预算生成 model view，完整结果进入审计存储。

### Workspace/进程

1. 所有路径通过 resolver 归一化并检查 workspace root；
2. 文件写入以 diff 或 patch 为输入，禁止隐式覆盖；
3. 命令优先使用 argv，显式声明 shell policy；
4. 支持 timeout、stdout/stderr 截断、进程树终止和 exit code。

### 权限

1. read 默认 auto，write/execute 默认 ask；
2. ask 状态在 Web 中可批准、拒绝或取消；
3. approval 必须绑定 Session、Turn、ToolCall 和 workspace；
4. 重复批准、过期批准和取消必须幂等。

## 不包含

- MCP 外部工具发现；
- Subagent 工具；
- 任意 shell 字符串执行；
- Code Mode 或任意代码执行沙箱。

## 测试与验收

- 路径穿越、符号链接、绝对路径和 workspace 外访问测试；
- 命令注入、超时、输出截断和进程树终止测试；
- diff 前后内容、并发工具和兄弟失败取消测试；
- 权限批准/拒绝/重复请求/断线恢复测试；
- Web 完成 Edit 场景：pending diff → 批准 → 写入 → 展示结果。

退出条件：Read-only、Edit、Test 三个场景均可从事件恢复，所有工具调用都能说明调用者、权限、输入摘要、结果和副作用。

## 回滚点

按工具逐个启用；任何新工具可以从 ToolRegistry 禁用，不影响 Session、事件和已有 read-only 能力。
