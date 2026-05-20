# Code Review Agent

[English README](README.md)

Code Review Agent 是一个面向代码仓库分析和代码审查的小型 Agent Runtime。它把模型接入、工具调用、工作区安全边界、持久化 Session、运行事件、诊断信息和 Web UI 组织成一个本地优先、可部署的服务。

这个项目的重点不是简单地“用 LLM 调工具”，而是展示一个较完整的运行系统：它提供 Agent-as-a-Service API，用 SQLite 持久化运行和会话历史，记录模型/工具事件，并在通用 Runtime 之上实现了一个仓库分析应用。

## 当前能力

- Provider-neutral 的 ChatModel 接口。
- DeepSeek、SiliconFlow、MiMo 的 OpenAI-compatible adapter。
- ReAct 风格 Agent loop，支持工具调用。
- ToolRegistry，支持工具 schema 导出和按 run 过滤工具。
- 内置仓库工具：
  - `list_files`
  - `read_file`
  - `search_text`
  - `run_command`
- 最小命令沙箱：
  - 工作目录限制在 workspace 内
  - 命令 allowlist
  - 超时控制
  - 输出截断
  - 不执行任意 shell 字符串
- ContextManager，用于大工具历史和 prompt 体积控制。
- Agent loop 内置连续工具失败熔断。
- Runtime 生命周期：
  - queued
  - running
  - completed
  - failed
  - cancelled
  - max_iterations
  - model_output_truncated
- SQLite 持久化 run、event、session、turn 和 message。
- Runtime events、turn events 和 diagnostics，可用于可观测性。
- 持续多轮 Session。
- Repo Analyst 应用，支持结构化仓库总览和代码审查报告。
- FastAPI 服务。
- 内置单页 Web UI。

## 架构

```text
FastAPI / Web UI
        |
        v
Runtime services
  - AgentRuntime
  - SessionService
  - RepoAnalystService
        |
        v
Agent harness
  - Agent loop
  - Context manager
  - Session history
        |
        +------------------+
        |                  |
        v                  v
Model providers        Tool registry
  - DeepSeek             - list_files
  - SiliconFlow          - read_file
  - MiMo                 - search_text
                         - run_command
```

Runtime 本身不绑定具体应用。Repo Analyst 是构建在通用 Runtime 之上的一个 app facade。Session API 则复用同一套 Agent loop，用于持续、对话式的仓库工作流。

## 安装

要求：

- Python 3.10+
- 至少配置一个模型 provider 的 API key
- 可选：安装 `ripgrep` 以加速 `search_text`；未安装时会回退到 Python 搜索

创建环境并安装项目：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
```

创建本地 `.env`：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

不要提交 `.env`。它应该只保存本机 API key 和部署相关路径。

## 配置

常见 `.env` 配置：

```env
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com

SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=Qwen/Qwen2.5-Coder-32B-Instruct

MIMO_API_KEY=
MIMO_BASE_URL=https://api.xiaomi.com
MIMO_MODEL=mimo-v2.5-pro

DEFAULT_PROVIDER=deepseek
DEFAULT_MODEL=deepseek-chat

API_KEY=
RUNTIME_WORKSPACE_ROOT=/path/to/allowed/workspaces
DATABASE_URL=sqlite:///./runtime.db

RUN_TIMEOUT_SECONDS=300
MODEL_REQUEST_TIMEOUT_SECONDS=180
MAX_CONCURRENT_RUNS=4

ENABLED_TOOLS=list_files,read_file,search_text,run_command
```

关键配置说明：

- `RUNTIME_WORKSPACE_ROOT` 是仓库访问的根 allowlist。run 和 session 的 `workspace_root` 必须位于这个目录下。
- `DATABASE_URL` 默认使用本地 SQLite。
- 设置 `API_KEY` 后，非本机请求需要携带 `X-API-Key`；本机 loopback 请求默认放行，便于本地开发。
- `ENABLED_TOOLS` 控制全局启用的内置工具。不设置表示启用全部内置工具；设置逗号分隔列表表示只开放这些工具；设置为空表示禁用全部工具。
- `MODEL_REQUEST_TIMEOUT_SECONDS` 控制单次模型 HTTP 请求超时。大仓库审查或长上下文任务可以适当调大。

## 启动服务

```bash
uvicorn code_review_agent.api.app:create_app --factory --reload
```

打开 Web UI：

```text
http://127.0.0.1:8000/
```

健康检查：

```bash
curl http://127.0.0.1:8000/health
```

## 使用 Docker Compose 启动

Docker 配置把服务代码、持久数据和被审查仓库拆到固定路径：

```text
/app         服务代码
/data        SQLite runtime 数据库
/workspaces 允许访问的仓库挂载根
```

构建并启动：

```bash
docker compose up --build
```

然后打开 `http://127.0.0.1:8000/`。

默认情况下，Compose 会把当前仓库挂载到：

```text
/workspaces/code-review-agent
```

在 UI 或 API 中创建 session/run 时，`workspace_root` 应使用这个容器内路径。
如需审查其他仓库，启动前设置 `CODE_REVIEW_WORKSPACE_HOST_ROOT`。

## Web UI

内置 Web UI 是一个本地单页工作台，主要围绕持久化 Session 使用。

支持：

- Session 列表和聊天工作区
- provider/model 选择
- 仓库 workspace 绑定
- 工具权限选择
- 用户消息乐观更新
- assistant Markdown 回复渲染
- turn 状态摘要
- 可折叠工具调用时间线
- turn 取消和 session 删除

前端当前是轻量单文件 HTML，不需要 npm 或构建流程。

## API 概览

公开端点：

- `GET /`
- `GET /health`

发现能力：

- `GET /tools`
- `GET /models/providers`

通用 runtime run：

- `GET /runs`
- `POST /runs`
- `GET /runs/{run_id}`
- `GET /runs/{run_id}/events`
- `POST /runs/{run_id}/cancel`

Repo Analyst app：

- `POST /repo-analyst/runs`
- `GET /repo-analyst/runs`
- `GET /repo-analyst/runs/{run_id}`
- `GET /repo-analyst/runs/{run_id}/raw`
- `GET /repo-analyst/runs/{run_id}/events`
- `POST /repo-analyst/runs/{run_id}/cancel`

持久化 Session：

- `POST /sessions`
- `GET /sessions`
- `GET /sessions/{session_id}`
- `DELETE /sessions/{session_id}`
- `POST /sessions/{session_id}/turns`
- `GET /sessions/{session_id}/turns`
- `POST /sessions/{session_id}/turns/{turn_id}/cancel`
- `GET /sessions/{session_id}/turns/{turn_id}/events`
- `GET /sessions/{session_id}/turns/{turn_id}/diagnostics`
- `GET /sessions/{session_id}/messages`

如果配置了 `API_KEY` 且请求不是本机 loopback，需要发送：

```text
X-API-Key: your_api_key
```

## Repo Analyst 示例

创建仓库总览 run：

```bash
curl -X POST http://127.0.0.1:8000/repo-analyst/runs \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_root": "/path/to/repository",
    "mode": "overview",
    "question": "分析这个仓库的主要功能、模块结构、架构设计、风险点和下一步建议。",
    "provider": "deepseek",
    "model": "deepseek-chat",
    "max_iterations": 100
  }'
```

创建代码审查 run：

```bash
curl -X POST http://127.0.0.1:8000/repo-analyst/runs \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_root": "/path/to/repository",
    "mode": "review",
    "question": "审查最近的代码改动，并检查测试是否能通过。",
    "enabled_tools": ["list_files", "read_file", "search_text", "run_command"],
    "provider": "deepseek",
    "model": "deepseek-chat",
    "max_iterations": 100
  }'
```

查看结果和事件：

```bash
curl http://127.0.0.1:8000/repo-analyst/runs/<run_id>
curl http://127.0.0.1:8000/repo-analyst/runs/<run_id>/events
```

## Session 示例

创建 session：

```bash
curl -X POST http://127.0.0.1:8000/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_root": "/path/to/repository",
    "provider": "deepseek",
    "model": "deepseek-chat",
    "max_iterations": 100
  }'
```

启动一轮对话：

```bash
curl -X POST http://127.0.0.1:8000/sessions/<session_id>/turns \
  -H "Content-Type: application/json" \
  -d '{
    "user_input": "审查最近的改动，指出明确问题。"
  }'
```

查看消息和诊断：

```bash
curl http://127.0.0.1:8000/sessions/<session_id>/messages
curl http://127.0.0.1:8000/sessions/<session_id>/turns/<turn_id>/diagnostics
curl http://127.0.0.1:8000/sessions/<session_id>/turns/<turn_id>/events
```

## 工具和安全边界

Runtime 通过明确的 schema 暴露工具。工具先注册到 registry，再根据全局环境变量、app/mode 策略和单次请求 payload 过滤。

文件工具受 workspace 限制：

- 拒绝绝对路径
- 拒绝 `..` 目录穿越
- 所有路径必须解析在指定 workspace 内

`run_command` 是受限命令工具：

- 使用 `asyncio.create_subprocess_exec(..., shell=False)`
- 接收结构化 `program + args`，不接收 shell 字符串
- 执行 allowlist 校验
- 拒绝明显 shell 组合符号
- 控制超时和输出截断
- 非 0 exit code 会作为有效观察返回，不当作工具传输失败

这不是 Docker sandbox，而是适合本地受控开发环境的最小命令沙箱。

## 可观测性和诊断

run 和 session turn 会记录事件，例如：

- 生命周期变化
- 模型请求和响应
- 工具开始和结束
- 取消
- 失败详情

diagnostics 会汇总：

- 总耗时
- 模型调用次数
- 工具调用次数
- 事件数量
- provider 返回的 token usage
- 最慢模型/工具步骤
- failure reason

这些信息可以通过 API 获取，也会被 Web UI 用于渲染 turn timeline。

## 开发

运行测试：

```bash
python -m pytest
```

运行局部测试：

```bash
python -m pytest tests/test_agent_loop.py
python -m pytest tests/test_context_manager.py
python -m pytest tests/test_session_api.py
```

检查内联前端脚本语法：

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('src/code_review_agent/web/index.html','utf8');for(const m of h.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi)) new Function(m[1]);console.log('ok')"
```

## 当前限制

- 还没有实现模型流式输出。
- 命令沙箱是 allowlist + 本地进程级别，不是容器隔离。
- ContextManager 目前主要基于字符预算，不是 provider tokenizer。
- Repo Analyst 的结构化输出依赖模型遵循 prompt，再由 parser 校验。
- Web UI 仍是单文件 HTML，没有前端工程化。
- SQLite 目标是单实例本地部署，不处理多实例一致性。

## 目录结构

```text
src/code_review_agent/
  api/              FastAPI app 和路由
  apps/repo_analyst 结构化仓库分析 app
  context/          prompt/context 压缩
  formatters/       provider payload 格式化
  harness/          Agent loop 和运行结果类型
  messages/         内部消息和 tool-call 类型
  models/           模型接口和 provider adapter
  observability/    事件和诊断辅助
  runtime/          run/session runtime 服务
  sandbox/          workspace 路径和命令策略
  session/          session 类型和接口
  storage/          SQLite runtime/session store
  tools/            工具抽象和内置工具
  web/              内置单页 UI
```
