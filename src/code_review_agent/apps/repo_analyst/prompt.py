"""Prompt helpers for the repository analyst app."""

from __future__ import annotations

import json


DEFAULT_REPO_ANALYST_QUESTION = (
    "分析这个仓库的主要功能、模块结构、架构设计、风险点和建议的下一步。"
)


def build_repo_analyst_prompt(question: str | None = None) -> str:
    """Build the repo analyst system prompt."""
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
        "Use exactly these top-level fields: "
        "summary, modules, architecture, risks, next_steps.\n"
        "Schema example:\n"
        f"{json.dumps(example_schema, ensure_ascii=False, indent=2)}"
    )

