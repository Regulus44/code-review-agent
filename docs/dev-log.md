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
