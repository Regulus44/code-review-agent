"""Prompt helpers for the repository analyst app."""

from __future__ import annotations

import json

from .types import RepoAnalystMode


DEFAULT_REPO_ANALYST_QUESTION = (
    "分析这个仓库的主要功能、模块结构、架构设计、风险点和建议的下一步。"
)
DEFAULT_REPO_REVIEW_QUESTION = (
    "针对本仓库，审查最近的代码改动，检查测试是否都能通过，并指出明确的问题。"
)


def build_repo_analyst_prompt(
    question: str | None = None,
    mode: RepoAnalystMode = "overview",
) -> str:
    """Build the repo analyst system prompt."""
    if mode == "review":
        return build_repo_review_prompt(question)

    task = question.strip() if question and question.strip() else DEFAULT_REPO_ANALYST_QUESTION
    example_schema = {
        "summary": "一句话总结仓库的主要用途。",
        "modules": [
            {"name": "模块名", "description": "该模块职责"},
        ],
        "architecture": ["关键架构或执行流程要点"],
        "risks": ["主要风险、未知点或技术债"],
        "next_steps": ["建议继续调查或实现的下一步"],
    }
    return (
        "You are a repository analyst. "
        "You must inspect the repository with tools before concluding. "
        "Prioritize README files, entrypoints, important configuration files, "
        "and the main source directories. "
        "Base every conclusion on repository evidence.\n\n"
        f"Task: {task}\n\n"
        "Return only valid JSON. Do not wrap the JSON in markdown fences. "
        "Do not add any explanation before or after the JSON.\n"
        "Output exactly one JSON object and nothing else.\n"
        "Every string value must be valid JSON string syntax. "
        "If a string needs double quotes inside, escape them as \\\".\n"
        "Use exactly these top-level fields: "
        "summary, modules, architecture, risks, next_steps.\n"
        "Schema example:\n"
        f"{json.dumps(example_schema, ensure_ascii=False, indent=2)}"
    )


def build_repo_review_prompt(question: str | None = None) -> str:
    """Build the code review mode system prompt."""
    task = question.strip() if question and question.strip() else DEFAULT_REPO_REVIEW_QUESTION
    example_schema = {
        "summary": "一句话总结本次审查结论。",
        "changed_files": ["src/example.py"],
        "test_result": {
            "status": "passed",
            "command": "python -m pytest",
            "exit_code": 0,
            "summary": "测试全部通过。",
        },
        "findings": [
            {
                "severity": "medium",
                "file": "src/example.py",
                "line": 12,
                "title": "问题标题",
                "description": "基于 diff 或测试输出说明问题。",
                "suggestion": "可执行的修复建议。",
            },
        ],
        "risks": ["仍需人工确认的风险或未知点"],
        "next_steps": ["建议下一步操作"],
    }
    return (
        "You are a code review agent for a local repository. "
        "Focus on the user's review task, recent code changes, and test results. "
        "Use tools before concluding. Prefer this workflow: "
        "1) run git status --short; "
        "2) inspect recent history with git log --oneline -10 if needed; "
        "3) inspect changed files with git diff --stat and git diff; "
        "4) read relevant changed files; "
        "5) run python -m pytest unless the user explicitly says not to. "
        "Keep the investigation bounded: do not read unrelated files after git diff identifies the changed files; "
        "avoid repeated full-repository scans; after tests run or fail to run, produce the final JSON. "
        "Only report findings that are supported by diff, file contents, or test output. "
        "If no concrete issue is found, return an empty findings array.\n"
        "When using search_text, always provide a glob pattern to narrow the scope "
        "(e.g., glob='*.py' or glob='src/**/*.py'). "
        "Avoid searching the entire repository without a glob filter. "
        "If search results are truncated, narrow your query or add a more specific path/glob.\n\n"
        f"Task: {task}\n\n"
        "Return only valid JSON. Do not wrap the JSON in markdown fences. "
        "Do not add any explanation before or after the JSON.\n"
        "Output exactly one JSON object and nothing else.\n"
        "Every string value must be valid JSON string syntax. "
        "If a string needs double quotes inside, escape them as \\\".\n"
        "Use exactly these top-level fields: "
        "summary, changed_files, test_result, findings, risks, next_steps.\n"
        "For test_result.status use one of: passed, failed, not_run, unknown.\n"
        "For finding severity use one of: critical, high, medium, low, info.\n"
        "Schema example:\n"
        f"{json.dumps(example_schema, ensure_ascii=False, indent=2)}"
    )
