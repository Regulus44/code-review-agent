# Code Review Agent

A code review agent with a small runtime for repository analysis.

The goal of this project is to demonstrate a runtime system around agents, not
just a single prompt loop. The runtime will organize:

- model providers
- tool registration and execution
- sandboxed filesystem and command access
- agent harness loops
- run lifecycle management
- observable event streams
- service APIs
- repository analysis and code review workflows

## Planned Scope

- DeepSeek-first model adapter with an OpenAI-compatible provider interface.
- Tool registry with built-in repository tools.
- Safe execution policies for file and shell tools.
- ReAct-style harness with structured final reports.
- FastAPI service for creating and inspecting runs.
- SQLite-backed run and event storage.
- Optional web UI for run timelines and reports.

## Repo Analyst App

The project now includes a dedicated repository analyst app on top of the
generic runtime. It is designed to answer questions such as:

- what the repository does
- how the modules are organized
- what the key architecture looks like
- what the main risks and next steps are

The app returns a structured JSON report with these top-level fields:

- `summary`
- `modules`
- `architecture`
- `risks`
- `next_steps`

### Run the API

Use the `dl` environment:

```bash
conda activate dl
cd D:\Develop\code-review-agent
uvicorn code_review_agent.api.app:create_app --factory --reload
```

Before starting the API, fill in the root `.env` file:

```env
DEEPSEEK_API_KEY=your_deepseek_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEFAULT_MODEL=deepseek-chat
```

The application now loads `.env` automatically at startup.

You can prepare it from the root `.env.example`:

```bash
copy .env.example .env
```

### Create a Repo Analyst Run

```bash
curl -X POST http://127.0.0.1:8000/repo-analyst/runs \
  -H "Content-Type: application/json" \
  -d "{\"workspace_root\":\"D:/Develop/code-review-agent\",\"question\":\"分析这个仓库的主要功能和架构\"}"
```

### Check the Result

```bash
curl http://127.0.0.1:8000/repo-analyst/runs/<run_id>
curl http://127.0.0.1:8000/repo-analyst/runs/<run_id>/events
```
