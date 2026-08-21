# 工具契约

内置工具、MCP 工具和未来的 Subagent 工具都进入同一个 ToolRegistry。Agent Loop 不区分工具来源，只依赖统一的定义、权限和结果类型。

## ToolDefinition

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  executionMode: "parallel" | "exclusive";
  riskLevel: "read" | "write" | "execute" | "network";
  approvalMode: "auto" | "ask" | "deny";
  interruptBehavior: "cancel" | "block";
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  presentCall?(input: unknown): ToolPresentation;
  presentResult?(result: ToolResult): ToolPresentation;
};
```

## 统一执行流程

```text
discover
  → schema validate
  → workspace/policy check
  → approval (auto/ask/deny)
  → execute
  → progress
  → structured result
  → presentation
  → event append
```

任何工具都必须支持稳定的 `toolCallId`、超时、取消、错误 code、可选进度和结构化结果。MCP 工具不能因为来自外部 server 就绕过这些步骤。

## 第一批内置工具

| 工具 | 风险 | 默认执行 | 关键安全规则 |
|---|---|---|---|
| `read_file` | read | auto | 只能读取 workspace 内路径，限制大小 |
| `glob` | read | auto | 只返回 workspace 内匹配结果，限制数量 |
| `grep` | read | auto | 限制目录、文件大小和输出 |
| `edit_file` | write | ask | 以 old/new 或 patch 为输入，返回 diff |
| `write_file` | write | ask | 禁止隐式覆盖，返回 diff/摘要 |
| `git_status` | read | auto | 固定 cwd，结构化输出 |
| `git_diff` | read | auto | 限制输出，避免泄露 workspace 外内容 |
| `run_command` | execute | ask | argv 优先、超时、输出截断、进程树终止 |
| `run_tests` | execute | ask | 复用 command policy，记录 exit/stdout/stderr |

## 工具结果

```ts
type ToolResult = {
  ok: boolean;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    remedy?: string;
  };
  diff?: {
    path: string;
    before: string;
    after: string;
  };
  usage?: {
    bytes: number;
    truncated: boolean;
  };
};
```

工具结果进入上下文前必须经过预算控制；完整 stdout/stderr、diff 和审计字段进入事件存储，模型只接收符合预算的视图。
