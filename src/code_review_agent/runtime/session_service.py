"""Session service — orchestrates persistent agent sessions."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from uuid import uuid4

from code_review_agent.context import ContextBudget, ContextManager
from code_review_agent.harness import Agent, AgentRunResult
from code_review_agent.messages import Message
from code_review_agent.runtime.types import utc_now
from code_review_agent.session import InMemorySession
from code_review_agent.session.store import (
    SessionNotFoundError,
    SessionStore,
    TurnNotFoundError,
)
from code_review_agent.session.types import (
    SessionRecord,
    SessionTurn,
    TurnStatus,
)
from code_review_agent.skills import (
    LlmSkillRouter,
    SkillCatalog,
    SkillDefinition,
    SkillSelectionResult,
)
from code_review_agent.tools import ToolContext, ToolRegistry
from code_review_agent.tools.policy import filter_tool_registry

from .turn_events import (
    TurnEventEmitter,
    aclose_model_if_needed,
    build_diagnostics,
    convert_agent_steps_to_events,
)

logger = logging.getLogger(__name__)


class SessionConflictError(Exception):
    """Raised when a turn is started on a session that already has an active turn."""


class SessionService:
    """Orchestrates persistent agent sessions.

    Each session turn reuses the Agent loop with reset_session=False,
    loading history from the store and appending new messages afterward.
    """

    def __init__(
        self,
        *,
        store: SessionStore,
        agent_name: str = "code-review-agent",
        model_factory=None,
        tool_registry_factory=None,
        context_budget_factory=None,
        skill_catalog: SkillCatalog | None = None,
        skill_router: LlmSkillRouter | None = None,
        run_timeout_seconds: int = 300,
    ) -> None:
        self._store = store
        self.agent_name = agent_name
        self.model_factory = model_factory
        self.tool_registry_factory = tool_registry_factory
        self.context_budget_factory = context_budget_factory
        self.skill_catalog = skill_catalog
        self.skill_router = skill_router
        self.run_timeout_seconds = run_timeout_seconds
        self._active_turns: dict[str, asyncio.Task] = {}
        self._logger = logging.getLogger(__name__)

    async def create_session(self, **kwargs) -> SessionRecord:
        """Create a new session record."""
        if "id" not in kwargs:
            kwargs["id"] = str(uuid4())
        record = SessionRecord(**kwargs)
        return await self._store.create_session(record)

    async def get_session(self, session_id: str) -> SessionRecord | None:
        return await self._store.get_session(session_id)

    async def list_sessions(self):
        return await self._store.list_sessions()

    async def archive_session(self, session_id: str) -> SessionRecord:
        return await self._store.archive_session(session_id)

    async def get_messages(self, session_id: str, *, since_sequence: int = 0) -> list[Message]:
        return await self._store.get_messages(session_id, since_sequence=since_sequence)

    async def get_messages_with_sequence(
        self,
        session_id: str,
        *,
        since_sequence: int = 0,
    ) -> list[dict]:
        return await self._store.get_messages_with_sequence(
            session_id,
            since_sequence=since_sequence,
        )

    async def list_turns(self, session_id: str):
        return await self._store.list_turns(session_id)

    async def start_turn(self, session_id: str, user_input: str) -> SessionTurn:
        """Create a new turn and start executing it in the background."""
        if session_id in self._active_turns:
            raise SessionConflictError(
                f"Session {session_id} already has an active turn"
            )

        session = await self._store.get_session(session_id)
        if session is None:
            raise SessionNotFoundError(session_id)
        if session.status == "archived":
            raise SessionConflictError("Cannot start a turn on an archived session")

        turn_index = await self._store.next_turn_index(session_id)
        turn = SessionTurn(
            id=str(uuid4()),
            session_id=session_id,
            turn_index=turn_index,
            user_input=user_input,
            status="queued",
            created_at=utc_now(),
        )
        await self._store.create_turn(turn)
        await self._store.update_session(
            session_id, status="running", updated_at=utc_now(),
        )

        task = asyncio.create_task(self._execute_turn(session_id, turn.id))
        self._active_turns[session_id] = task
        task.add_done_callback(lambda t: self._active_turns.pop(session_id, None))
        return turn

    async def cancel_turn(self, session_id: str, turn_id: str) -> SessionTurn:
        """Cancel a running or queued turn."""
        turn = await self._store.get_turn(turn_id)
        if turn is None or turn.session_id != session_id:
            raise TurnNotFoundError(turn_id)

        terminal_statuses: set[TurnStatus] = {
            "completed", "failed", "cancelled", "max_iterations",
            "model_output_truncated",
        }
        if turn.status in terminal_statuses:
            raise SessionConflictError(
                f"Turn is already in terminal state: {turn.status}"
            )

        task = self._active_turns.get(session_id)
        if task and not task.done():
            task.cancel()

        await self._store.update_turn(
            turn_id,
            status="cancelled",
            finished_at=utc_now(),
            failure_reason="cancelled_by_user",
        )
        await self._store.update_session(
            session_id, status="idle", updated_at=utc_now(),
        )
        result = await self._store.get_turn(turn_id)
        if result is None:
            raise TurnNotFoundError(turn_id)
        return result

    async def _execute_turn(self, session_id: str, turn_id: str) -> None:
        """Execute one turn — load history, run agent, save new messages."""
        turn = await self._store.get_turn(turn_id)
        if turn is None:
            return
        session_record = await self._store.get_session(session_id)
        if session_record is None:
            return

        emitter = TurnEventEmitter(self._store, turn_id)
        model = None
        started_at = utc_now()
        try:
            await emitter.emit(
                legacy_type="status_change",
                event_type="turn.started",
                payload={"status": "running"},
                status="running",
            )

            history = await self._store.get_messages(session_id)
            session = InMemorySession()
            if history:
                session.append(history)

            raw_model = self.model_factory(session_record.provider, session_record.model)
            model = raw_model

            budget = (
                self.context_budget_factory(session_record)
                if self.context_budget_factory
                else ContextBudget()
            )

            await self._store.update_turn(
                turn_id, status="running", started_at=utc_now(),
            )

            skill_selection = await self._select_skills(
                model=raw_model,
                user_input=turn.user_input,
                history=history,
                workspace_root=session_record.workspace_root,
            )
            selected_skills = self._skills_from_selection(
                skill_selection.selected_skills,
            )
            if self.skill_router is not None:
                await emitter.emit(
                    legacy_type="skill_selection",
                    event_type="skill.selected"
                    if not skill_selection.error
                    else "skill.selection_failed",
                    payload={
                        "selected_skills": [skill.name for skill in selected_skills],
                        "requested_skills": skill_selection.selected_skills,
                        "confidence": skill_selection.confidence,
                        "reason": skill_selection.reason,
                        "error": skill_selection.error,
                    },
                    status="success" if not skill_selection.error else "failed",
                    failure_reason=skill_selection.error,
                )

            model = emitter.wrap_model(raw_model)
            registry = self._apply_skill_tool_policy(
                self.tool_registry_factory(),
                session_record=session_record,
                selected_skills=selected_skills,
            )

            agent = Agent(
                name=self.agent_name,
                model=model,
                tool_registry=registry,
                session=session,
                system_prompt=self._build_turn_system_prompt(
                    session_record.system_prompt,
                    selected_skills,
                ),
                max_iterations=session_record.max_iterations,
                max_tokens=session_record.max_tokens,
                context_budget=budget,
                persist_system_prompt=False,
            )

            tool_context = ToolContext(
                workspace_root=Path(session_record.workspace_root),
                run_id=None,
                session_id=session_id,
                turn_id=turn_id,
            )

            result = await asyncio.wait_for(
                agent.run(turn.user_input, tool_context, reset_session=False),
                timeout=self.run_timeout_seconds,
            )

            all_messages = agent.session.get_messages()
            new_messages = all_messages[len(history):]
            await self._store.append_messages(session_id, new_messages, turn.turn_index)

            await convert_agent_steps_to_events(
                steps=result.steps,
                emit=emitter.emit,
                root_span_id=emitter.root_span_id,
                include_model_events=False,
            )

            finished_at = utc_now()
            events = await self._store.get_turn_events(turn_id)
            diagnostics = build_diagnostics(
                result=result,
                events=events,
                started_at=started_at,
                finished_at=finished_at,
                failure_reason=result.failure_reason,
            )

            await self._store.update_turn(
                turn_id,
                status=result.status,
                finished_at=finished_at,
                usage_json=result.usage.model_dump_json() if result.usage else None,
                failure_reason=result.failure_reason,
            )

            await self._store.update_session(
                session_id,
                status="idle",
                last_user_input=turn.user_input,
                updated_at=utc_now(),
            )

            await emitter.emit(
                legacy_type="status_change",
                event_type=f"turn.{result.status}",
                payload={
                    "status": result.status,
                    "failure_reason": result.failure_reason,
                    "model_call_count": diagnostics.model_call_count,
                    "tool_call_count": diagnostics.tool_call_count,
                },
                status=result.status,
                failure_reason=result.failure_reason,
            )

        except asyncio.CancelledError:
            current = await self._store.get_turn(turn_id)
            existing_reason = current.failure_reason if current else None
            reason = existing_reason or "cancelled"
            await self._store.update_turn(
                turn_id,
                status="cancelled",
                finished_at=utc_now(),
                failure_reason=reason,
            )
            await self._store.update_session(
                session_id, status="idle", updated_at=utc_now(),
            )
            await emitter.emit(
                legacy_type="status_change",
                event_type="turn.cancelled",
                payload={"status": "cancelled", "failure_reason": reason},
                status="cancelled",
                failure_reason=reason,
            )

        except asyncio.TimeoutError:
            await self._store.update_turn(
                turn_id,
                status="failed",
                finished_at=utc_now(),
                failure_reason="run_timeout",
            )
            await self._store.update_session(
                session_id, status="idle", updated_at=utc_now(),
            )
            await emitter.emit(
                legacy_type="status_change",
                event_type="turn.timeout",
                payload={"status": "failed", "failure_reason": "run_timeout"},
                status="failed",
                failure_reason="run_timeout",
            )

        except Exception as e:
            self._logger.exception("Turn %s failed", turn_id)
            await self._store.update_turn(
                turn_id,
                status="failed",
                finished_at=utc_now(),
                failure_reason=str(e),
            )
            await self._store.update_session(
                session_id, status="idle", updated_at=utc_now(),
            )
            await emitter.emit(
                legacy_type="status_change",
                event_type="turn.failed",
                payload={"status": "failed", "failure_reason": str(e)},
                status="failed",
                failure_reason=str(e),
            )

        finally:
            await aclose_model_if_needed(model)

    async def _select_skills(
        self,
        *,
        model,
        user_input: str,
        history: list[Message],
        workspace_root: str,
    ) -> SkillSelectionResult:
        if self.skill_router is None:
            return SkillSelectionResult(reason="skill router disabled")
        return await self.skill_router.select(
            model=model,
            user_input=user_input,
            history=history,
            workspace_root=workspace_root,
        )

    def _skills_from_selection(self, selected_names: list[str]) -> list[SkillDefinition]:
        if self.skill_catalog is None:
            return []
        skills: list[SkillDefinition] = []
        for name in selected_names:
            skill = self.skill_catalog.get(name)
            if skill is not None:
                skills.append(skill)
        return skills

    def _build_turn_system_prompt(
        self,
        base_prompt: str | None,
        selected_skills: list[SkillDefinition],
    ) -> str | None:
        parts: list[str] = []
        if base_prompt:
            parts.append(base_prompt.strip())
        if selected_skills:
            skill_sections = [
                f"## Active skill: {skill.display_name} ({skill.name})\n\n"
                f"{skill.prompt.strip()}"
                for skill in selected_skills
            ]
            parts.append(
                "The following skills are active for this turn. "
                "Follow their instructions when they are relevant.\n\n"
                + "\n\n".join(skill_sections)
            )
        if not parts:
            return None
        return "\n\n".join(parts)

    def _apply_skill_tool_policy(
        self,
        registry: ToolRegistry,
        *,
        session_record: SessionRecord,
        selected_skills: list[SkillDefinition],
    ) -> ToolRegistry:
        available_order = [tool.name for tool in registry.list_tools()]
        available = set(available_order)
        allowed = (
            set(session_record.tool_names)
            if session_record.tool_names is not None
            else set(available)
        )

        skill_tools: set[str] = set()
        for skill in selected_skills:
            skill_tools.update(skill.tools)

        if skill_tools:
            target = allowed & skill_tools & available
        else:
            target = allowed & available

        if not target and session_record.tool_names is None:
            return registry

        ordered_target = [name for name in available_order if name in target]
        return filter_tool_registry(registry, ordered_target)

    async def recover_stale_sessions(self) -> int:
        """Recover stale sessions after server restart."""
        return await self._store.recover_stale_sessions()
