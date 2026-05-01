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
from code_review_agent.tools import ToolContext, ToolRegistry
from code_review_agent.tools.policy import filter_tool_registry

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
        run_timeout_seconds: int = 300,
    ) -> None:
        self._store = store
        self.agent_name = agent_name
        self.model_factory = model_factory
        self.tool_registry_factory = tool_registry_factory
        self.context_budget_factory = context_budget_factory
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

    async def get_messages_with_sequence(self, session_id: str, *, since_sequence: int = 0) -> list[dict]:
        return await self._store.get_messages_with_sequence(session_id, since_sequence=since_sequence)

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

        model = None
        try:
            history = await self._store.get_messages(session_id)
            session = InMemorySession()
            if history:
                session.append(history)

            model = self.model_factory(session_record.provider, session_record.model)

            await self._store.update_turn(
                turn_id, status="running", started_at=utc_now(),
            )

            registry = self.tool_registry_factory()
            if session_record.tool_names is not None:
                registry = filter_tool_registry(registry, session_record.tool_names)

            budget = (
                self.context_budget_factory(session_record)
                if self.context_budget_factory
                else ContextBudget()
            )

            agent = Agent(
                name=self.agent_name,
                model=model,
                tool_registry=registry,
                session=session,
                system_prompt=session_record.system_prompt,
                max_iterations=session_record.max_iterations,
                max_tokens=session_record.max_tokens,
                context_budget=budget,
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

            await self._store.update_turn(
                turn_id,
                status=result.status,
                finished_at=utc_now(),
                usage_json=result.usage.model_dump_json() if result.usage else None,
                failure_reason=result.failure_reason,
            )

            await self._store.update_session(
                session_id,
                status="idle",
                last_user_input=turn.user_input,
                updated_at=utc_now(),
            )

        except asyncio.CancelledError:
            current = await self._store.get_turn(turn_id)
            existing_reason = current.failure_reason if current else None
            await self._store.update_turn(
                turn_id,
                status="cancelled",
                finished_at=utc_now(),
                failure_reason=existing_reason or "cancelled",
            )
            await self._store.update_session(
                session_id, status="idle", updated_at=utc_now(),
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

        finally:
            close = getattr(model, "aclose", None)
            if close is not None:
                try:
                    await close()
                except Exception:
                    pass

    async def recover_stale_sessions(self) -> int:
        """Recover stale sessions after server restart."""
        return await self._store.recover_stale_sessions()
