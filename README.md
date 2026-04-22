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
