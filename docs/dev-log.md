# 开发日志

## 2026-04-23 - Model 层基础实现

### 步骤 1：仓库状态检查

- 运行命令：
  - `Get-ChildItem -Force`
  - `Get-ChildItem -Path src\code_review_agent -Recurse -File`
  - `git status --short`
- 观察结果：
  - 当前项目还是干净骨架，只有包目录和基础配置文件。
  - 工作区没有已有业务实现需要兼容。
- 判断：
  - 可以直接实现第一阶段 model/message/formatter，不需要迁移旧代码。
- 下一步：
  - 先建立 provider-neutral 的内部消息类型，再实现 provider formatter 和 DeepSeek 模型适配器。

### 步骤 2：新增内部消息类型与 formatter 抽象

- 修改文件：
  - `src/code_review_agent/messages/__init__.py`
  - `src/code_review_agent/messages/message.py`
  - `src/code_review_agent/formatters/__init__.py`
  - `src/code_review_agent/formatters/base.py`
  - `src/code_review_agent/formatters/openai_tools.py`
- 具体改动：
  - 新增 provider-neutral 的 `Message`、`Role`、`ToolCall`、`ToolResult`。
  - 新增 `system_message`、`user_message`、`assistant_message`、`tool_message` helper。
  - 新增 formatter 协议 `MessageFormatter`。
  - 新增 OpenAI-compatible formatter，用来转换 `messages` 和 `tools`。
  - 支持解析 assistant 文本响应和原生 `tool_calls`。
- 为什么这样改：
  - 后续 agent loop、tool 层、session 层和 HTTP API 都应该依赖项目内部类型，而不是直接依赖 DeepSeek 或 OpenAI-compatible 的原始 payload。
- 这次修改解决的问题：
  - 建立 runtime 内部逻辑和模型厂商 wire format 之间的稳定边界。

### 步骤 3：新增模型接口与 DeepSeek 适配器

- 修改文件：
  - `src/code_review_agent/models/base.py`
  - `src/code_review_agent/models/openai_compat.py`
  - `src/code_review_agent/models/deepseek.py`
  - `src/code_review_agent/models/__init__.py`
- 具体改动：
  - 新增 `ChatModel`、`ChatRequest`、`ChatResponse`、`ModelUsage`。
  - 新增模型错误类型：`ModelError`、`ModelConfigurationError`、`ModelAPIError`、`ModelResponseParseError`。
  - 实现 `OpenAICompatibleModel`：
    - 使用异步 `httpx` 请求 chat completions。
    - 支持非 streaming 调用。
    - 支持工具 schema 格式化。
    - 支持 usage 解析。
    - 支持 HTTP 错误映射为内部异常。
  - 实现 `DeepSeekModel`：
    - 默认读取 `DEEPSEEK_API_KEY`。
    - 默认读取 `DEEPSEEK_BASE_URL`，缺省为 `https://api.deepseek.com`。
    - 默认读取 `DEFAULT_MODEL`，缺省为 `deepseek-chat`。
- 为什么这样改：
  - 项目默认使用 DeepSeek 作为低成本模型供应商，但 runtime 其他部分只应该依赖 `ChatModel` 接口。
- 这次修改解决的问题：
  - 项目现在有了可替换的模型边界，后续可以继续接 SiliconFlow、OpenRouter、Qwen 或 Ollama。

### 步骤 4：新增测试

- 修改文件：
  - `tests/test_messages.py`
  - `tests/test_openai_formatter.py`
  - `tests/test_openai_compat_model.py`
- 具体改动：
  - 增加消息类型校验测试。
  - 增加 helper 构造函数测试。
  - 增加 formatter 消息转换测试。
  - 增加工具 schema 包装测试。
  - 增加 assistant 文本响应解析测试。
  - 增加 malformed tool call JSON 解析失败测试。
  - 增加 HTTP 请求 payload 构造测试。
  - 增加 usage 解析测试。
  - 增加 HTTP 错误映射测试。
  - 增加 streaming 暂未实现的保护测试。
- 为什么这样改：
  - Model 层是后续 tool 和 agent loop 的基础，必须先用测试锁住行为边界。
- 这次修改解决的问题：
  - 不需要真实 DeepSeek API key，也能验证模型层的请求构造和响应解析逻辑。

### 步骤 5：第一次测试与问题分析

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 11 个测试通过。
  - 3 个异步测试被跳过。
  - Pytest 提示 `pytest.mark.asyncio` 和 `asyncio_mode` 未被识别。
- 问题判断：
  - 当前环境中可用的是 AnyIO pytest 插件。
  - `pytest-asyncio` 没有作为当前测试插件生效，导致 async 测试没有真正执行。
- 原方案：
  - 使用 `pytest.mark.asyncio` 和 `asyncio_mode = "auto"`。
- 为什么调整：
  - 这个方案在当前环境下会让异步测试静默跳过，测试结果不可靠。
- 新方案：
  - 把异步测试标记改为 `pytest.mark.anyio`。
  - 增加 `anyio_backend` fixture，固定使用 `asyncio` backend。
  - 从 `pyproject.toml` 移除 `asyncio_mode = "auto"`。
- 新方案和原方案的区别：
  - 生产代码没有变化。
  - 测试从依赖 `pytest-asyncio` 改为使用当前环境已可用的 AnyIO 插件。
- 下一步：
  - 重新运行完整测试，确认异步测试真实执行。

### 步骤 6：调整后的验证

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 14 个测试全部通过。
  - 异步测试已经真实执行，不再被跳过。
- 运行命令：
  - `$env:PYTHONPATH='src'; python -m compileall src tests`
- 观察结果：
  - 源码和测试都能成功编译。
- 运行命令：
  - `$env:PYTHONPATH='src'; python -c "from code_review_agent.models import ChatRequest, DeepSeekModel, OpenAICompatibleModel; from code_review_agent.messages import user_message; from code_review_agent.formatters import OpenAIChatFormatter; print(ChatRequest(messages=[user_message('hi')]).messages[0].content)"`
- 观察结果：
  - 导入成功。
  - 基础对象构造成功。
  - 输出为 `hi`。
- 清理动作：
  - 删除由测试和编译命令生成的 `__pycache__` 目录。
- 下一步：
  - 检查 git 状态，确认只保留预期源码、测试和日志变更。

### 步骤 7：formatter 细节清理

- 修改文件：
  - `src/code_review_agent/formatters/openai_tools.py`
- 具体改动：
  - tool message 在格式化时，如果 `name` 为空，就不再把 `name: null` 放进 provider payload。
- 为什么这样改：
  - 发送给 provider 的 payload 应该尽量干净，避免不必要的 `null` 字段。
- 这次修改解决的问题：
  - 在接入真实 DeepSeek/OpenAI-compatible API 前，减少 provider 兼容性风险。

### 步骤 8：最终验证

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - formatter 清理后，14 个测试全部通过。
- 清理动作：
  - 删除测试生成的 `__pycache__` 目录。
- 运行命令：
  - `git status --short`
- 观察结果：
  - 剩余变更均为预期变更：
    - 新增源码。
    - 新增测试。
    - 修改 `pyproject.toml`。
    - 新增本开发日志。

## 当前状态

- 已完成：
  - provider-neutral 消息类型。
  - OpenAI-compatible formatter。
  - `ChatModel` 模型接口。
  - DeepSeek-first 模型适配器。
  - mocked HTTP 测试。
  - 中文开发日志。
- 遗留问题：
  - 尚未使用真实 DeepSeek API key 做 smoke test。
  - streaming 字段已保留，但 v1 明确未实现。
  - tool registry、agent loop、session lifecycle、tracing/event、HTTP API 还未实现。

## 后续建议

下一步建议先实现 tools 层：

- `Tool`、`ToolSchema`、`ToolRegistry`。
- 代码审查基础工具：`list_files`、`read_file`、`search_text`。
- 最小工具执行结果类型，并能转换成 agent loop 可使用的 `ToolResult` message。

## 2026-04-25 - Tools 层基础实现

### 步骤 9：开始前检查

- 运行命令：
  - `Get-ChildItem -Path src\code_review_agent\tools -Recurse -File`
  - `Get-ChildItem -Path src\code_review_agent\sandbox -Recurse -File`
  - `Get-ChildItem -Path tests -Recurse -File`
  - `git status --short`
- 观察结果：
  - `tools` 和 `sandbox` 仍然是空包。
  - 现有测试只覆盖 message / formatter / model。
  - 工作区里有 `__pycache__` 和前一阶段尚未提交的源码变更。
- 判断：
  - 可以在不改动既有 model/message 接口的前提下，直接把 tools 层接上。
  - tools 层需要与现有 `messages.ToolCall`、`messages.ToolResult` 和 `ChatRequest.tools` 兼容。
- 下一步：
  - 先实现 tools 层核心抽象，再实现三个基础文件工具。

### 步骤 10：实现 Tool / ToolRegistry / 路径保护 / 基础文件工具

- 修改文件：
  - `src/code_review_agent/tools/base.py`
  - `src/code_review_agent/tools/registry.py`
  - `src/code_review_agent/tools/file_tools.py`
  - `src/code_review_agent/tools/__init__.py`
  - `src/code_review_agent/sandbox/path.py`
  - `src/code_review_agent/sandbox/__init__.py`
- 具体改动：
  - 新增 `ToolContext`，统一携带 `workspace_root`、`run_id`、`metadata`。
  - 新增 `ToolExecutionResult`，保留 `status/content/data/metadata`，并能转换为 `messages.ToolResult`。
  - 新增 `Tool` 抽象，统一处理参数校验和异步执行。
  - 新增 `ToolRegistry`，支持注册、查询、schema 导出和执行封装。
  - 新增最小路径保护 helper：只接受相对路径，禁止越界出 `workspace_root`。
  - 实现 `list_files`、`read_file`、`search_text` 三个内置工具。
- 为什么这样改：
  - 这一层需要把“模型发来的 tool call”变成“可执行的本地工具调用”，同时为后续 tracing、HTTP API 和 agent loop 保留结构化结果。
- 这次修改解决的问题：
  - 项目现在有了可注册、可执行、可导出 schema 的工具层基础设施。
  - 文件工具已经能在单仓库根目录边界内工作。

### 步骤 11：补充 tools 层测试

- 修改文件：
  - `tests/test_tool_registry.py`
  - `tests/test_sandbox_paths.py`
  - `tests/test_file_tools.py`
- 具体改动：
  - 为 `ToolRegistry` 增加注册、重复注册、unknown tool、参数错误、执行错误测试。
  - 为 `ToolExecutionResult.to_message_result()` 增加 success/error 转换测试。
  - 为路径保护增加相对路径、绝对路径、越界路径测试。
  - 为 `list_files` 增加递归、非递归、glob、limit、hidden、默认忽略缓存目录测试。
  - 为 `read_file` 增加按行读取、截断、非 UTF-8 字节替换标记、缺失文件/目录/越界路径测试。
  - 为 `search_text` 增加 Python fallback、`rg` 模拟分支、大小写敏感、limit、context_lines 测试。
- 为什么这样改：
  - tools 层需要比 model 层更强的边界验证，因为它直接涉及本地文件访问。
- 这次修改解决的问题：
  - 能在不依赖真实仓库和不依赖本机一定安装 `rg` 的前提下验证工具行为。

### 步骤 12：第一次测试与问题分析

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 共收集 32 个测试。
  - 30 个通过，2 个失败。
- 失败 1：
  - 用例：`test_read_file_reads_ranges_and_truncates`
  - 现象：返回内容只有 header 和 `...[truncated]`，没有保留下行号正文。
  - 判断：
    - 当前 `read_file` 的 `max_chars` 同时限制 header 和正文。
    - 当上限很小时，header 抢占了预算，正文可能完全被裁掉。
- 失败 2：
  - 用例：`test_search_text_respects_case_sensitivity`
  - 现象：`subprocess.run(["rg", ...])` 在当前 Windows 环境里触发 `PermissionError: [WinError 5] 拒绝访问`。
  - 判断：
    - 环境里虽然能发现 `rg`，但执行被系统拒绝。
    - 单纯依赖 `shutil.which("rg")` 不足以判断 `rg` 能真正执行。
- 原方案：
  - `read_file` 用总字符数限制完整渲染文本。
  - `search_text` 只要发现 `rg` 就优先执行 `rg`。
- 为什么调整：
  - 原方案在小 `max_chars` 场景下会损失正文可读性。
  - 原方案在当前环境下会因为 `rg` 权限问题导致工具直接失败，而不是平滑降级。
- 新方案：
  - `read_file` 改为“header 永远保留，`max_chars` 只限制正文”。
  - `search_text` 改为“若 `rg` 调用因系统/OSError 失败，则自动回退到 Python fallback，并在 metadata 记录 `rg_error`”。
- 新方案和原方案的区别：
  - `read_file` 的截断语义更偏向“保证可读结果”，而不是严格限制总返回字数。
  - `search_text` 从“静态发现 `rg`”改为“动态尝试 `rg`，失败再降级”。

### 步骤 13：第二次测试与再次收口

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 31 个通过，1 个失败。
- 失败用例：
  - `test_read_file_reads_ranges_and_truncates`
- 现象：
  - 断言 `result.data["truncated"] is True` 失败，实际为 `False`。
- 判断：
  - 代码已经按新语义工作。
  - 问题是测试仍按旧语义编写：它给的 `max_chars=30` 在“只限制正文”的语义下已经不会触发截断。
- 原方案：
  - 用 `max_chars=30` 断言触发截断。
- 为什么调整：
  - 这是测试假设和实现语义不一致，不是生产代码缺陷。
- 新方案：
  - 把测试里的 `max_chars` 改小到 `12`，稳定覆盖“正文被截断但仍保留第一行”的场景。
- 新方案和原方案的区别：
  - 生产代码不变。
  - 测试改成与当前截断语义一致的验证方式。

### 步骤 14：最终测试与烟雾验证

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 32 个测试全部通过。
- 运行命令：
  - `$env:PYTHONPATH='src'; python -c "from pathlib import Path; from code_review_agent.tools import ToolRegistry, ToolContext, ListFilesTool, ReadFileTool, SearchTextTool; registry = ToolRegistry(); registry.register(ListFilesTool()); registry.register(ReadFileTool()); registry.register(SearchTextTool()); print([schema['name'] for schema in registry.get_model_schemas()]); print(ToolContext(workspace_root=Path('.').resolve()).workspace_root)"`
- 观察结果：
  - 三个工具都能成功注册。
  - 导出的 schema 名称为 `['list_files', 'read_file', 'search_text']`。
  - `ToolContext` 能正常构造。
- 运行命令：
  - `$env:PYTHONPATH='src'; python -m compileall src tests`
- 观察结果：
  - 源码和测试都能成功编译。
- 下一步：
  - 清理 `__pycache__`，只保留预期源码、测试和日志变更。

## 当前状态（Tools 层阶段结束）

- 已完成：
  - `Tool` 抽象。
  - `ToolContext`。
  - `ToolExecutionResult`。
  - `ToolRegistry`。
  - 最小路径保护 helper。
  - `list_files` / `read_file` / `search_text`。
  - tools 层完整测试。
- 遗留问题：
  - 还没有 shell tool，也没有强化版 sandbox。
  - `search_text` 的 `rg` 分支在某些 Windows 环境里可能会因系统策略被拒绝，目前靠 Python fallback 兜底。
  - `read_file` 当前把 `max_chars` 定义为“正文字符上限”，不是“总输出字符上限”，后续如果 HTTP API 需要严格响应预算，可能还要再统一定义。
- 后续建议：
  - 下一步优先接 `agent loop` 的最小闭环：
    - 模型返回 `tool_calls`
    - registry 执行工具
    - 工具结果转成 tool message
    - 再喂回模型直到得到最终 assistant 文本

## 2026-04-25 - 最小 Agent Loop 实现

### 步骤 15：实现前检查

- 运行命令：
  - `python -c "from pathlib import Path; print(Path('src/code_review_agent/harness/__init__.py').read_text(encoding='utf-8'))"`
  - `python -c "from pathlib import Path; print(Path('src/code_review_agent/messages/__init__.py').read_text(encoding='utf-8'))"`
  - `git status --short`
- 观察结果：
  - `harness` 仍然是空包。
  - 仓库里还没有 `session` 包。
  - `message`、`model`、`tools` 三层已经能被 agent loop 直接消费。
- 判断：
  - 这一阶段的核心是把现有抽象串起来，而不是继续扩展 provider/tool 能力。
- 下一步：
  - 先补 `session` 包和 `harness` 结果类型，再实现 `Agent.run()`。

### 步骤 16：新增 session 与 harness 类型

- 修改文件：
  - `src/code_review_agent/session/base.py`
  - `src/code_review_agent/session/in_memory.py`
  - `src/code_review_agent/session/__init__.py`
  - `src/code_review_agent/harness/types.py`
  - `src/code_review_agent/harness/__init__.py`
- 具体改动：
  - 新增 `Session` 抽象，提供 `append/get_messages/clear`。
  - 新增 `InMemorySession`，内部用内存列表维护消息，并在读写时做深拷贝。
  - 新增 `AgentStep`、`AgentRunResult`、`AgentRunStatus`，用于表达结构化运行结果。
- 为什么这样改：
  - 最小 agent loop 不能只返回一段文本，否则后续很难接 tracing、HTTP API 和开发日志。
  - session 需要先有正式落点，否则多轮对话和 session 复用会继续散落在 harness 内部。
- 这次修改解决的问题：
  - 建立了 agent loop 的公共返回类型和会话边界。

### 步骤 17：实现 Agent.run() 最小闭环

- 修改文件：
  - `src/code_review_agent/harness/agent.py`
- 具体改动：
  - 新增 `Agent` 类。
  - 实现 `run(user_input, tool_context, reset_session=True)`：
    - 可选清空 session。
    - 可选写入 system prompt。
    - 写入 user message。
    - 循环调用 `model.complete()`。
    - 把 assistant message 写回 session，并记录 `model_response` step。
    - 若模型返回 `tool_calls`，串行调用 `ToolRegistry.invoke()`。
    - 把工具结果转成 tool message 回填到 session。
    - 记录 `tool_call` step。
    - 当无 tool calls 时返回 `completed`。
    - 达到最大迭代次数时返回 `max_iterations`。
    - 捕获 `ModelError` 并归一化为 `failed` 结果，而不是抛异常。
  - 新增 usage 累加辅助逻辑，把多轮 `ModelUsage` 汇总到 `AgentRunResult.usage`。
- 为什么这样改：
  - 这是把现有 `model + tools + messages` 变成真实 agent 运行闭环的最小实现。
- 这次修改解决的问题：
  - 项目第一次具备“模型可请求工具、工具结果可回填模型、最终给出结构化 run result”的能力。

### 步骤 18：新增 session 与 agent loop 测试

- 修改文件：
  - `tests/test_session.py`
  - `tests/test_agent_loop.py`
- 具体改动：
  - 增加 `InMemorySession` 的 append/get_messages/clear 测试。
  - 增加最小 agent loop 的以下场景测试：
    - 模型直接返回最终答案。
    - 模型先发一个 tool_call，再给最终答案。
    - 多个 tool call 按顺序执行。
    - 达到 `max_iterations`。
    - 模型层异常归一化为 `failed`。
    - 模型返回 tool calls 但 registry 缺失。
    - 工具报错但 loop 继续运行到下一轮。
    - `reset_session=False` 的多轮对话复用。
    - usage 汇总以及缺失 usage 的处理。
- 为什么这样改：
  - agent loop 的正确性主要体现在消息顺序、停止条件和错误归一化，必须靠行为测试锁住。
- 这次修改解决的问题：
  - 最小 loop 的核心行为都可回归验证。

### 步骤 19：第一次测试与问题分析

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 共收集 43 个测试。
  - 42 个通过，1 个失败。
- 失败用例：
  - `test_agent_continues_after_tool_error_result`
- 现象：
  - 断言 `result.messages[2].role.value == "assistant"` 失败，实际是 `"tool"`。
- 问题判断：
  - 这是测试本身的索引假设错误，不是生产代码问题。
  - 该用例没有 system prompt，正确消息顺序应为：
    - `user -> assistant -> tool -> assistant`
- 原方案：
  - 用固定索引断言消息角色。
- 为什么调整：
  - 固定索引太脆弱，尤其当不同测试场景是否有 system prompt 不同时容易误判。
- 新方案：
  - 改为断言完整消息角色序列。
- 新方案和原方案的区别：
  - 生产代码不变。
  - 测试从“单点索引”改成“整体顺序”验证，更接近 loop 语义。

### 步骤 20：最终测试与烟雾验证

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 43 个测试全部通过。
- 运行命令：
  - `$env:PYTHONPATH='src'; python -c "from pathlib import Path; from code_review_agent.harness import Agent; from code_review_agent.session import InMemorySession; from code_review_agent.tools import ToolRegistry, ToolContext, ListFilesTool; from code_review_agent.models import ChatModel; print(Agent.__name__); print(InMemorySession.__name__); registry = ToolRegistry(); registry.register(ListFilesTool()); print([schema['name'] for schema in registry.get_model_schemas()]); print(ToolContext(workspace_root=Path('.').resolve()).workspace_root)"`
- 观察结果：
  - `Agent`、`InMemorySession`、`ToolRegistry` 都能正常导入和使用。
  - `ListFilesTool` schema 可以正常导出。
- 运行命令：
  - `$env:PYTHONPATH='src'; python -m compileall src tests`
- 观察结果：
  - 源码和测试均可成功编译。

## 当前状态（最小 Agent Loop 阶段结束）

- 已完成：
  - `Session` / `InMemorySession`
  - `AgentStep` / `AgentRunResult`
  - `Agent.run()` 最小闭环
  - usage 汇总
  - agent loop 行为测试
- 遗留问题：
  - 还没有 tracing 事件输出。
  - 还没有持久化 session。
  - 还没有 HTTP API 层的 run lifecycle 封装。
  - 还没有 streaming。
- 后续建议：
  - 下一步优先做 runtime/API 入口：
    - `create run`
    - `run status/result`
    - 基础事件记录
  - 如果希望先增强 agent 本身，也可以先补：
    - 基础 tracing/event
    - 最小 repo analyst app 入口

## 2026-04-25 - 最小 Runtime / API 实现

### 步骤 21：实现前检查

- 运行命令：
  - `Get-ChildItem -Path src\code_review_agent -Directory | Select-Object -ExpandProperty Name`
  - `python -c "from pathlib import Path; print(Path('src/code_review_agent/runtime/__init__.py').read_text(encoding='utf-8'))"`
  - `python -c "from pathlib import Path; print(Path('src/code_review_agent/api/__init__.py').read_text(encoding='utf-8'))"`
- 观察结果：
  - `runtime` 和 `api` 仍然只有空包或非常薄的占位导出。
  - 现有 `Agent`、`ToolRegistry`、`InMemorySession` 已经足够支撑最小 runtime。
- 判断：
  - 可以先做 in-memory run store 和 background execution，不需要马上引入数据库。
- 下一步：
  - 先落 runtime types/store/service，再接 FastAPI app 和 routes。

### 步骤 22：实现 runtime 类型、store 和 service

- 修改文件：
  - `src/code_review_agent/runtime/types.py`
  - `src/code_review_agent/runtime/store.py`
  - `src/code_review_agent/runtime/service.py`
  - `src/code_review_agent/runtime/__init__.py`
- 具体改动：
  - 新增 `RunStatus`、`RunEvent`、`RunRecord`、`CreateRunRequest`。
  - 新增 `InMemoryRunStore`，负责管理 run record 和 event。
  - 新增 `AgentRuntime`：
    - `create_run()`
    - `get_run()`
    - `list_runs()`
    - `get_events()`
    - `execute_run()`
  - 在 `execute_run()` 中：
    - 创建 `Agent`
    - 运行 agent loop
    - 保存 `AgentRunResult`
    - 把 `AgentStep` 转成最小 runtime event
    - 更新 run status
  - 新增默认 runtime builder：
    - 默认使用 `DeepSeekModel`
    - 默认工具注册 `list_files/read_file/search_text`
- 为什么这样改：
  - runtime 需要把“单次 agent 执行”提升为“可创建、可查询、可记录事件的 run”。
- 这次修改解决的问题：
  - 项目现在第一次具备了 run lifecycle 雏形。

### 步骤 23：实现 FastAPI 入口

- 修改文件：
  - `src/code_review_agent/api/app.py`
  - `src/code_review_agent/api/routes.py`
  - `src/code_review_agent/api/__init__.py`
- 具体改动：
  - 新增 `create_app(runtime=None)`，允许测试时注入 fake runtime。
  - 新增路由：
    - `GET /health`
    - `GET /runs`
    - `POST /runs`
    - `GET /runs/{run_id}`
    - `GET /runs/{run_id}/events`
  - `POST /runs` 使用 `BackgroundTasks` 触发 `runtime.execute_run()`。
  - 缺失 run 时统一返回 404。
- 为什么这样改：
  - 这一阶段的目标不是复杂 API，而是先有一个可服务化调用的最小入口。
- 这次修改解决的问题：
  - 项目现在不仅能本地直接运行 agent，也有了最小 HTTP 接口面。

### 步骤 24：新增 runtime / API 测试

- 修改文件：
  - `tests/test_runtime.py`
  - `tests/test_api.py`
- 具体改动：
  - runtime tests 覆盖：
    - create -> execute -> completed
    - workspace 不存在时 failed
    - `list_runs()` 顺序
    - event 序列
  - API tests 覆盖：
    - `/health`
    - `/runs` 创建
    - `/runs/{id}`
    - `/runs/{id}/events`
    - 缺失 run 的 404
  - API tests 使用可注入 fake runtime，不依赖真实 DeepSeek API。
- 为什么这样改：
  - runtime/API 的核心在于状态迁移和可查询性，不能只靠肉眼看代码。
- 这次修改解决的问题：
  - run lifecycle 和 HTTP 入口有了回归验证。

### 步骤 25：第一次测试与问题分析

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 测试收集阶段报错。
  - `tests/test_api.py` 导入失败，`ModuleNotFoundError: No module named 'fastapi'`。
- 问题判断：
  - 当前执行环境没有安装 `fastapi`。
  - 这不是 runtime/service 实现问题，而是测试环境缺依赖。
- 原方案：
  - API tests 默认直接运行。
- 为什么调整：
  - 当前环境无法保证 API 层依赖存在，但 service 层仍然应该继续被测试。
- 新方案：
  - `tests/test_api.py` 改成 `pytest.importorskip("fastapi.testclient")`。
  - 有 FastAPI 就执行 API tests，没有就跳过。
- 新方案和原方案的区别：
  - 生产代码不变。
  - 测试策略从“强依赖环境已安装 FastAPI”改为“能力检测后执行”。

### 步骤 26：第二次测试与排序问题

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - API tests 被跳过。
  - `test_runtime_lists_runs_in_reverse_creation_order` 失败。
- 现象：
  - `list_runs()` 返回顺序不是最新 run 在前。
- 问题判断：
  - 当前实现按 `created_at` 排序。
  - 两个 run 的创建时间过于接近时，这个排序对测试不稳定。
- 原方案：
  - `list_runs()` 按 `created_at` 倒序。
- 为什么调整：
  - 对 in-memory store 而言，“创建顺序倒序”才是更稳定、更直接的语义。
- 新方案：
  - 改为按字典插入顺序反转返回。
- 新方案和原方案的区别：
  - 舍弃“时间排序”这个脆弱条件。
  - 采用“创建顺序倒序”这个对内存 store 更稳定的策略。

### 步骤 27：最终测试与环境验证

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - `46 passed, 1 skipped`
  - 跳过的是 API tests，原因是环境里缺少 FastAPI。
- 运行命令：
  - `$env:PYTHONPATH='src'; python -c "from code_review_agent.runtime import AgentRuntime, build_default_tool_registry, CreateRunRequest; registry = build_default_tool_registry(); print([schema['name'] for schema in registry.get_model_schemas()]); run = CreateRunRequest(user_input='hello', workspace_root='.'); print(run.user_input)"`
- 观察结果：
  - runtime public API 正常导入。
  - 默认工具 schema 可正常导出。
- 运行命令：
  - `python -c "import importlib.util; print(importlib.util.find_spec('fastapi'))"`
- 观察结果：
  - 输出 `None`，确认当前环境确实没有安装 FastAPI。
- 运行命令：
  - `$env:PYTHONPATH='src'; python -m compileall src tests`
- 观察结果：
  - 源码和测试编译通过。

## 当前状态（最小 Runtime / API 阶段结束）

- 已完成：
  - `RunRecord` / `RunEvent` / `RunStatus`
  - `InMemoryRunStore`
  - `AgentRuntime`
  - 最小 FastAPI app/route 设计
  - runtime/service tests
  - 可选执行的 API tests
- 遗留问题：
  - 当前环境未安装 FastAPI，API tests 只能跳过，无法在本机直接运行 HTTP 端到端验证。
  - 仍然没有持久化 store。
  - 仍然没有 tracing/event exporter，只是最小 event list。
  - 还没有真正的 repo analyst app 入口。
- 后续建议：
  - 下一步可选两条路线：
    - 先做 observability/event 层，把 runtime events 结构化得更完整
    - 或者直接做 repo analyst app，把默认 system prompt 和工具使用策略具体化

## 2026-04-25 - Repo Analyst App 实现

### 步骤 28：实现前检查

- 运行命令：
  - `Get-ChildItem -Path src\code_review_agent\apps\repo_analyst -Recurse -File`
  - `python -c "from pathlib import Path; print(Path('src/code_review_agent/apps/repo_analyst/__init__.py').read_text(encoding='utf-8'))"`
  - `python -c "from pathlib import Path; print(Path('src/code_review_agent/runtime/types.py').read_text(encoding='utf-8'))"`
- 观察结果：
  - `apps/repo_analyst` 还是空包。
  - runtime 和 API 已经具备通用 `/runs` 与事件能力。
- 判断：
  - repo analyst app 适合做成“专用 façade”，而不是重写底层 runtime。
- 下一步：
  - 先补 app 层的类型、prompt、parser、service，再接专用 API。

### 步骤 29：实现 repo analyst app 层

- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/types.py`
  - `src/code_review_agent/apps/repo_analyst/prompt.py`
  - `src/code_review_agent/apps/repo_analyst/parser.py`
  - `src/code_review_agent/apps/repo_analyst/service.py`
  - `src/code_review_agent/apps/repo_analyst/__init__.py`
- 具体改动：
  - 新增 `RepoAnalystReport`、`RepoModule`、`RepoAnalystRequest`、`RepoAnalystRunResult`。
  - 新增 repo analyst system prompt 生成函数：
    - 要求必须基于仓库内容作答
    - 优先读取 README / 入口 / 配置 / 主代码目录
    - 最终只输出 JSON
  - 新增 JSON 报告解析器：
    - 从 `AgentRunResult.final_message.content` 解析 JSON
    - 用 Pydantic 校验
    - 非法时抛 `RepoAnalystParseError`
  - 新增 `RepoAnalystService`：
    - 复用现有 `AgentRuntime`
    - 把 app 请求映射成底层 `CreateRunRequest`
    - 执行后把通用 run 转成 repo analyst app 结果
- 为什么这样改：
  - repo analyst 的差异主要在 prompt 和结果 shape，不需要发明第二套 runtime。
- 这次修改解决的问题：
  - 项目现在有了一个真正面向“仓库分析”场景的专用 app 层。

### 步骤 30：接入 repo analyst 专用 API

- 修改文件：
  - `src/code_review_agent/api/routes.py`
  - `src/code_review_agent/api/app.py`
- 具体改动：
  - 新增 `RepoAnalystService` 注入。
  - 新增路由：
    - `POST /repo-analyst/runs`
    - `GET /repo-analyst/runs/{run_id}`
    - `GET /repo-analyst/runs/{run_id}/events`
  - 保持通用 `/runs` 不变。
- 为什么这样改：
  - repo analyst app 需要清晰的 app 边界，而不是通过不同 prompt 去共用同一组业务入口。
- 这次修改解决的问题：
  - HTTP 层现在已经能直接创建和查询 repo analyst 任务。

### 步骤 31：新增 repo analyst 测试

- 修改文件：
  - `tests/test_repo_analyst.py`
  - `tests/test_api.py`
- 具体改动：
  - 为 repo analyst prompt 增加构造测试。
  - 为 JSON parser 增加合法/非法/缺字段场景测试。
  - 为 `RepoAnalystService` 增加 fake model 测试。
  - 为 `/repo-analyst/runs` API 增加创建、查询、events、404 测试。
- 为什么这样改：
  - 这个 app 的关键不是“能调模型”，而是“结果必须变成稳定的结构化报告”。
- 这次修改解决的问题：
  - repo analyst app 的结果格式和 API 行为有了回归保障。

### 步骤 32：第一次测试与 schema 问题

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - 51 个测试通过，1 个失败，1 个跳过。
- 失败用例：
  - `test_repo_analyst_parser_rejects_schema_mismatch`
- 现象：
  - 只包含 `summary` 的 JSON 也能通过 parser 校验。
- 问题判断：
  - 当前 `RepoAnalystReport` 把 `modules/architecture/risks/next_steps` 都设成了默认空列表。
  - 这使得缺字段报告被当成合法报告。
- 原方案：
  - 结构化报告字段允许默认空值。
- 为什么调整：
  - 计划和测试都要求字段固定，缺字段应视为 app 输出不合格。
- 新方案：
  - 把 `modules/architecture/risks/next_steps` 改成必填字段。
- 新方案和原方案的区别：
  - 要求模型必须完整输出约定的 JSON 结构。
  - 解析器对格式错误更严格。

### 步骤 33：最终测试与 dl 环境验证

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - `52 passed, 1 skipped`
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest`
- 观察结果：
  - `57 passed`
  - 在 `dl` 环境里，FastAPI 相关测试也真实执行通过。
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest`
  - 之前还用于验证 `fastapi` / `pytest` 环境问题
- 判断：
  - 现在 repo analyst 的 Python 层、runtime 层和 API 层都已经在 `dl` 环境下跑通。

### 步骤 34：README 更新

- 修改文件：
  - `README.md`
- 具体改动：
  - 新增 repo analyst app 说明。
  - 新增 `dl` 环境下的启动命令。
  - 新增调用 `/repo-analyst/runs` 的最小示例。
- 为什么这样改：
  - 现在这个项目已经不仅是一个代码库，而是一个能运行的 app，需要把基本使用方式写清楚。

## 当前状态（Repo Analyst App 阶段结束）

- 已完成：
  - repo analyst 类型、prompt、parser、service
  - repo analyst 专用 API
  - README 基本使用说明
  - repo analyst tests
  - `dl` 环境下完整测试通过
- 遗留问题：
  - 还没有前端页面
  - 还没有报告重试机制；模型输出非法 JSON 时直接判为失败
  - 还没有更细的 app-level event 类型
- 后续建议：
  - 下一步优先做 observability/event 整理，或者给 repo analyst 增加一个简单 Web 结果页

## 2026-04-25 - Repo Analyst 前端页面

### 步骤 35：实现前检查

- 运行命令：
  - `Get-ChildItem -Path web -Recurse -Force`
  - `python -c "from pathlib import Path; print(Path('src/code_review_agent/api/app.py').read_text(encoding='utf-8'))"`
  - `python -c "from pathlib import Path; print(Path('src/code_review_agent/api/routes.py').read_text(encoding='utf-8'))"`
  - `Get-Content -Path pyproject.toml`
- 观察结果：
  - 顶层 `web` 目录为空。
  - 现有 FastAPI app 已经有通用和 repo analyst API，但没有前端页面。
  - 项目没有模板引擎依赖。
- 判断：
  - 最稳妥的做法是做一个挂在现有 FastAPI 服务上的静态单页，不引入额外前端构建工具。
- 下一步：
  - 在包内新增 `web/index.html`，通过根路径 `/` 直接提供 UI。

### 步骤 36：实现前端页面和列表接口

- 修改文件：
  - `src/code_review_agent/web/index.html`
  - `src/code_review_agent/api/routes.py`
  - `src/code_review_agent/apps/repo_analyst/service.py`
  - `pyproject.toml`
- 具体改动：
  - 新增单页前端：
    - 左栏提交 repo analyst 任务
    - 中栏显示任务列表
    - 右栏显示结构化报告、失败原因和事件
    - 前端通过 `fetch` 调用 `/repo-analyst/runs` 相关接口
    - 对 `queued/running` 状态做自动轮询
  - 新增根路径 `/`，直接返回前端 HTML。
  - 新增 `GET /repo-analyst/runs` 列表接口。
  - 给 `RepoAnalystService` 增加 `list_runs()`。
  - 在 `pyproject.toml` 里把 `web/*.html` 加入包数据，避免安装后丢失前端页面文件。
- 为什么这样改：
  - 当前项目已经有结构化报告和 API，最适合直接做一个简洁的操作型前端，而不是继续只做后端。
- 这次修改解决的问题：
  - 项目现在有了第一个真正可交互的使用界面。

### 步骤 37：发现 app 边界问题并修正

- 观察结果：
  - `RepoAnalystService.list_runs()` 一开始直接映射 `runtime.list_runs()`。
  - 这样会把通用 `/runs` 创建的任务也带到 repo analyst 列表里。
- 问题判断：
  - repo analyst app 需要有自己明确的 run 边界，否则 UI 会混入非 repo analyst 任务。
- 原方案：
  - repo analyst 只是一层展示转换，不给 run 打 app 标记。
- 为什么调整：
  - 一旦项目里同时存在通用 run 和 repo analyst run，列表和查询语义就会混乱。
- 新方案：
  - 在 `RunRecord` / `CreateRunRequest` 中增加 `app_name`。
  - repo analyst 创建 run 时写入 `app_name="repo_analyst"`。
  - repo analyst 的 `list_runs/get_run` 只处理带这个标记的 run。
- 新方案和原方案的区别：
  - 增加了轻量 app 身份字段。
  - app façade 从“软约束”变成“明确过滤”。

### 步骤 38：新增前端和 app 边界测试

- 修改文件：
  - `tests/test_api.py`
- 具体改动：
  - 增加 `GET /` 返回 HTML 测试。
  - 增加 `/repo-analyst/runs` 列表过滤通用 run 的测试。
- 为什么这样改：
  - 前端页面和 app 边界都属于用户直接感知的行为，必须有回归测试。

### 步骤 39：测试与验证

- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
- 观察结果：
  - `52 passed, 1 skipped`
  - base 环境下 FastAPI 相关测试继续按环境策略跳过。
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest`
- 观察结果：
  - `59 passed`
  - 说明 repo analyst 前端相关 API 测试在 `dl` 环境里真实执行通过。

### 步骤 40：启动服务并验证页面

- 运行命令：
  - 检查端口：`Get-NetTCPConnection -LocalPort 8000`
  - 后台启动：`conda run -n dl python -m uvicorn code_review_agent.api.app:create_app --factory --host 127.0.0.1 --port 8000`
  - 页面验证：`Invoke-WebRequest http://127.0.0.1:8000/`
- 观察结果：
  - `127.0.0.1:8000` 成功监听。
  - 根路径返回 `200`。
  - 页面 HTML 正常返回，标题为 `Code Review Agent`。

## 当前状态（前端页面阶段结束）

- 已完成：
  - Repo Analyst 单页前端
  - 根路径 UI
  - repo analyst 列表接口
  - app_name 过滤机制
  - `dl` 环境下前后端测试通过
  - 服务已可本地启动
- 遗留问题：
  - 前端仍是单文件静态页，没有组件化拆分
  - 没有图表或更细的交互过滤
  - 还没有对 API 失败做更细的重试策略
- 后续建议：
  - 下一步优先做 observability 页面细化，或者把前端拆成更清晰的静态资源结构

## 2026-04-25 - 根目录配置文件整理

### 步骤 41：检查根目录配置文件与 `.env` 加载方式
- 运行命令：
  - `Get-ChildItem -Force`
  - `Get-Content .env`
  - `Get-Content src\code_review_agent\settings.py`
  - `Get-Content pyproject.toml`
- 观察结果：
  - 根目录已经有 `.env` 和 `.env.example`
  - 当前 `.env` 已包含 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEFAULT_MODEL` 等字段
  - `settings.py` 使用了 `pydantic_settings.BaseSettings`
- 问题判断：
  - 项目根目录文件方向是对的，但配置加载实现把一个额外依赖带进了导入路径
  - 当前 base 环境没有安装 `pydantic_settings`，会导致测试在收集阶段直接失败
- 下一步：
  - 保留根目录 `.env` 方案不变
  - 把配置加载改成标准库实现，避免额外依赖卡住开发环境

### 步骤 42：改造设置加载并补齐根目录文件
- 修改文件：
  - `src/code_review_agent/settings.py`
  - `pyproject.toml`
  - `.gitignore`
  - `README.md`
- 具体改动：
  - 用 `dataclass + os.getenv + 根目录 .env 手工解析` 重写 `settings.py`
  - 删除 `pyproject.toml` 中未再使用的 `pydantic-settings` 依赖
  - 新增根目录 `.gitignore`，忽略 `.env`、缓存、`runtime.db`、`tmp`、`*.egg-info`
  - 在 `README.md` 中补充“从 `.env.example` 复制到 `.env`”的说明
- 为什么这样改：
  - 用户的目标是“在项目根目录里放好相关文件，并且能直接用”
  - 对这个目标来说，根目录有 `.env`、`.env.example`、`.gitignore`、README 启动说明才算完整
  - 配置读取逻辑应该尽量少依赖环境差异，否则根目录文件放好了也不稳
- 这次修改想解决的问题：
  - 让根目录配置文件真正能被程序读取
  - 避免因为缺少 `pydantic_settings` 导致 base 环境无法导入项目
  - 让 `.env`、缓存和本地数据库不会被误提交

### 步骤 43：测试与调试
- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest`
  - `$env:PYTHONPATH='src'; conda run -n dl python -c "from code_review_agent.settings import get_settings; s = get_settings(); print(s.deepseek_base_url); print(s.default_model); print(s.runtime_workspace_root)"`
- 观察结果：
  - 之前未修复前，base 环境会报：`ModuleNotFoundError: No module named 'pydantic_settings'`
  - 改造后预期应恢复 base 环境测试收集
  - `dl` 环境中的设置读取应继续正常工作
- 问题判断：
  - 原问题不是 `.env` 文件本身，而是配置层实现绑定了一个当前环境不具备的依赖
- 接下来准备怎么改：
  - 如果 base 和 `dl` 环境测试都恢复，就保留当前实现
  - 如果还有兼容问题，再缩减 `.env` 解析逻辑，继续保持无额外依赖

## 当前状态（根目录配置整理阶段）
- 已完成：
  - 根目录 `.env`
  - 根目录 `.env.example`
  - 根目录 `.gitignore`
  - README 中的根目录配置说明
  - 标准库实现的 `.env` 自动加载
- 遗留问题：
  - 还需要完成本轮 base / `dl` 双环境复测
- 后续建议：
  - 根目录配置稳定后，下一步优先接真实 DeepSeek key 做一次端到端 repo analyst 运行验证

## 2026-04-25 - Repo Analyst 输出失败修复（invalid_repo_analyst_report）

### 步骤 44：复现并定位失败原因
- 输入背景：
  - 用户第一次运行使用默认迭代上限，结果 `max_iterations_reached`
  - 第二次将迭代上限调到 100，任务完成但 `failure_reason=invalid_repo_analyst_report`
  - 用户提供了根目录 `test2_result.txt` 作为原始模型输出
- 运行命令：
  - `Get-Content test2_result.txt`
  - `Get-Content src\code_review_agent\apps\repo_analyst\parser.py`
  - `Get-Content src\code_review_agent\apps\repo_analyst\types.py`
  - `Get-Content src\code_review_agent\apps\repo_analyst\prompt.py`
- 观察结果：
  - 原始输出不是“纯 JSON 全文”，而是“前置说明文本 + ```json 代码块 + JSON 内容”
  - 现有 parser 只做 `json.loads(raw_text)`，要求全文必须是 JSON
- 问题判断：
  - 失败不是“分析内容错误”，而是“格式不满足 parser 的严格输入假设”
  - 这是模型常见行为：即使 prompt 要求“只输出 JSON”，也可能附带解释文本或 markdown fence
- 下一步：
  - 改成更稳健解析，保留 schema 严格校验不变

### 步骤 45：实现更稳健解析
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/parser.py`
- 具体改动：
  - 新增 `_candidate_json_texts(raw_text)`，按顺序生成候选 JSON 文本：
    - 全文原文
    - markdown ```json ... ``` 代码块内容
    - 自由文本中提取的首个平衡 `{...}` JSON 对象
  - 新增 `_extract_first_json_object(text)`，基于括号深度 + 字符串状态机提取首个完整 JSON 对象
  - `parse_repo_analyst_report` 改为遍历候选并依次 `json.loads`，任一成功即进入 schema 校验
  - 若全部失败，仍抛 `RepoAnalystParseError("repo analyst output is not valid JSON")`
  - schema 校验继续使用 `RepoAnalystReport.model_validate(...)`，字段严格性不降低
- 为什么这样改：
  - 要提高容错，解决“有实质分析结果但包装格式不纯”导致的误判失败
  - 同时保持输出结构约束，避免放宽到“任意文本都算成功”
- 这次修改想解决的问题：
  - 修复真实运行中频繁出现的 `invalid_repo_analyst_report` 误判

### 步骤 46：补充回归测试
- 修改文件：
  - `tests/test_repo_analyst.py`
- 具体改动：
  - 新增 `test_repo_analyst_parser_accepts_json_markdown_fence`
    - 覆盖“前置说明 + ```json 代码块”场景（对应本次真实失败）
  - 新增 `test_repo_analyst_parser_accepts_embedded_json_object`
    - 覆盖“前后有普通文本，正文中嵌入 JSON 对象”场景
- 为什么这样改：
  - 防止后续重构把这次修复回退掉
  - 把用户真实故障场景固化成自动化回归测试

### 步骤 47：测试与验证
- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest tests\test_repo_analyst.py`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests\test_repo_analyst.py`
  - `$env:PYTHONPATH='src'; python -m pytest`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest`
- 观察结果：
  - repo analyst 专项测试：
    - base：`8 passed`
    - dl：`8 passed`
  - 全量测试：
    - base：`54 passed, 1 skipped`
    - dl：`61 passed`
- 问题判断：
  - 修复已生效，且未引入回归

### 方案调整记录
- 原方案：
  - parser 只接受“完整字符串即 JSON”的单一路径解析
- 为什么放弃或修改：
  - 真实模型输出常混入前置语句或 markdown fence，单一路径会造成误判失败
- 新方案与原方案区别：
  - 新方案是“多候选 JSON 提取 + 严格 schema 校验”
  - 提高了解析鲁棒性，但不放宽最终结构要求
- 对后续实现影响：
  - Repo Analyst 对真实 LLM 输出更稳定
  - 仍能保持结构化报告的质量门槛

## 当前状态（本次故障修复后）
- 已完成：
  - `invalid_repo_analyst_report` 关键触发路径定位
  - parser 稳健解析改造
  - 真实故障场景回归测试
  - base 与 dl 双环境全量回归通过
- 遗留问题：
  - 如果模型输出“语法正确但字段语义很弱”，仍可能通过（这是 schema 层以外的问题）
- 后续建议：
  - 可选增加“报告质量校验器”（如 summary 长度、modules 最小项数、architecture 关键词命中）

### 步骤 48：用用户真实输出文件做回放验证
- 运行命令：
  - `Get-Content test2_result.txt`
  - `Select-String -Path test2_result.txt -Pattern '"summary"|"modules"|"architecture"|"risks"|"next_steps"'`
  - `@'...python script...'@ | python -`（使用 `parse_repo_analyst_report` 直接回放文件内容）
- 观察结果：
  - `test2_result.txt` 确实包含“前置说明 + ```json 代码块”
  - 但 JSON 体本身语法不合法（缺少标准 key/value 引号与冒号结构），不是纯包装问题
  - 回放结果：`PARSE_FAIL / repo analyst output is not valid JSON`
- 调试中的额外现象：
  - 使用 `conda run -n dl python -c` 传入多行脚本时触发 Conda 限制：`arguments contain newlines`
  - 该问题属于 conda 命令参数限制，不是项目代码问题；改用 `python -` 管道方式即可
- 问题判断：
  - 本次 parser 修复已解决“文本前后包裹导致解析失败”问题
  - 对“JSON 语法本身错误”的输出，当前仍按失败处理（这是设计上的安全边界）
- 接下来准备怎么改：
  - 当前版本保持严格 JSON 语法要求不变
  - 若后续需要提升容错，可增加可选 JSON 修复链路（例如二次模型修复或受控规则修复）

## 2026-04-25 - 默认最大迭代次数调整（8 -> 100）

### 步骤 49：问题确认与影响面检查
- 用户反馈：
  - Web 默认最大迭代是 8，Repo Analyst 在多次工具调用场景下很容易触发 `max_iterations_reached`
- 运行命令：
  - `Get-Content src\code_review_agent\web\index.html`
  - `Get-Content src\code_review_agent\apps\repo_analyst\types.py`
  - `Get-Content src\code_review_agent\apps\repo_analyst\service.py`
  - `Get-Content src\code_review_agent\runtime\service.py`
- 观察结果：
  - 前端 `maxIterations` 输入框是空值 + `placeholder="8"`
  - 后端 `RepoAnalystRequest.max_iterations` 默认是 `None`
  - runtime 默认 `default_max_iterations=8`，当请求未传值时会回落到 8
- 问题判断：
  - 只改前端展示不够，API 直接调用时仍可能回落到 8
- 下一步：
  - 同时修改前端默认值和 RepoAnalystRequest 默认值

### 步骤 50：实施修改
- 修改文件：
  - `src/code_review_agent/web/index.html`
  - `src/code_review_agent/apps/repo_analyst/types.py`
  - `tests/test_repo_analyst.py`
- 具体改动：
  - 前端 `maxIterations` 输入框改为 `value="100"`，并将占位符改为 `placeholder="100"`
  - `RepoAnalystRequest.max_iterations` 从 `int | None = None` 改为 `int = 100`
  - 新增测试 `test_repo_analyst_request_default_max_iterations`，校验默认值确实是 100
- 为什么这样改：
  - 保证 Web 页面默认行为合理
  - 保证 API 调用（即便没传 max_iterations）也能得到一致默认值 100
- 这次修改想解决的问题：
  - 避免常规 Repo 分析任务因默认迭代次数过小被提前中断

### 步骤 51：测试与验证
- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest tests\test_repo_analyst.py`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests\test_repo_analyst.py`
- 观察结果：
  - base：`9 passed`
  - dl：`9 passed`
- 问题判断：
  - 默认值调整生效，且未破坏 repo analyst 相关功能

## 当前状态（默认迭代次数调整后）
- 已完成：
  - Web 默认 max iterations = 100
  - RepoAnalystRequest 默认 max_iterations = 100
  - 对应自动化测试补齐并通过
- 遗留问题：
  - runtime 通用默认仍是 8（这是通用 `/runs` 的默认，不影响 repo-analyst 专用路径）
- 后续建议：
  - 如果你希望全系统统一，也可以把 runtime 通用默认一起改成 100

## 2026-04-25 - 前端页面乱码与结构错位修复

### 步骤 52：问题定位
- 用户现象：
  - 页面打开后中文乱码
  - `textarea` 中出现 `<label>...<input ...>` 这类原始 HTML 片段
- 运行命令：
  - `Get-Content src\code_review_agent\web\index.html`
  - `Select-String -Path src\code_review_agent\web\index.html -Pattern '<textarea|</textarea>|maxIterations|placeholder=' -Context 2,2`
- 观察结果：
  - 文件内容已经出现明显编码污染（文本变成乱码）
  - 表单区域有结构破损迹象，浏览器会把后续标签当普通文本显示在输入区
- 问题判断：
  - 这是 `index.html` 文件本身损坏，不是 API 或浏览器缓存问题
  - 根因是之前对 HTML 的批量替换/写回过程中发生编码与内容污染

### 步骤 53：修复策略与实施
- 原方案：
  - 在损坏文件上局部打补丁
- 为什么放弃：
  - 损坏范围覆盖文案与多个标签，局部补丁风险高且容易留下隐藏问题
- 新方案：
  - 直接重建 `src/code_review_agent/web/index.html` 为干净版本
  - 保留原有功能：
    - 创建 repo analyst run
    - 列表与详情加载
    - 事件展示
    - 自动轮询
    - 默认 `maxIterations=100`
- 修改文件：
  - `src/code_review_agent/web/index.html`
- 这次修改想解决的问题：
  - 恢复页面可用性
  - 清除编码污染和标签结构错误
  - 保证默认最大迭代仍是 100

### 步骤 54：验证
- 运行命令：
  - `Select-String -Path src\code_review_agent\web\index.html -Pattern '<textarea|</textarea>|<label>|</label>|maxIterations|formStatus'`
  - `Invoke-WebRequest http://127.0.0.1:8000/ | Select-Object -ExpandProperty Content`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests\test_api.py`
- 观察结果：
  - HTML 关键结构恢复正常（`textarea`、`label`、`div` 都正确闭合）
  - `/` 返回干净页面源码
  - API 路由测试通过：`7 passed`
- 结论：
  - 本次页面异常已修复

## 当前状态（前端修复后）
- 已完成：
  - 页面乱码与结构错位修复
  - 前端默认最大迭代保持 100
  - API 相关回归测试通过
- 遗留问题：
  - 无直接阻塞项
- 后续建议：
  - 若需要保留中文界面文案，建议后续单独做一轮 UTF-8 文案回填并加静态检查，避免再次出现编码污染

## 2026-04-25 - 页面语言切换（默认中文）

### 步骤 55：需求变更与中断恢复
- 用户新要求：
  - 页面保留中英文切换
  - 默认语言必须是中文，不要默认英文
- 过程说明：
  - 在重构 `index.html` 过程中用户中断并追加新要求
  - 处理策略改为“先恢复文件，再按默认中文实现双语切换”

### 步骤 56：实施改动
- 修改文件：
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - 重建页面文件，修复并保留完整功能链路
  - 新增语言切换控件 `#langSelect`（中文/EN）
  - 新增前端 i18n 字典（`zh`、`en`）
  - 新增 `t(key)` 与 `applyStaticTranslations()`，让静态文案和动态渲染文案统一可切换
  - 状态文案、按钮文案、详情标题、空状态、错误前缀全部接入翻译
  - 默认语言设置为中文：`state.lang = localStorage.getItem("ui_lang") || "zh"`
  - 语言切换后会刷新健康状态、任务列表和详情展示
  - 保持默认最大迭代输入值为 `100`
- 为什么这样改：
  - 满足“默认中文 + 可切换英文”的双目标
  - 避免只翻译静态文本导致动态区仍是单语
- 这次修改想解决的问题：
  - 页面语言能力从单语升级为双语，并明确默认中文

### 步骤 57：验证
- 运行命令：
  - `Select-String -Path src\code_review_agent\web\index.html -Pattern 'localStorage.getItem\("ui_lang"\) \|\| "zh"|id="langSelect"|option value="zh"|option value="en"|langSelect.addEventListener'`
  - `Invoke-WebRequest http://127.0.0.1:8000/ | Select-Object -ExpandProperty Content`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests\test_api.py`
- 观察结果：
  - 默认语言逻辑和切换控件均存在
  - `/` 返回页面源码为最新版本
  - API 路由测试通过：`7 passed`
- 结论：
  - 页面已恢复且默认中文生效，语言切换功能可用

## 当前状态（语言切换阶段）
- 已完成：
  - 默认中文
  - 中英文切换
  - 默认 max iterations=100 保留
  - API 相关回归通过
- 遗留问题：
  - 无阻塞项

## 2026-04-25 - 基础硬化实现（SQLite + API Key + 运行控制）

### 步骤 58：实施前核对与实现边界确认
- 运行命令：
  - `Get-ChildItem src/code_review_agent -Recurse`
  - `Get-Content src/code_review_agent/runtime/store.py`
  - `Get-Content src/code_review_agent/runtime/service.py`
  - `Get-Content src/code_review_agent/api/routes.py`
  - `Get-Content src/code_review_agent/tools/file_tools.py`
  - `Get-Content src/code_review_agent/models/openai_compat.py`
  - `Get-Content src/code_review_agent/storage/__init__.py`
  - `Get-Content src/code_review_agent/observability/__init__.py`
- 观察结果：
  - 运行存储仍是 InMemory，`storage`/`observability` 仍是占位
  - API 无认证，无 workspace 根目录约束
  - runtime 无并发限制和超时控制
- 判断：
  - 风险扫描结果与现状基本一致，可直接进入硬化实现

### 步骤 59：存储层改造（RunStore 抽象 + SQLite）
- 修改文件：
  - `src/code_review_agent/runtime/store.py`
  - `src/code_review_agent/storage/sqlite_store.py`（新增）
  - `src/code_review_agent/storage/__init__.py`
- 具体改动：
  - 新增 `RunStore` 抽象接口（create/get/list/get_events/append/update_status/attach_result/aclose）
  - `InMemoryRunStore` 改为实现异步接口，保留测试/回退用途
  - 新增 `SqliteRunStore`：
    - 使用 SQLAlchemy + aiosqlite
    - 建表 `runs`、`run_events`
    - 支持事件追加、状态更新、结果序列化持久化
    - 支持重启后读取历史 run 与 events
- 为什么这样改：
  - 解决服务重启丢失历史运行数据的问题
  - 让 runtime 可以切换存储实现而不改上层业务代码

### 步骤 60：runtime 硬化（超时/并发/allowlist/日志）
- 修改文件：
  - `src/code_review_agent/runtime/service.py`
  - `src/code_review_agent/runtime/__init__.py`
  - `src/code_review_agent/settings.py`
- 具体改动：
  - `AgentRuntime` 接入异步 store 调用
  - 新增 `WorkspaceValidationError`：创建 run 时校验 `workspace_root`
    - 必须存在
    - 必须是目录
    - 若配置了 `allowed_workspace_root`，必须在该根目录下
  - 新增运行控制：
    - `run_timeout_seconds`（默认 300）
    - `max_concurrent_runs`（默认 4）
    - 并发超限时直接失败并写入 `concurrency_limit_exceeded`
    - 超时时失败并写入 `run_timeout`
  - 新增最小结构化日志：`run_id/status/latency_ms/token_usage/failure_reason`
  - 默认 runtime 现在优先使用 SQLite store（缺少 aiosqlite 时回退 InMemory 并告警）
- 为什么这样改：
  - 让 runtime 从“可演示”过渡到“可持续运行”的最小基线

### 步骤 61：API 安全基线与错误映射
- 修改文件：
  - `src/code_review_agent/api/routes.py`
  - `src/code_review_agent/api/app.py`
- 具体改动：
  - `/runs*` 与 `/repo-analyst*` 增加 API key 校验（`X-API-Key`）
  - `/` 与 `/health` 保持开放
  - 本机回环来源（`127.0.0.1` / `localhost` / `::1` / `testclient`）放行
  - 非本机请求在配置 `API_KEY` 时必须携带正确 key
  - `workspace_root` 校验失败统一返回 400
  - 添加 app shutdown 事件，释放 runtime store 资源
- 为什么这样改：
  - 落地最小可用认证与权限边界，降低文件系统操作暴露风险

### 步骤 62：Repo Analyst 严格解析诊断增强
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/parser.py`
  - `src/code_review_agent/apps/repo_analyst/types.py`
  - `src/code_review_agent/apps/repo_analyst/service.py`
  - `src/code_review_agent/apps/repo_analyst/__init__.py`
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - `RepoAnalystParseError` 增加 `code/message`
    - `missing_final_content`
    - `invalid_json`
    - `schema_validation_failed`
  - `RepoAnalystRunResult` 增加 `parse_diagnostics`
  - 失败原因细分：
    - `invalid_repo_analyst_report_json`
    - `invalid_repo_analyst_report_schema`
  - 前端结果页新增“解析诊断”展示区（显示 code/message）
- 为什么这样改：
  - 保持严格 JSON + schema，不做自动修复
  - 让失败可诊断，不再只有一个泛化错误码

### 步骤 63：配置与文档同步
- 修改文件：
  - `.env.example`
  - `README.md`
- 具体改动：
  - 新增环境变量说明：`API_KEY`、`RUN_TIMEOUT_SECONDS`、`MAX_CONCURRENT_RUNS`
  - README 更新为当前实际行为（认证规则、workspace 约束、Repo Analyst 调用示例）
- 为什么这样改：
  - 避免运行行为和文档不一致

### 步骤 64：测试补齐与调试过程
- 修改文件：
  - `tests/test_runtime.py`
  - `tests/test_api.py`
  - `tests/test_repo_analyst.py`
  - `tests/test_sqlite_store.py`（新增）
- 新增/调整测试覆盖：
  - SQLite store 全路径 + 重启持久化验证
  - API key：本机放行、远端无 key 拦截、错 key 拦截、对 key 放行
  - workspace allowlist 越界拦截
  - runtime 超时失败与并发超限失败
  - repo analyst 解析诊断字段
- 调试记录：
  - 第一次运行（base）命令：
    - `$env:PYTHONPATH='src'; python -m pytest tests/test_runtime.py tests/test_repo_analyst.py tests/test_api.py tests/test_sqlite_store.py`
  - 现象：
    - `ModuleNotFoundError: No module named 'aiosqlite'`（base 环境）
  - 原因判断：
    - base 环境缺少 `aiosqlite`，而 SQLite store 使用 async sqlite 驱动
  - 处理：
    - `tests/test_sqlite_store.py` 增加 `pytest.importorskip("aiosqlite")`
    - `build_default_runtime()` 增加缺依赖时回退 InMemory 的兼容逻辑
  - 第二次运行（dl）现象：
    - `test_sqlite_store_lists_runs_in_reverse_creation_order` 顺序不稳定
  - 原因判断：
    - 两条 run 的 `created_at` 太接近，只有单字段排序时结果不稳定
  - 处理：
    - SQLite 列表排序改为 `created_at desc, id desc`

### 步骤 65：最终验证
- 运行命令：
  - `$env:PYTHONPATH='src'; python -m pytest`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest`
- 结果：
  - base：`58 passed, 2 skipped`
  - dl：`72 passed`
- 结论：
  - 本阶段计划内容已落地并通过回归

## 当前状态（基础硬化阶段）
- 已完成：
  - SQLite 持久化 store（默认接入）
  - API key 认证基线
  - workspace allowlist 约束
  - 运行超时与并发限流
  - repo analyst 严格解析诊断增强
  - 最小结构化运行日志
  - 对应测试覆盖
- 遗留问题：
  - FastAPI `on_event` 存在 deprecation warning（建议后续换 lifespan）
  - 仍未实现 shell 工具/高级沙箱/OTel
- 后续建议：
  - 下一步优先做 lifecycle 迁移（lifespan）和 observability 模块落地

## Phase 1：run_command + 最小 Allowlist 命令沙箱

### 步骤 66：新增命令沙箱与 allowlist 策略
- 修改文件：
  - `src/code_review_agent/sandbox/command.py`
  - `src/code_review_agent/sandbox/__init__.py`
- 具体改动：
  - 新增 `CommandPolicy`、`CommandPolicyError`、`CommandRunResult`。
  - 新增 `run_allowed_command()`，使用 `asyncio.create_subprocess_exec(..., shell=False)` 执行命令。
  - 第一版 allowlist 只允许：
    - `git status`
    - `git status --short`
    - `git diff`
    - `git diff --stat`
    - `git diff --name-only`
    - `git log --oneline`
    - `python -m pytest ...`
  - 默认拒绝 shell/危险程序和明显 shell 组合符号参数。
  - `cwd` 复用 `resolve_workspace_path()`，确保命令工作目录不能逃逸 workspace。
  - 增加超时 kill、stdout/stderr UTF-8 解码、输出截断和结构化执行结果。
- 修改原因：
  - 让 Agent 能运行少量代码审查常用命令，同时避免暴露任意 shell。
- 解决的问题：
  - 补齐工具层中缺少 `run_command` 的能力，为后续 review/debug 模式打基础。

### 步骤 67：新增 run_command 工具并接入默认 registry
- 修改文件：
  - `src/code_review_agent/tools/command_tools.py`
  - `src/code_review_agent/tools/__init__.py`
  - `src/code_review_agent/runtime/service.py`
- 具体改动：
  - 新增 `RunCommandArguments`：
    - `program`
    - `args`
    - `cwd`
    - `timeout_seconds`
    - `max_output_chars`
  - 新增 `RunCommandTool`，将命令执行结果转换为 `ToolExecutionResult`。
  - 被策略拦截、启动失败、超时分别返回 `status="error"`。
  - 命令成功启动后，即使 `exit_code != 0` 也返回 `status="success"`，因为测试失败或 git 非仓库状态属于有效观察结果。
  - 默认工具注册新增 `RunCommandTool()`。
- 修改原因：
  - 保持和现有 `Tool` / `ToolRegistry` / Agent loop 的接口一致，不改 harness 主流程。
- 解决的问题：
  - 模型现在可以通过工具 schema 发现并调用 `run_command`。

### 步骤 68：新增测试覆盖
- 修改文件：
  - `tests/test_command_sandbox.py`
  - `tests/test_run_command_tool.py`
- 具体改动：
  - 覆盖 allowlist 允许路径：
    - readonly git 命令
    - `python -m pytest`
  - 覆盖拦截路径：
    - shell 程序
    - 危险程序
    - 非 allowlist 子命令
    - shell 组合符号
    - `..` 和绝对路径参数
    - `cwd` 越界
  - 用 monkeypatch 模拟 subprocess，覆盖超时、启动失败、非 0 退出码和输出截断，不依赖本机真实 git 状态。
  - 验证默认 registry 已包含 `run_command`。
- 修改原因：
  - 命令执行属于高风险工具，需要优先覆盖策略边界和失败路径。
- 解决的问题：
  - 降低后续扩展 allowlist 时破坏安全边界的风险。

### 步骤 69：第一次测试与循环导入修复
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_command_sandbox.py tests/test_run_command_tool.py tests/test_tool_registry.py`
- 观察结果：
  - 测试收集阶段失败：
    - `ImportError: cannot import name 'CommandPolicyError' from partially initialized module 'code_review_agent.sandbox.command'`
- 问题判断：
  - 新增导入链形成循环：
    - `sandbox.command -> sandbox.path -> tools.base -> tools.__init__ -> command_tools -> sandbox.command`
- 处理方式：
  - 修改 `src/code_review_agent/sandbox/path.py`。
  - 将 `ToolExecutionError` 改为函数内延迟导入，避免模块初始化阶段触发 `tools.__init__`。
- 方案调整：
  - 原方案：`path.py` 顶层导入 `ToolExecutionError`。
  - 调整原因：新增 command tool 后顶层导入触发循环。
  - 新方案：只在需要抛错时延迟导入异常类型。
  - 影响：对外行为不变，导入链更稳。

### 步骤 70：第二次测试与 cwd 错误归一
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_command_sandbox.py tests/test_run_command_tool.py tests/test_tool_registry.py`
- 观察结果：
  - 失败 1 个测试：
    - `test_run_allowed_command_rejects_cwd_escape`
    - 实际抛出 `ToolExecutionError`
    - 测试期望 `CommandPolicyError`
- 问题判断：
  - `cwd` 越界来自文件沙箱，但对命令执行器来说应统一表现为命令策略拒绝。
- 处理方式：
  - 在 `run_allowed_command()` 内捕获 `ToolExecutionError` 并转换为 `CommandPolicyError`。
  - 为避免重新引入循环导入，异常类型仍采用函数内导入。
- 方案调整：
  - 原方案：直接透传 `resolve_workspace_path()` 的异常。
  - 调整原因：命令沙箱对调用方应暴露统一的 policy 错误。
  - 新方案：路径策略失败统一归一为 `CommandPolicyError`。

### 步骤 71：最终验证
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_command_sandbox.py tests/test_run_command_tool.py tests/test_tool_registry.py`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_command_sandbox.py tests/test_run_command_tool.py`
- 观察结果：
  - 本阶段相关测试：`27 passed`
  - 全量回归：`97 passed, 28 warnings`
  - 清理后相关测试：`20 passed`
- 问题判断：
  - warnings 均为既有 FastAPI `on_event` deprecation warning，不是本阶段新增失败。
- 当前结论：
  - `run_command` 工具、最小命令沙箱、默认注册和测试覆盖已完成。

## 当前状态（run_command Phase 1）
- 已完成：
  - `run_command` 工具。
  - 最小 allowlist 命令策略。
  - workspace cwd 限制。
  - 超时控制。
  - 输出截断。
  - 策略错误、启动失败、超时、非 0 退出码的结构化结果。
  - 默认 runtime registry 接入。
  - 对应测试覆盖。
- 遗留问题：
  - 暂不支持任意 shell 字符串。
  - 暂不支持 `npm test`。
  - 暂不做进程树级别 kill。
  - 暂不做 Docker sandbox。
- 后续建议：
  - 下一步可以做 `GET /tools`，让前端/用户能直接查看当前可用工具和 schema。
  - 如果要开放更多命令，建议先做 policy 配置化，而不是直接扩大硬编码 allowlist。

## Review Mode：让“审查最近改动 + 跑测试”走专用路径

### 步骤 72：问题诊断
- 用户反馈：
  - 在前端提问“针对本仓库，审查一下我最近的代码改动，看看有没有问题。检查这个项目的测试是否都能通过。”
  - 但最终表现仍像默认“分析仓库主要功能、模块结构、架构设计、风险点和建议下一步”。
- 只读排查：
  - 检查 `src/code_review_agent/web/index.html`
  - 检查 `src/code_review_agent/apps/repo_analyst/service.py`
  - 检查 `src/code_review_agent/apps/repo_analyst/prompt.py`
  - 读取 `runtime.db` 中最近 run 的 `user_input` 和 `system_prompt`
  - 读取该 run 的 `run_events`，查看实际工具调用
- 观察结果：
  - 前端确实提交了 `question`。
  - 后端也确实把问题写入了 `RunRecord.user_input` 和 system prompt 的 `Task:`。
  - 模型实际尝试调用了 `git log`、`git diff` 和 `python -m pytest`。
  - 多个 git 命令被当前 allowlist 拦截，例如：
    - `git log --oneline -20`
    - `git diff HEAD~5 --stat`
    - `git diff HEAD~3`
  - `python -m pytest` 相关命令可以执行，并返回成功。
- 问题判断：
  - 不是“问题没有传到后端”。
  - 根因有两个：
    - Repo Analyst 的输出 schema 固定为 `summary/modules/architecture/risks/next_steps`，会把任意任务拉回 overview 报告形态。
    - `run_command` 的 git allowlist 太窄，挡住了代码审查需要的 recent diff/log 读取。

### 步骤 73：扩展 readonly git allowlist
- 修改文件：
  - `src/code_review_agent/sandbox/command.py`
  - `tests/test_command_sandbox.py`
- 具体改动：
  - 允许 review 常用只读 git 命令：
    - `git log --oneline -N`
    - `git log --oneline -n N`
    - `git diff HEAD~N`
    - `git diff HEAD~N --stat`
    - `git diff HEAD~N --name-only`
    - `git diff HEAD~N -- <pathspec...>`
  - `N` 限制为 `1..50`。
  - 保持拒绝：
    - `git checkout`
    - `git diff main`
    - `git diff HEAD~99`
    - shell/危险程序/绝对路径/`..`
- 修改原因：
  - 让 review mode 能读取最近改动，同时继续限制在 readonly git 操作内。
- 解决的问题：
  - 模型之前想做 diff 审查但被策略拦截的问题。

### 步骤 74：新增 review mode 的类型、prompt 和解析
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/types.py`
  - `src/code_review_agent/apps/repo_analyst/prompt.py`
  - `src/code_review_agent/apps/repo_analyst/parser.py`
  - `src/code_review_agent/apps/repo_analyst/service.py`
  - `src/code_review_agent/apps/repo_analyst/__init__.py`
- 具体改动：
  - `RepoAnalystRequest` 新增 `mode`：
    - `overview`
    - `review`
  - 新增 review schema：
    - `RepoReviewReport`
    - `RepoReviewFinding`
    - `RepoReviewTestResult`
  - `RepoAnalystRunResult` 新增：
    - `mode`
    - `report_type`
    - `review_report`
  - 新增 `DEFAULT_REPO_REVIEW_QUESTION`。
  - `build_repo_analyst_prompt(..., mode="review")` 改为生成 review 专用 prompt。
  - review prompt 明确要求：
    - 优先 `git status --short`
    - 必要时 `git log --oneline -10`
    - 查看 `git diff --stat` 和 `git diff`
    - 读取相关文件
    - 运行 `python -m pytest`
    - 最终只输出 review JSON
  - parser 保留 overview 解析，同时新增 `parse_repo_review_report()`。
  - service 根据 run 的 system prompt 判断 mode，避免改数据库 schema。
  - review 解析失败时使用：
    - `invalid_repo_review_report_json`
    - `invalid_repo_review_report_schema`
- 修改原因：
  - overview 和 review 是两类不同任务，不应共用一个结构化输出 schema。
- 解决的问题：
  - 用户提出代码审查问题时，最终报告不再被 overview schema 拉回“仓库总体分析”。

### 步骤 75：前端支持模式选择和 review 报告展示
- 修改文件：
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - 表单新增“任务模式”下拉框：
    - 仓库总览
    - 代码审查
  - 提交 payload 新增 `mode`。
  - 中英文翻译表新增 mode 和 review 报告相关文案。
  - 详情页新增 review 报告渲染：
    - 测试结果
    - 改动文件
    - 审查发现
    - 风险
    - 下一步
  - overview 报告保持原展示方式。
- 修改原因：
  - 让用户在 UI 上明确选择任务类型，避免“问题是 review，但结果按 overview 展示”的错配。
- 解决的问题：
  - 前端现在能展示 `review_report`，不再只看 `report`。

### 步骤 76：测试与验证
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_command_sandbox.py tests/test_repo_analyst.py tests/test_api.py`
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
  - `node -e "... new Function(script) ..."`
- 观察结果：
  - 相关测试：`53 passed, 30 warnings`
  - 全量回归：`112 passed, 30 warnings`
  - 前端脚本语法检查：`frontend script syntax ok`
- 问题判断：
  - warnings 仍是既有 FastAPI `on_event` deprecation warning。
  - 本阶段没有新增测试失败。

## 当前状态（Review Mode）
- 已完成：
  - `mode=overview/review`
  - review 专用 prompt
  - review 专用 JSON schema
  - review 专用 parser
  - review API 返回字段
  - 前端模式选择与 review 报告展示
  - readonly git allowlist 扩展
- 遗留问题：
  - mode 目前通过 system prompt 内容判断，未持久化为数据库独立列；短期可用，长期建议把 app 参数结构化存储。
  - review 仍依赖模型自觉调用工具；后续可以在 service 层做预置 evidence collection，再把证据交给模型。
  - git allowlist 仍是硬编码；后续建议配置化。
- 后续建议：
  - 下一步可做 `GET /tools` 和前端工具列表，让用户知道当前 Agent 实际可用能力。
  - 再下一步可以实现 `review` 的自动证据采集流程，减少模型在工具选择上的不稳定性。

## 小清理：删除 runtime/service.py 重复本地导入

### 步骤 77：清理 `DeepSeekModel` 重复导入
- 修改文件：
  - `src/code_review_agent/runtime/service.py`
- 具体改动：
  - 删除 `AgentRuntime.execute_run()` 内部的：
    - `from code_review_agent.models.deepseek import DeepSeekModel`
  - 继续使用文件顶部已有的：
    - `from code_review_agent.models import ChatModel, DeepSeekModel`
- 修改原因：
  - 该本地导入与模块顶部导入重复，增加维护噪音。
  - 当前 `models/__init__.py` 已支持导出 `DeepSeekModel`，无需在函数内部再次导入。
- 解决的问题：
  - 回应 review mode 审计报告中指出的冗余导入问题。

### 步骤 78：测试验证
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_runtime.py tests/test_api.py`
- 观察结果：
  - `20 passed, 30 warnings`
- 问题判断：
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。
  - 删除重复导入没有影响 runtime/API 行为。

## Cancel Step 1：状态与 Runtime 内核

### 步骤 79：扩展 cancelled 状态
- 修改文件：
  - `src/code_review_agent/runtime/types.py`
  - `src/code_review_agent/harness/types.py`
  - `src/code_review_agent/runtime/store.py`
  - `src/code_review_agent/storage/sqlite_store.py`
- 具体改动：
  - `RunStatus` 新增 `cancelled`。
  - `AgentRunStatus` 新增 `cancelled`。
  - InMemory store 和 SQLite store 的 `update_status()` 将 `cancelled` 视为终止态，并写入 `finished_at`。
- 修改原因：
  - cancel 不能只作为 failure_reason，必须进入正式生命周期状态。
- 解决的问题：
  - 为后续 API、前端和事件流提供统一状态基础。

### 步骤 80：实现 Runtime cancel 内核
- 修改文件：
  - `src/code_review_agent/runtime/service.py`
  - `src/code_review_agent/runtime/__init__.py`
- 具体改动：
  - 新增常量：
    - `TERMINAL_RUN_STATUSES`
    - `CANCELLED_BY_USER`
  - 新增异常：
    - `RunAlreadyTerminalError`
  - `AgentRuntime` 新增：
    - `_running_tasks`
    - `_running_tasks_lock`
    - `cancel_run(run_id)`
    - `_register_running_task()`
    - `_unregister_running_task()`
    - `_append_lifecycle_event()`
  - `execute_run()` 开始执行后注册当前 asyncio task。
  - `execute_run()` 如果发现 run 已是终止态，直接返回，不再执行模型。
  - `cancel_run()` 行为：
    - `queued`：写 `run.cancel_requested`，直接更新为 `cancelled`，附加 `AgentRunResult(status="cancelled")`，写 `run.cancelled`。
    - `running`：写 `run.cancel_requested`，找到当前 task 后调用 `task.cancel()`。
    - 终止态：抛出 `RunAlreadyTerminalError`。
  - `execute_run()` 显式捕获 `asyncio.CancelledError`：
    - 附加 cancelled result
    - 更新状态为 `cancelled`
    - 写 `run.cancelled`
    - 记录 runtime summary
    - 返回最新 run
- 修改原因：
  - 需要支持真正中断正在运行的 run，而不是只改状态。
- 解决的问题：
  - queued run 可以取消且不会再执行。
  - running run 可以通过 task cancellation 中断。
  - terminal run 有清晰的拒绝语义。

### 步骤 81：补充 Runtime 单元测试
- 修改文件：
  - `tests/test_runtime.py`
- 具体改动：
  - 新增 `CountingModel`，验证 queued cancel 后不会调用模型。
  - 新增测试：
    - queued run cancel 后状态为 `cancelled`，result 为 `cancelled`，再次 execute 不会运行模型。
    - running run cancel 后 task 被取消，最终状态为 `cancelled`。
    - completed run 再 cancel 会抛出 `RunAlreadyTerminalError`。
  - 验证事件：
    - `run.cancel_requested`
    - `run.cancelled`
- 修改原因：
  - cancel 是生命周期核心能力，必须先用 runtime 测试证明语义正确，再接 API 和前端。
- 解决的问题：
  - 防止后续 API 只调用状态更新而没有真正中断 task。

### 步骤 82：测试验证
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_runtime.py`
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - runtime 单测：`8 passed`
  - 全量回归：`115 passed, 30 warnings`
- 问题判断：
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。
  - `cancelled` 状态扩展没有破坏现有 API、SQLite store、Repo Analyst 或工具测试。

## 当前状态（Cancel Step 1）
- 已完成：
  - `cancelled` 生命周期状态。
  - queued cancel。
  - running task cancel。
  - terminal cancel 拒绝。
  - cancel lifecycle events。
  - runtime 单测覆盖。
- 遗留问题：
  - API cancel endpoint 尚未实现。
  - Repo Analyst cancel facade 尚未实现。
  - `run_command` subprocess cancellation cleanup 尚未实现，这是 Step 2。
  - 前端 Cancel 按钮尚未实现。
- 后续建议：
  - 下一步执行 Step 2：让 `run_allowed_command()` 在 task cancellation 时 kill 子进程并重新抛出 `CancelledError`。

## Cancel Step 2：run_command 子进程取消清理

### 步骤 83：处理 subprocess cancellation
- 修改文件：
  - `src/code_review_agent/sandbox/command.py`
- 具体改动：
  - 在 `run_allowed_command()` 等待 `process.communicate()` 时新增 `asyncio.CancelledError` 分支。
  - 当外部 runtime task 被取消时：
    - 调用 `process.kill()`
    - 调用 `await process.communicate()` 回收子进程输出/状态
    - 重新抛出 `CancelledError`
- 修改原因：
  - Step 1 已经能取消 running run，但如果取消发生在 `run_command` 执行期间，pytest/git 子进程可能继续运行。
- 解决的问题：
  - 防止用户取消 run 后，底层命令进程仍在后台继续跑。

### 步骤 84：补充命令取消测试
- 修改文件：
  - `tests/test_command_sandbox.py`
- 具体改动：
  - 新增 `test_run_allowed_command_kills_process_when_cancelled`。
  - 通过 monkeypatch 模拟一个长时间阻塞在 `communicate()` 的子进程。
  - 创建 `run_allowed_command()` task 后主动 `task.cancel()`。
  - 断言：
    - `asyncio.CancelledError` 会继续向上抛出
    - fake process 的 `kill()` 被调用
    - fake process 被回收并设置 returncode
- 修改原因：
  - cancel 路径不能只靠人工推断，必须验证不会吞掉 cancellation。
- 解决的问题：
  - 确保 `run_command` 和 runtime cancel 语义兼容。

### 步骤 85：测试验证
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_command_sandbox.py`
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_run_command_tool.py tests/test_runtime.py`
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - 命令沙箱测试：`24 passed`
  - run_command + runtime 测试：`14 passed`
  - 全量回归：`116 passed, 30 warnings`
- 问题判断：
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。
  - Step 2 没有破坏 timeout、tool result 或 runtime cancel 语义。

## 当前状态（Cancel Step 2）
- 已完成：
  - `run_command` cancellation cleanup。
  - 子进程 kill + communicate 回收。
  - cancellation 继续向上传播。
  - 对应测试覆盖。
- 遗留问题：
  - API cancel endpoint 尚未实现。
  - Repo Analyst cancel facade 尚未实现。
  - 前端 Cancel 按钮尚未实现。
- 后续建议：
  - 下一步执行 Step 3：补齐 `/runs/{run_id}/cancel` 和 `/repo-analyst/runs/{run_id}/cancel`。

## Cancel Step 3：API + Repo Analyst Service

### 步骤 86：补齐 Repo Analyst cancel facade
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/service.py`
- 具体改动：
  - 新增 `RepoAnalystService.cancel_run(run_id)`。
  - 先通过 runtime 读取 run 并确认 `app_name == "repo_analyst"`。
  - 如果不是 repo analyst run，抛出 `RunNotFoundError`，避免 repo endpoint 取消通用 run。
  - 调用 `runtime.cancel_run(run_id)` 后转换为 app 视角的 `RepoAnalystRunResult`。
- 修改原因：
  - Repo Analyst API 不能直接暴露通用 runtime cancel，否则 app 边界不清晰。
- 解决的问题：
  - 为 `/repo-analyst/runs/{run_id}/cancel` 提供服务层入口。

### 步骤 87：新增 cancel API endpoint
- 修改文件：
  - `src/code_review_agent/api/routes.py`
- 具体改动：
  - 新增：
    - `POST /runs/{run_id}/cancel`
    - `POST /repo-analyst/runs/{run_id}/cancel`
  - API key 校验沿用已有 `_enforce_api_key()`。
  - 错误映射：
    - `RunNotFoundError` -> 404
    - `RunAlreadyTerminalError` -> 409
  - 成功时返回最新 run / repo analyst run 结果。
- 修改原因：
  - Step 1/2 已完成 runtime cancel 和子进程清理，但用户还无法通过 HTTP 调用。
- 解决的问题：
  - 后端入口补齐，外部客户端可以请求取消任务。

### 步骤 88：补充 API 与 Service 测试
- 修改文件：
  - `tests/test_api.py`
  - `tests/test_repo_analyst.py`
- 具体改动：
  - API 测试新增：
    - 通用 queued run cancel 成功。
    - 通用 cancel 后 events 可查询，并包含 `run.cancel_requested` / `run.cancelled`。
    - 通用 missing run cancel 返回 404。
    - 通用 terminal run cancel 返回 409。
    - 远端请求未带 API key 时 cancel 返回 401。
    - Repo Analyst queued run cancel 成功。
    - Repo Analyst cancel 后 events 可查询。
    - Repo Analyst missing run cancel 返回 404。
    - Repo Analyst terminal run cancel 返回 409。
  - Repo Analyst service 测试新增：
    - `cancel_run()` 可取消 queued repo analyst run。
    - `cancel_run()` 拒绝非 repo analyst run。
- 修改原因：
  - cancel API 涉及权限、生命周期和 app 边界，需要覆盖成功路径和错误映射。
- 解决的问题：
  - 确保 HTTP 层不是只改状态，而是调用 runtime/service 的正式 cancel 逻辑。

### 步骤 89：测试验证
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_api.py tests/test_repo_analyst.py`
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - API + Repo Analyst 测试：`39 passed, 44 warnings`
  - 全量回归：`125 passed, 44 warnings`
- 问题判断：
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。
  - Step 3 没有破坏现有 API、Repo Analyst、runtime 或工具行为。

## 当前状态（Cancel Step 3）
- 已完成：
  - 通用 cancel API。
  - Repo Analyst cancel API。
  - Repo Analyst service cancel facade。
  - 404 / 409 / API key 行为覆盖。
  - cancel events 可查询。
- 遗留问题：
  - 前端 Cancel 按钮尚未实现。
  - running run 的 HTTP 端到端取消已由 runtime 单测覆盖，API 侧目前主要覆盖 queued/terminal/missing。
- 后续建议：
  - 下一步执行 Step 4：前端显示 Cancel 按钮，调用 `/repo-analyst/runs/{run_id}/cancel` 并刷新详情。

## Cancel Step 4：前端 Cancel 按钮与状态展示

### 步骤 90：前端详情区接入取消操作
- 修改文件：
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - 在详情页工具栏新增 `cancelRunButton`。
  - 新增 `button.danger` 样式，用于取消任务按钮。
  - 新增 `canCancelRun()` 与 `updateCancelButton()`：
    - 只在 run 状态为 `queued` 或 `running` 时显示取消按钮。
    - 其他状态隐藏取消按钮。
  - 在 `renderDetail()` 中根据当前 run 状态刷新按钮显隐。
  - 在详情加载失败或未选择 run 时隐藏取消按钮。
  - 点击取消按钮后调用：
    - `POST /repo-analyst/runs/{run_id}/cancel`
  - 取消成功后调用 `loadRuns()`，重新刷新 run 列表、当前 run 详情和 events。
  - 取消失败时恢复按钮可点击，并在表单状态区显示失败原因。
- 修改原因：
  - Step 3 已补齐后端 cancel API，但前端还不能直接取消任务。
- 解决的问题：
  - 用户可以在 Web UI 中取消排队中或运行中的 Repo Analyst run。

### 步骤 91：补齐 cancelled 状态与中英文文案
- 修改文件：
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - 新增 `.status-cancelled` 样式。
  - 中英文文案新增：
    - `cancel_run`
    - `cancelling_run`
    - `run_cancelled`
    - `cancel_failed`
    - `status_cancelled`
- 修改原因：
  - Runtime/API 已经引入 `cancelled` 状态，前端需要正确展示。
- 解决的问题：
  - run 列表与详情页能显示“已取消 / Cancelled”，而不是落到未知状态或无样式状态。

### 步骤 92：验证 timeline 与 events 展示
- 修改文件：
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - 没有新增专门的 cancel event 分支。
  - 复用现有 timeline/events 渲染逻辑，直接展示后端返回的：
    - `run.cancel_requested`
    - `run.cancelled`
- 修改原因：
  - timeline 本身按 event 类型通用渲染，取消事件不需要特殊 UI 分支。
- 解决的问题：
  - 点击取消后刷新 events，用户能在 timeline 和原始事件里看到取消链路。

### 步骤 93：测试验证
- 运行命令：
  - `node -e "const fs=require('fs'); const html=fs.readFileSync('src/code_review_agent/web/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); if(!m) throw new Error('script not found'); new Function(m[1]); console.log('frontend script syntax ok');"`
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_api.py tests/test_repo_analyst.py`
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - 前端脚本语法检查：`frontend script syntax ok`
  - API + Repo Analyst 回归：`39 passed, 44 warnings`
  - 全量回归：`125 passed, 44 warnings`
- 问题判断：
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。
  - 本阶段只改前端文件，没有引入新的后端测试失败。

## 当前状态（Cancel Step 4）
- 已完成：
  - 前端 Cancel 按钮。
  - 仅 `queued/running` 可取消。
  - 调用 `/repo-analyst/runs/{run_id}/cancel`。
  - `cancelled` 状态样式与中英文文案。
  - 点击取消后刷新 run 和 events。
  - timeline/events 可展示 cancel events。
  - 前端脚本语法检查与全量测试通过。
- 遗留问题：
  - 目前没有浏览器自动化测试覆盖按钮显隐和点击流程。
  - running run 的真实浏览器取消体验还需要在本地服务启动后手工验证一次。
- 后续建议：
  - 下一步可以启动本地服务，在 UI 上创建一个长任务并取消，确认按钮状态和 timeline 展示符合预期。

## Tools Discovery Phase 1：`GET /tools` 只读发现

### 步骤 94：新增工具发现响应模型
- 修改文件：
  - `src/code_review_agent/tools/discovery.py`
  - `src/code_review_agent/tools/__init__.py`
- 具体改动：
  - 新增 `ToolDescriptor`，作为 API/UI 可消费的工具元数据：
    - `name`
    - `description`
    - `parameters`
    - `enabled`
    - `source`
    - `category`
    - `risk_level`
    - `disabled_reason`
  - 新增内置工具元数据映射：
    - `list_files`: `filesystem` / `low`
    - `read_file`: `filesystem` / `medium`
    - `search_text`: `search` / `medium`
    - `run_command`: `command` / `high`
  - 新增 `describe_tool()` 和 `describe_registry()`。
  - 从 `tools.__init__` 导出 `ToolDescriptor`、`describe_tool`、`describe_registry`。
- 修改原因：
  - `/tools` 不应该只返回裸 schema，还需要告诉前端和用户工具来源、风险等级和启用状态。
- 解决的问题：
  - 让工具能力从“只在模型请求里隐式存在”变成“可以通过 API 显式发现”。

### 步骤 95：新增 `GET /tools`
- 修改文件：
  - `src/code_review_agent/api/routes.py`
- 具体改动：
  - 新增：
    - `GET /tools`
  - 路由行为：
    - 沿用现有 `_enforce_api_key()`。
    - 从 `request.app.state.runtime.tool_registry_factory()` 创建当前 runtime registry。
    - 通过 `describe_registry()` 返回工具列表。
  - 第一版所有当前 registry 中的工具都返回 `enabled=true`。
- 修改原因：
  - 本阶段只做只读发现，不引入启停策略，避免影响已有 Agent loop 和 Repo Analyst 行为。
- 解决的问题：
  - API 客户端和前端可以查询当前 runtime 实际暴露给模型的工具集合。

### 步骤 96：补充 API 测试
- 修改文件：
  - `tests/test_api.py`
- 具体改动：
  - 新增测试：
    - `GET /tools` 返回四个默认内置工具。
    - 工具 metadata 正确：
      - `list_files` 为 low/filesystem。
      - `read_file` 为 medium/filesystem。
      - `search_text` 为 medium/search。
      - `run_command` 为 high/command。
    - API 返回的 `name/description/parameters` 与 `ToolRegistry.get_model_schemas()` 一致。
    - 远程请求无 API key 时返回 401。
    - 远程请求带正确 API key 时返回 200。
- 修改原因：
  - 工具发现接口会被前端和用户用来判断 runtime 能力，需要保证 schema 和实际模型可见 schema 不分叉。
- 解决的问题：
  - 防止后续修改工具 schema 时 `/tools` 和模型调用 schema 不一致。

### 步骤 97：测试与调试记录
- 运行命令：
  - `rg "build_default_tool_registry|ToolDiscovery|/tools" -n src tests`
- 观察结果：
  - Windows 环境中 `rg.exe` 执行失败：
    - `Access is denied`
- 问题判断：
  - 这是本机 ripgrep 执行权限问题，不是项目测试失败。
- 接下来处理：
  - 改用 PowerShell `Get-Content` / `Select-String` 读取和搜索文件。

- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_api.py`
- 观察结果：
  - `26 passed, 52 warnings`
- 问题判断：
  - `/tools` API 测试通过。
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。

- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - `129 passed, 52 warnings`
- 问题判断：
  - 本阶段没有破坏 runtime、Repo Analyst、工具系统或前端相关测试。

## 当前状态（Tools Discovery Phase 1）
- 已完成：
  - `GET /tools`。
  - 工具只读发现响应模型。
  - 默认内置工具 metadata。
  - schema 与 `ToolRegistry.get_model_schemas()` 一致性测试。
  - API key 行为测试。
- 遗留问题：
  - 还没有工具启停策略，当前返回的已注册工具全部是 `enabled=true`。
  - 前端还没有展示工具列表。
  - `disabled_reason` 字段已预留，但本阶段不会产生非空值。
- 后续建议：
  - 下一步做 `.env` 级别的 `ENABLED_TOOLS` 静态启停。
  - 再下一步把 Repo Analyst 的 `overview/review` mode 与默认工具集绑定。

## Tools Discovery Phase 2：`.env` 级别 `ENABLED_TOOLS` 静态启停

### 步骤 98：Settings 支持 `ENABLED_TOOLS`
- 修改文件：
  - `src/code_review_agent/settings.py`
  - `tests/test_settings.py`
- 具体改动：
  - 新增 `_parse_csv_env()`，解析逗号分隔环境变量。
  - `Settings` 新增：
    - `enabled_tools: tuple[str, ...] | None`
  - `get_settings()` 读取：
    - `ENABLED_TOOLS`
  - 语义：
    - 未设置 `ENABLED_TOOLS`：返回 `None`，表示启用所有内置工具。
    - 设置为空字符串：返回 `()`，表示不启用任何工具。
    - 设置逗号分隔列表：返回工具名 tuple。
  - 测试覆盖：
    - `.env` 中 `ENABLED_TOOLS=list_files, read_file,run_command` 可解析。
    - `ENABLED_TOOLS=""` 表示空工具集。
- 修改原因：
  - 工具启停应先由后端配置控制，而不是立即暴露前端动态开关。
- 解决的问题：
  - 为不同部署环境提供最小可控的工具暴露策略。

### 步骤 99：默认工具 registry 按配置注册工具
- 修改文件：
  - `src/code_review_agent/runtime/service.py`
  - `src/code_review_agent/runtime/__init__.py`
  - `tests/test_tool_registry.py`
- 具体改动：
  - 新增 `BUILTIN_TOOL_FACTORIES`，统一维护内置工具工厂：
    - `list_files`
    - `read_file`
    - `search_text`
    - `run_command`
  - 新增 `_resolve_enabled_tool_names()`：
    - 未配置时返回所有内置工具。
    - 配置为空时返回空集合。
    - 配置未知工具名时抛出 `ValueError("unknown enabled tools: ...")`。
  - `build_default_tool_registry(enabled_tools=None)` 改为只注册启用工具。
  - `build_default_runtime()` 在启动时解析一次 `enabled_tools`，并用闭包固定本次 runtime 的工具策略。
  - 导出 `build_default_tool_descriptors()`。
  - 测试覆盖：
    - `build_default_tool_registry(("list_files", "read_file"))` 只注册这两个工具。
    - 环境变量 `ENABLED_TOOLS=list_files,search_text` 会影响默认 registry。
    - 未知工具名会被拒绝。
- 修改原因：
  - disabled 工具不能只在 UI 上标记禁用，还必须从 runtime registry 中移除，避免进入模型可见 schema。
- 解决的问题：
  - 模型请求中的 `tools` 列表现在会严格受 `ENABLED_TOOLS` 控制。

### 步骤 100：`/tools` 显示 disabled 工具与原因
- 修改文件：
  - `src/code_review_agent/runtime/service.py`
  - `src/code_review_agent/api/routes.py`
  - `tests/test_api.py`
- 具体改动：
  - `AgentRuntime` 新增 `tool_discovery_factory` 和 `list_tools()`。
  - 默认 runtime 的 `tool_discovery_factory` 使用 `build_default_tool_descriptors(enabled_tools)`。
  - `build_default_tool_descriptors()` 返回所有内置工具：
    - 启用工具：`enabled=true`, `disabled_reason=null`
    - 禁用工具：`enabled=false`, `disabled_reason="not_in_enabled_tools"`
  - `/tools` 改为调用 `runtime.list_tools()`，而不是直接描述当前 registry。
  - 测试覆盖：
    - 当启用 `list_files/read_file` 时，`search_text/run_command` 仍出现在 `/tools`，但 `enabled=false`。
    - disabled 工具有 `disabled_reason="not_in_enabled_tools"`。
- 修改原因：
  - `GET /tools` 既要反映模型可见工具，也要解释哪些内置工具因配置被关闭。
- 解决的问题：
  - UI/用户可以知道工具被禁用，而不是误以为系统没有这个工具能力。

### 步骤 101：验证 disabled 工具不进入模型 schema
- 修改文件：
  - `tests/test_runtime.py`
- 具体改动：
  - 新增 `RecordingModel`，记录模型请求中的 `request.tools`。
  - 新增测试：
    - runtime 使用 `build_default_tool_registry(("list_files",))`。
    - 执行 run 后断言模型只看到 `list_files` 一个工具。
  - 新增测试：
    - `ENABLED_TOOLS=missing_tool` 时，`build_default_runtime()` 直接抛出 `ValueError`。
- 修改原因：
  - 本阶段的关键安全语义是 disabled 工具不能被模型调用。
- 解决的问题：
  - 用测试证明禁用工具不会出现在 `ChatRequest.tools` 中。

### 步骤 102：补充配置文档
- 修改文件：
  - `.env.example`
  - `README.md`
- 具体改动：
  - `.env.example` 新增：
    - `ENABLED_TOOLS=list_files,read_file,search_text,run_command`
  - README 的 `.env` 示例新增 `ENABLED_TOOLS`。
  - README API notes 新增：
    - 未设置则启用所有内置工具。
    - 设置逗号分隔列表则只暴露指定工具。
    - 设置为空则禁用全部工具。
    - `GET /tools` 可查看 schema、风险等级和启用状态。
- 修改原因：
  - 静态启停是运维配置，如果只写代码不写示例，后续使用时容易误配。
- 解决的问题：
  - 用户可以直接在 `.env` 中找到工具启停的配置入口。

### 步骤 103：测试验证
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_settings.py tests/test_tool_registry.py tests/test_runtime.py tests/test_api.py`
- 观察结果：
  - `48 passed, 54 warnings`
- 问题判断：
  - 针对性测试通过。
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。

- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - 第一次全量：`136 passed, 54 warnings`
  - 补充启动时未知工具校验后再次全量：`137 passed, 54 warnings`
- 问题判断：
  - 本阶段没有破坏现有 runtime、Repo Analyst、tools、SQLite 或 API 行为。

## 当前状态（Tools Discovery Phase 2）
- 已完成：
  - `.env` / 环境变量 `ENABLED_TOOLS`。
  - 默认 registry 按启用列表注册工具。
  - `/tools` 显示所有内置工具及启用状态。
  - disabled 工具显示 `disabled_reason="not_in_enabled_tools"`。
  - disabled 工具不会进入模型可见 schema。
  - 未知工具配置启动时失败。
  - README 与 `.env.example` 已补充配置说明。
- 遗留问题：
  - 工具策略仍是全局静态配置，尚未按 Repo Analyst 的 `overview/review` mode 区分。
  - 前端还没有展示 `/tools` 列表，也没有工具开关 UI。
  - 当前没有把每次 run 实际使用的工具集持久化到 `RunRecord`。
- 后续建议：
  - 下一步做 Repo Analyst mode 默认工具策略：
    - `overview` 默认不开 `run_command`
    - `review` 默认开启 `run_command`
  - 再之后再考虑前端工具列表和每次 run 的工具覆盖配置。

## Tools Policy Phase 3：按 App/Mode 固化工具策略

### 步骤 104：RunRecord 增加 `tool_names` 快照
- 修改文件：
  - `src/code_review_agent/runtime/types.py`
  - `src/code_review_agent/runtime/service.py`
- 具体改动：
  - `RunRecord` 新增：
    - `tool_names: list[str] | None`
  - `CreateRunRequest` 新增：
    - `tool_names: list[str] | None`
  - `AgentRuntime.create_run()` 创建 run 时解析最终工具列表并写入 `RunRecord.tool_names`。
  - 未显式传 `tool_names` 时，使用当前 runtime 的 enabled tools 作为本次 run 的快照。
  - 显式传 `tool_names` 时：
    - 去重并保持顺序。
    - 如果包含未知或 disabled 工具，抛出 `WorkspaceValidationError`。
- 修改原因：
  - 工具策略不能只依赖运行时当前环境变量，否则历史 run 无法复盘。
  - 每次 run 需要记录“当时实际允许模型看到哪些工具”。
- 解决的问题：
  - 后续修改 `.env` 不会影响已创建 run 的工具解释。

### 步骤 105：执行时按 `tool_names` 过滤 registry
- 修改文件：
  - `src/code_review_agent/runtime/service.py`
  - `tests/test_runtime.py`
- 具体改动：
  - 新增 `_filter_tool_registry(registry, tool_names)`。
  - `AgentRuntime.execute_run()` 创建 registry 后，如果 run 有 `tool_names`，则只保留这些工具。
  - 新增 `RecordingModel` 测试模型，记录 `ChatRequest.tools`。
  - 新增测试验证：
    - `tool_names=["list_files"]` 时，模型只看到 `list_files`。
    - 尝试创建包含 disabled 工具的 run 会被拒绝。
- 修改原因：
  - 只在 `/tools` 显示 disabled 不够，关键是 disabled 工具不能进入模型可见 schema。
- 解决的问题：
  - 从执行链路上保证工具权限策略生效。

### 步骤 106：SQLite 持久化 `tool_names`
- 修改文件：
  - `src/code_review_agent/storage/sqlite_store.py`
  - `tests/test_sqlite_store.py`
- 具体改动：
  - `runs` 表新增 `tool_names_json`。
  - `create_run()` 将 `RunRecord.tool_names` 序列化为 JSON。
  - `_row_to_run_record()` 反序列化回 `tool_names`。
  - `_ensure_initialized()` 增加轻量迁移：
    - 如果已有 SQLite 数据库缺少 `tool_names_json` 列，则执行 `ALTER TABLE runs ADD COLUMN tool_names_json TEXT`。
  - SQLite 测试覆盖 tool_names 持久化读取。
- 修改原因：
  - 当前是开发阶段，但 runtime 已经支持 SQLite 历史查询，新增 run 字段不能只支持新库。
- 解决的问题：
  - 旧 `runtime.db` 不删除也能自动补列。

### 步骤 107：Repo Analyst 按 mode 生成工具策略
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/service.py`
  - `src/code_review_agent/apps/repo_analyst/types.py`
  - `tests/test_repo_analyst.py`
- 具体改动：
  - 新增 mode 默认工具集：
    - `overview`: `list_files`, `read_file`, `search_text`
    - `review`: `list_files`, `read_file`, `search_text`, `run_command`
  - `RepoAnalystService.create_run()` 根据 mode 传入 `CreateRunRequest.tool_names`。
  - 策略会和全局 enabled tools 取交集：
    - 如果全局禁用了 `run_command`，review mode 也不会拿到 `run_command`。
  - `RepoAnalystRunResult` 新增 `tool_names`。
  - 为测试/嵌入场景保留 fallback：
    - 如果 runtime 使用的是非内置自定义工具，例如测试中的 `echo`，则保留 runtime 当前 enabled 工具，避免专用 app 测试被内置工具策略误伤。
  - 新增测试：
    - overview run 的模型请求不包含 `run_command`。
    - review run 的模型请求包含 `run_command`。
    - review 会尊重全局 disabled 工具。
- 修改原因：
  - 仓库总览默认不应拥有命令执行能力；代码审查模式才需要 `python -m pytest` / git 只读命令。
- 解决的问题：
  - 不同 app/mode 的工具权限变得可解释、可复盘、可测试。

### 步骤 108：API 与前端展示本次启用工具
- 修改文件：
  - `tests/test_api.py`
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - API 测试新增：
    - `GET /repo-analyst/runs/{id}` 返回 `tool_names`。
  - 前端详情页新增：
    - “本次启用工具 / Enabled Tools”
  - 如果工具列表为空，显示：
    - “未启用工具。/ No tools enabled.”
- 修改原因：
  - 用户需要在 run 详情中看到这次 Agent 实际拥有的工具权限。
- 解决的问题：
  - 从 UI 到 API 都能复盘 mode 工具策略。

### 步骤 109：测试与调试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_runtime.py tests/test_repo_analyst.py tests/test_api.py tests/test_sqlite_store.py`
  - `node -e "const fs=require('fs'); const html=fs.readFileSync('src/code_review_agent/web/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); if(!m) throw new Error('script not found'); new Function(m[1]); console.log('frontend script syntax ok');"`
- 观察结果：
  - 相关测试：`61 passed, 56 warnings`
  - 前端脚本语法检查：`frontend script syntax ok`
- 问题判断：
  - mode 工具策略、SQLite 持久化、API 返回和前端脚本均通过验证。
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。

- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - `142 passed, 56 warnings`
- 问题判断：
  - 全量回归通过。

- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m ruff check src/code_review_agent/runtime/service.py src/code_review_agent/apps/repo_analyst/service.py src/code_review_agent/storage/sqlite_store.py src/code_review_agent/web/index.html tests/test_runtime.py tests/test_repo_analyst.py tests/test_api.py tests/test_sqlite_store.py`
- 观察结果：
  - 失败：
    - `No module named ruff`
- 问题判断：
  - 当前 `dl` 环境未安装 ruff，不是代码执行失败。
- 接下来处理：
  - 不安装新依赖；以 pytest 和前端脚本语法检查作为本阶段验证。

## 当前状态（Tools Policy Phase 3）
- 已完成：
  - `RunRecord.tool_names`。
  - `CreateRunRequest.tool_names`。
  - run 创建时写入工具快照。
  - run 执行时按工具快照过滤 registry。
  - SQLite 持久化与旧库自动补列。
  - Repo Analyst overview/review mode 默认工具策略。
  - `GET /repo-analyst/runs/{id}` 返回本次工具集。
  - 前端详情页展示本次启用工具。
- 遗留问题：
  - 通用 `/runs` 目前使用全局 enabled tools 快照，没有按 app 进一步细分。
  - 前端仍没有创建 run 时的手动工具开关。
  - `GET /tools` 还没有在前端形成工具列表面板。
- 后续建议：
  - 下一步做前端工具列表展示，读取 `GET /tools`，让用户能看到全局工具状态。
  - 再下一步做前端 per-run 工具覆盖配置，但需要明确是否允许用户覆盖 mode 默认策略。

## Tools Policy Phase 4：前端工具权限面板与 per-run 覆盖

### 步骤 110：Repo Analyst 请求支持 `enabled_tools`
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/types.py`
  - `src/code_review_agent/apps/repo_analyst/service.py`
- 具体改动：
  - `RepoAnalystRequest` 新增：
    - `enabled_tools: list[str] | None`
  - `RepoAnalystService.create_run()` 将 `enabled_tools` 传入工具策略解析。
  - `_resolve_tool_names()` 支持两种路径：
    - 未传 `enabled_tools`：继续使用 mode 默认工具策略。
    - 传入 `enabled_tools`：作为本次 run 的工具覆盖列表。
  - 覆盖列表会去重并保留顺序。
- 修改原因：
  - 前端需要允许用户在创建任务时手动关闭或调整工具权限。
- 解决的问题：
  - 工具策略不再只能由 mode 决定，可以按单次 run 覆盖。

### 步骤 111：后端校验 unknown / disabled 工具
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/service.py`
  - `tests/test_repo_analyst.py`
  - `tests/test_api.py`
- 具体改动：
  - 显式 `enabled_tools` 只允许选择 `source="builtin"` 的工具。
  - 如果包含未知工具，抛出 `WorkspaceValidationError`：
    - `enabled_tools include unknown tools: ...`
  - 如果包含全局 disabled 工具，抛出 `WorkspaceValidationError`：
    - `enabled_tools include disabled tools: ...`
  - API 层沿用已有 `WorkspaceValidationError -> HTTP 400` 映射。
  - 新增测试：
    - service 拒绝未知工具。
    - service 拒绝全局禁用工具。
    - API 拒绝未知工具。
    - API 拒绝全局禁用工具。
    - 传入合法 `enabled_tools` 后，`tool_names` 只包含用户选择的工具。
- 修改原因：
  - 前端只是便利入口，后端必须是最终权限边界。
- 解决的问题：
  - 用户不能通过 payload 绕过全局 `ENABLED_TOOLS` 或调用不存在的工具。

### 步骤 112：前端新增工具权限折叠面板
- 修改文件：
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - 创建任务表单新增“工具权限 / Tool Permissions”折叠区域。
  - 前端启动时调用：
    - `GET /tools`
  - 面板展示：
    - 工具名
    - 描述
    - 风险等级
    - 是否启用
    - disabled reason
  - 对高风险工具使用红色 `risk-high` 标记。
  - 全局 disabled 工具 checkbox 不可勾选，并显示禁用原因。
- 修改原因：
  - 用户需要在创建 run 前看到当前 runtime 的工具能力和风险等级。
- 解决的问题：
  - `/tools` 不再只是 API 能力，前端也能直接呈现工具状态。

### 步骤 113：前端按 mode 自动选择默认工具并提交覆盖
- 修改文件：
  - `src/code_review_agent/web/index.html`
- 具体改动：
  - 前端维护：
    - `state.tools`
    - `state.selectedToolNames`
  - 默认选择策略：
    - `overview`: `list_files`, `read_file`, `search_text`
    - `review`: `list_files`, `read_file`, `search_text`, `run_command`
  - 默认选择会和 `/tools` 返回的 enabled 状态取交集。
  - 切换 mode 时重新应用默认选择。
  - 用户可以手动勾选/取消已启用工具。
  - 提交时：
    - 如果 `/tools` 成功加载，则提交 `enabled_tools`。
    - 如果 `/tools` 加载失败，则不提交 `enabled_tools`，避免误把空数组当成“用户主动禁用全部工具”。
- 修改原因：
  - 需要同时满足 mode 默认策略和用户手动关闭工具的需求。
- 解决的问题：
  - 用户现在可以创建一个 review run，但手动关闭 `run_command`。

### 步骤 114：测试与调试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_repo_analyst.py tests/test_api.py`
  - `node -e "const fs=require('fs'); const html=fs.readFileSync('src/code_review_agent/web/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); if(!m) throw new Error('script not found'); new Function(m[1]); console.log('frontend script syntax ok');"`
- 观察结果：
  - Repo Analyst + API：`54 passed, 62 warnings`
  - 前端脚本语法检查：`frontend script syntax ok`
- 问题判断：
  - 后端校验、API 映射、显式工具覆盖和前端脚本语法都通过。
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。

- 方案微调：
  - 原方案：无论 `/tools` 是否加载成功，提交时都发送 `enabled_tools`。
  - 调整原因：如果 `/tools` 加载失败，`state.selectedToolNames` 为空，可能被误解释为“用户主动禁用全部工具”。
  - 新方案：只有 `state.tools.length > 0` 时才提交 `enabled_tools`。
  - 影响：工具列表加载失败时后端继续使用 mode 默认策略，而不是空工具集。

- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - `148 passed, 62 warnings`
- 问题判断：
  - 全量回归通过。

## 当前状态（Tools Policy Phase 4）
- 已完成：
  - `RepoAnalystRequest.enabled_tools`。
  - 后端 unknown / disabled 工具校验。
  - API 400 测试。
  - per-run 工具覆盖。
  - 前端工具权限折叠面板。
  - 前端按 mode 自动勾选默认工具。
  - 前端提交 `enabled_tools`。
  - 高风险工具视觉标记。
  - disabled reason 展示。
- 遗留问题：
  - 还没有浏览器自动化测试覆盖 checkbox 交互。
  - 前端目前只在创建 Repo Analyst run 时支持工具覆盖，通用 `/runs` 还没有对应 UI。
  - 工具 schema 还没有在面板中展开展示。
- 后续建议：
  - 下一步可以用浏览器手工验证：
    - overview 默认不勾选 `run_command`
    - review 默认勾选 `run_command`
    - 手动取消 `run_command` 后创建 review run，详情里的“本次启用工具”不包含 `run_command`
  - 后续再做工具 schema 展开视图或 per-run 工具选择持久化展示优化。

## Provider Phase 1：Provider 字段与 DeepSeek-only Registry

### 步骤 115：Settings 增加默认 provider
- 修改文件：
  - `src/code_review_agent/settings.py`
  - `.env.example`
  - `README.md`
  - `tests/test_settings.py`
- 具体改动：
  - `Settings` 新增：
    - `default_provider: str = "deepseek"`
  - `get_settings()` 读取：
    - `DEFAULT_PROVIDER`
  - `.env.example` 与 README 示例新增：
    - `DEFAULT_PROVIDER=deepseek`
  - README 说明当前支持的 provider 仍是 `deepseek`，并且 provider 会按 run 持久化。
- 修改原因：
  - 后续要支持多 provider，需要先把“默认模型提供方”从模型名中拆出来。
- 解决的问题：
  - `DEFAULT_MODEL` 不再隐含 provider 语义。

### 步骤 116：新增模型 provider registry
- 修改文件：
  - `src/code_review_agent/models/registry.py`
  - `src/code_review_agent/models/__init__.py`
  - `tests/test_model_registry.py`
- 具体改动：
  - 新增 `ModelProviderDescriptor`。
  - 新增：
    - `SUPPORTED_PROVIDERS = {"deepseek"}`
    - `normalize_provider(provider)`
    - `create_model(provider, model_name)`
    - `list_model_providers()`
  - `create_model()` 当前只支持 DeepSeek，但入口已经是 provider-neutral。
  - `list_model_providers()` 返回 DeepSeek provider 元数据，不泄露 API key。
  - `models.__init__` 导出 registry 相关函数和类型。
  - 测试覆盖：
    - 默认 provider 解析。
    - provider 大小写归一。
    - unknown provider 报 `ModelConfigurationError`。
    - `create_model("deepseek")` 创建 `DeepSeekModel`。
    - provider descriptor 不泄露 API key。
- 修改原因：
  - runtime 不应直接依赖 `DeepSeekModel`，否则后续接 SiliconFlow/OpenRouter 会继续污染 runtime。
- 解决的问题：
  - 建立 `runtime -> model registry -> provider-specific model` 的创建路径。

### 步骤 117：RunRecord / CreateRunRequest 增加 provider 快照
- 修改文件：
  - `src/code_review_agent/runtime/types.py`
  - `src/code_review_agent/runtime/service.py`
  - `tests/test_runtime.py`
- 具体改动：
  - `RunRecord` 新增：
    - `provider: str | None`
  - `CreateRunRequest` 新增：
    - `provider: str | None`
  - `AgentRuntime.create_run()` 创建 run 时解析并写入 provider：
    - 未传 provider 时使用 runtime 默认 provider。
    - 传 unknown provider 时抛出 `WorkspaceValidationError`。
  - `AgentRuntime.execute_run()` 改为通过 `_create_model(run.provider, run.model)` 创建模型。
  - 默认 runtime 使用：
    - `model_factory=create_model`
  - 为兼容现有测试和嵌入用法，`AgentRuntime._create_model()` 保留 no-arg `model_factory` fallback。
  - 测试覆盖：
    - 默认 run provider 为 `deepseek`。
    - 显式 provider/model 会写入 run。
    - unknown provider 会被拒绝。
- 修改原因：
  - provider 必须成为 run 生命周期的一部分，而不是执行阶段临时推断。
- 解决的问题：
  - 历史 run 可复盘当时使用的 provider。

### 步骤 118：SQLite 持久化 provider
- 修改文件：
  - `src/code_review_agent/storage/sqlite_store.py`
  - `tests/test_sqlite_store.py`
- 具体改动：
  - `runs` 表新增 nullable `provider` 列。
  - `_ensure_run_columns()` 自动迁移旧 SQLite 数据库：
    - 如果缺少 `provider` 列，执行 `ALTER TABLE runs ADD COLUMN provider VARCHAR`。
  - `create_run()` 写入 provider。
  - `_row_to_run_record()` 读取 provider。
  - SQLite 测试覆盖 provider/model/tool_names 一并持久化。
- 修改原因：
  - 当前系统已经使用 SQLite 保存历史 run，provider 字段也必须持久化。
- 解决的问题：
  - 服务重启后仍能查询 run 使用的 provider。

### 步骤 119：Repo Analyst 和前端贯通 provider
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/types.py`
  - `src/code_review_agent/apps/repo_analyst/service.py`
  - `src/code_review_agent/api/routes.py`
  - `src/code_review_agent/web/index.html`
  - `tests/test_repo_analyst.py`
  - `tests/test_api.py`
- 具体改动：
  - `RepoAnalystRequest` 新增：
    - `provider`
  - `RepoAnalystRunResult` 新增：
    - `provider`
    - `model`
  - `RepoAnalystService.create_run()` 将 provider 传给 `CreateRunRequest`。
  - `_to_app_result()` 返回 run 的 provider/model。
  - `/debug/runtime-config` 增加 `default_provider`。
  - 前端新增 provider 下拉框：
    - 当前只有 `DeepSeek`
  - 前端创建 run 时提交：
    - `provider`
    - `model`
  - 前端详情页显示：
    - `Provider / model`
  - API 测试覆盖：
    - debug config 返回 `default_provider`。
    - repo analyst run 返回 provider/model。
    - unknown provider 返回 400。
- 修改原因：
  - 即使 Phase 1 只支持 DeepSeek，也要把 API/UI 的形状提前调整成 provider-aware。
- 解决的问题：
  - 后续添加 SiliconFlow 时，不需要再重塑 run 请求和前端 payload。

### 步骤 120：测试与调试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_model_registry.py tests/test_settings.py tests/test_runtime.py tests/test_sqlite_store.py tests/test_repo_analyst.py tests/test_api.py`
  - `node -e "const fs=require('fs'); const html=fs.readFileSync('src/code_review_agent/web/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); if(!m) throw new Error('script not found'); new Function(m[1]); console.log('frontend script syntax ok');"`
- 观察结果：
  - 前端脚本语法检查：`frontend script syntax ok`
  - 相关测试第一次运行失败 1 个：
    - `test_runtime_rejects_unknown_provider`
    - 失败原因：补测试时把 `unknown enabled tools` 的断言误放进了 unknown provider 测试，导致断言依赖的环境变量上下文不成立。
- 问题判断：
  - 这是测试代码组织错误，不是 runtime/provider 行为错误。
- 处理方式：
  - 将 `build_default_runtime()` 对 unknown enabled tool 的断言移回 `test_default_runtime_rejects_unknown_enabled_tool()`。

- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest tests/test_model_registry.py tests/test_settings.py tests/test_runtime.py tests/test_sqlite_store.py tests/test_repo_analyst.py tests/test_api.py`
- 观察结果：
  - `76 passed, 64 warnings`
- 问题判断：
  - provider registry、持久化、API/Repo Analyst 和前端脚本相关验证通过。

- 运行命令：
  - `$env:PYTHONPATH='src'; D:\Anaconda\envs\dl\python.exe -m pytest`
- 观察结果：
  - `155 passed, 64 warnings`
- 问题判断：
  - 全量回归通过。
  - warnings 仍为既有 FastAPI `on_event` deprecation warning。

## 当前状态（Provider Phase 1）
- 已完成：
  - `DEFAULT_PROVIDER`。
  - `models/registry.py`。
  - DeepSeek-only provider registry。
  - `CreateRunRequest.provider`。
  - `RunRecord.provider`。
  - SQLite provider 持久化与旧库补列。
  - `RepoAnalystRequest.provider`。
  - `RepoAnalystRunResult.provider/model`。
  - 前端 provider 下拉框与详情展示。
  - unknown provider 400。
- 遗留问题：
  - 真实可用 provider 仍只有 DeepSeek。
  - 还没有 `GET /models/providers`。
  - 前端 provider/model 还不是动态联动，只是先固定 DeepSeek。
- 后续建议：
  - 下一步做 Provider Phase 2：新增 `SiliconFlowModel`，复用 OpenAI-compatible adapter。
  - 再下一步做 `GET /models/providers` 和前端动态 provider/model 列表。
