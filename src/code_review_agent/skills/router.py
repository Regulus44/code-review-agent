"""LLM-based turn-level skill routing."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.messages import Message, Role, system_message, user_message
from code_review_agent.models import ChatModel, ChatRequest

from .catalog import SkillCatalog
from .types import SkillDefinition

MAX_ROUTER_HISTORY_MESSAGES = 6
MAX_ROUTER_MESSAGE_CHARS = 800
MAX_SELECTED_SKILLS = 2


class SkillSelectionResult(BaseModel):
    """Result returned by the skill router."""

    model_config = ConfigDict(extra="forbid")

    selected_skills: list[str] = Field(default_factory=list)
    confidence: float | None = None
    reason: str | None = None
    raw_response: str | None = None
    error: str | None = None


class LlmSkillRouter:
    """Select relevant skills before a session turn runs."""

    def __init__(
        self,
        catalog: SkillCatalog,
        *,
        max_selected_skills: int = MAX_SELECTED_SKILLS,
        max_tokens: int = 512,
    ) -> None:
        self.catalog = catalog
        self.max_selected_skills = max_selected_skills
        self.max_tokens = max_tokens

    async def select(
        self,
        *,
        model: ChatModel,
        user_input: str,
        history: list[Message],
        workspace_root: str,
    ) -> SkillSelectionResult:
        """Ask the configured model to choose skills for this turn."""
        skills = self.catalog.list()
        if not skills:
            return SkillSelectionResult(reason="skill catalog is empty")

        try:
            response = await model.complete(
                ChatRequest(
                    messages=[
                        system_message(self._system_prompt()),
                        user_message(
                            self._user_prompt(
                                user_input=user_input,
                                history=history,
                                workspace_root=workspace_root,
                                skills=skills,
                            ),
                        ),
                    ],
                    temperature=0,
                    max_tokens=self.max_tokens,
                    metadata={"purpose": "skill_router"},
                ),
            )
        except Exception as exc:
            return SkillSelectionResult(
                reason="skill router model call failed",
                error=f"{exc.__class__.__name__}: {exc}",
            )

        raw = response.message.content or ""
        try:
            payload = _extract_json_payload(raw)
        except ValueError as exc:
            return SkillSelectionResult(
                reason="skill router returned invalid JSON",
                raw_response=raw,
                error=str(exc),
            )

        available = {skill.name for skill in skills}
        requested = payload.get("skills", [])
        if not isinstance(requested, list):
            requested = []
        selected: list[str] = []
        for item in requested:
            if not isinstance(item, str):
                continue
            if item in available and item not in selected:
                selected.append(item)
            if len(selected) >= self.max_selected_skills:
                break

        confidence = payload.get("confidence")
        if not isinstance(confidence, int | float):
            confidence = None

        reason = payload.get("reason")
        if not isinstance(reason, str):
            reason = None

        return SkillSelectionResult(
            selected_skills=selected,
            confidence=float(confidence) if confidence is not None else None,
            reason=reason,
            raw_response=raw,
        )

    def _system_prompt(self) -> str:
        return (
            "You are a skill router for a code-review agent. "
            "Choose only the skills that are clearly useful for the next user turn. "
            "Return strict JSON only, with this shape: "
            '{"skills":["skill-name"],"confidence":0.0,"reason":"short reason"}. '
            f"Select at most {self.max_selected_skills} skills. "
            "Use an empty skills array when no skill is clearly relevant."
        )

    def _user_prompt(
        self,
        *,
        user_input: str,
        history: list[Message],
        workspace_root: str,
        skills: list[SkillDefinition],
    ) -> str:
        payload = {
            "workspace_root": workspace_root,
            "user_input": user_input,
            "recent_history": _recent_history(history),
            "available_skills": [
                {
                    "name": skill.name,
                    "description": skill.description,
                    "routing": skill.routing.model_dump(),
                    "tools": skill.tools,
                }
                for skill in skills
            ],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)


def _recent_history(history: list[Message]) -> list[dict[str, Any]]:
    selected = [
        message
        for message in history
        if message.role in {Role.USER, Role.ASSISTANT}
    ][-MAX_ROUTER_HISTORY_MESSAGES:]
    return [
        {
            "role": message.role.value,
            "content": _truncate(message.content or "", MAX_ROUTER_MESSAGE_CHARS),
        }
        for message in selected
    ]


def _truncate(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return value[:max_chars].rstrip() + "...[truncated]"


def _extract_json_payload(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise ValueError("empty router response")

    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", stripped, re.S)
        if match:
            payload = json.loads(match.group(1))
        else:
            start = stripped.find("{")
            end = stripped.rfind("}")
            if start == -1 or end == -1 or end <= start:
                raise ValueError("no JSON object found in router response")
            payload = json.loads(stripped[start : end + 1])

    if not isinstance(payload, dict):
        raise ValueError("router response JSON must be an object")
    return payload
