"""Minimal agent loop implementation."""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone

from code_review_agent.messages import (
    Message,
    system_message,
    tool_message,
    user_message,
)
from code_review_agent.models import (
    ChatModel,
    ChatRequest,
    ChatResponse,
    ModelConfigurationError,
    ModelError,
    ModelUsage,
)
from code_review_agent.session import InMemorySession, Session
from code_review_agent.tools import ToolContext, ToolRegistry

from .types import AgentRunResult, AgentRunStatus, AgentStep


@dataclass
class _UsageAccumulator:
    """Accumulate token usage across model responses."""

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None

    def add(self, usage: ModelUsage | None) -> None:
        """Add one usage object into the running totals."""
        if usage is None:
            return

        self.prompt_tokens = _add_optional_int(
            self.prompt_tokens,
            usage.prompt_tokens,
        )
        self.completion_tokens = _add_optional_int(
            self.completion_tokens,
            usage.completion_tokens,
        )
        self.total_tokens = _add_optional_int(
            self.total_tokens,
            usage.total_tokens,
        )

    def to_model_usage(self) -> ModelUsage | None:
        """Convert the accumulator to a usage object."""
        if (
            self.prompt_tokens is None
            and self.completion_tokens is None
            and self.total_tokens is None
        ):
            return None
        return ModelUsage(
            prompt_tokens=self.prompt_tokens,
            completion_tokens=self.completion_tokens,
            total_tokens=self.total_tokens,
        )


def _add_optional_int(current: int | None, new_value: int | None) -> int | None:
    """Add optional integer values while preserving None semantics."""
    if new_value is None:
        return current
    if current is None:
        return new_value
    return current + new_value


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Agent:
    """Minimal agent loop that combines model and tools."""

    def __init__(
        self,
        *,
        name: str,
        model: ChatModel,
        tool_registry: ToolRegistry | None = None,
        session: Session | None = None,
        system_prompt: str | None = None,
        max_iterations: int = 8,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> None:
        self.name = name
        self.model = model
        self.tool_registry = tool_registry
        self.session = session or InMemorySession()
        self.system_prompt = system_prompt
        self.max_iterations = max_iterations
        self.temperature = temperature
        self.max_tokens = max_tokens

    async def run(
        self,
        user_input: str,
        tool_context: ToolContext,
        reset_session: bool = True,
    ) -> AgentRunResult:
        """Run the minimal agent loop."""
        if reset_session:
            self.session.clear()

        if self.system_prompt and not self.session.get_messages():
            self.session.append(system_message(self.system_prompt))

        self.session.append(user_message(user_input))

        steps: list[AgentStep] = []
        step_index = 0
        iterations = 0
        latest_assistant_message: Message | None = None
        usage = _UsageAccumulator()

        for _ in range(self.max_iterations):
            next_iteration = iterations + 1
            model_started_at = _utc_now()
            model_started_perf = time.perf_counter()
            try:
                response = await self.model.complete(
                    ChatRequest(
                        messages=self.session.get_messages(),
                        tools=self.tool_registry.get_model_schemas()
                        if self.tool_registry
                        else None,
                        temperature=self.temperature,
                        max_tokens=self.max_tokens,
                    ),
                )
                model_finished_at = _utc_now()
                model_duration_ms = int((time.perf_counter() - model_started_perf) * 1000)
            except ModelError as exc:
                return AgentRunResult(
                    status="failed",
                    final_message=latest_assistant_message,
                    messages=self.session.get_messages(),
                    steps=steps,
                    iterations=iterations,
                    usage=usage.to_model_usage(),
                    failure_reason=str(exc),
                )

            iterations += 1
            usage.add(response.usage)
            latest_assistant_message = response.message
            self.session.append(response.message)

            step_index += 1
            steps.append(
                AgentStep(
                    type="model_response",
                    index=step_index,
                    message=response.message.model_copy(deep=True),
                    usage=response.usage.model_copy(deep=True)
                    if response.usage
                    else None,
                    finish_reason=response.finish_reason,
                    iteration=iterations,
                    started_at=model_started_at,
                    finished_at=model_finished_at,
                    duration_ms=model_duration_ms,
                    metadata={
                        "provider": response.provider,
                        "model": response.model,
                        "requested_model": self.model.model_name,
                        "returned_model": response.model,
                    },
                ),
            )

            if not response.tool_calls:
                return self._build_result(
                    status="completed",
                    final_message=latest_assistant_message,
                    steps=steps,
                    iterations=iterations,
                    usage=usage.to_model_usage(),
                )

            if self.tool_registry is None:
                return self._build_result(
                    status="failed",
                    final_message=latest_assistant_message,
                    steps=steps,
                    iterations=iterations,
                    usage=usage.to_model_usage(),
                    failure_reason="tool_calls_returned_without_registry",
                )

            for tool_call in response.tool_calls:
                tool_started_at = _utc_now()
                tool_started_perf = time.perf_counter()
                tool_result = await self.tool_registry.invoke(tool_call, tool_context)
                tool_finished_at = _utc_now()
                tool_duration_ms = int((time.perf_counter() - tool_started_perf) * 1000)
                self.session.append(tool_message(tool_result.to_message_result(tool_call.id)))

                step_index += 1
                steps.append(
                    AgentStep(
                        type="tool_call",
                        index=step_index,
                        tool_call=tool_call.model_copy(deep=True),
                        tool_result_status=tool_result.status,
                        tool_result_content=tool_result.content,
                        iteration=iterations,
                        started_at=tool_started_at,
                        finished_at=tool_finished_at,
                        duration_ms=tool_duration_ms,
                        metadata={"tool_name": tool_call.name},
                    ),
                )

        return self._build_result(
            status="max_iterations",
            final_message=latest_assistant_message,
            steps=steps,
            iterations=iterations,
            usage=usage.to_model_usage(),
            failure_reason="max_iterations_reached",
        )

    def _build_result(
        self,
        *,
        status: AgentRunStatus,
        final_message: Message | None,
        steps: list[AgentStep],
        iterations: int,
        usage: ModelUsage | None,
        failure_reason: str | None = None,
    ) -> AgentRunResult:
        """Build a structured agent run result from the session."""
        return AgentRunResult(
            status=status,
            final_message=final_message.model_copy(deep=True)
            if final_message
            else None,
            messages=self.session.get_messages(),
            steps=[step.model_copy(deep=True) for step in steps],
            iterations=iterations,
            usage=usage.model_copy(deep=True) if usage else None,
            failure_reason=failure_reason,
        )
