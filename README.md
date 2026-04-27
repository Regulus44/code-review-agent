# Code Review Agent

A repository analysis and code review agent runtime.

## What It Includes

- Provider-neutral model interface with DeepSeek as default.
- Tool registry and built-in repository file tools.
- ReAct-style agent loop with tool-calling.
- Runtime run lifecycle and event tracking.
- FastAPI service and built-in web UI.
- Repo Analyst app that returns structured JSON reports.

## Run the API

Use the `dl` environment:

```bash
conda activate dl
cd D:\Develop\code-review-agent
uvicorn code_review_agent.api.app:create_app --factory --reload
```

Prepare `.env` from `.env.example`:

```bash
copy .env.example .env
```

Recommended `.env` values:

```env
DEEPSEEK_API_KEY=your_deepseek_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
SILICONFLOW_API_KEY=your_siliconflow_key
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=Qwen/Qwen2.5-Coder-32B-Instruct
DEFAULT_PROVIDER=deepseek
DEFAULT_MODEL=deepseek-chat
API_KEY=optional_api_key_for_remote_calls
RUNTIME_WORKSPACE_ROOT=D:\Develop
DATABASE_URL=sqlite:///./runtime.db
RUN_TIMEOUT_SECONDS=300
MODEL_REQUEST_TIMEOUT_SECONDS=180
MAX_CONCURRENT_RUNS=4
ENABLED_TOOLS=list_files,read_file,search_text,run_command
```

## API Notes

- `/` and `/health` are always public.
- If `API_KEY` is set, non-local requests must send `X-API-Key`.
- Local loopback requests (`127.0.0.1`, `localhost`) are allowed without `X-API-Key`.
- Run creation validates `workspace_root` under `RUNTIME_WORKSPACE_ROOT`.
- `DEFAULT_PROVIDER` currently supports `deepseek` and `siliconflow`. Provider selection is stored per run so runs can be audited later.
- `MODEL_REQUEST_TIMEOUT_SECONDS` controls one provider HTTP request timeout. Large review runs with long context should use a larger value such as `180` or `240`.
- `ENABLED_TOOLS` is optional. Leave it unset to enable all built-in tools, set a comma-separated list to expose only those tools, or set it empty to disable all tools.
- `GET /tools` lists each built-in tool, its schema, risk level, and whether it is currently enabled.

## Repo Analyst Example

Create a run:

```bash
curl -X POST http://127.0.0.1:8000/repo-analyst/runs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_if_required" \
  -d "{\"workspace_root\":\"D:/Develop/code-review-agent\",\"question\":\"Analyze this repository\"}"
```

Check result and events:

```bash
curl -H "X-API-Key: your_api_key_if_required" http://127.0.0.1:8000/repo-analyst/runs/<run_id>
curl -H "X-API-Key: your_api_key_if_required" http://127.0.0.1:8000/repo-analyst/runs/<run_id>/events
```
