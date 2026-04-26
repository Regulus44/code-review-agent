"""SQLite-backed runtime store implementation."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from code_review_agent.harness import AgentRunResult
from code_review_agent.runtime.store import RunNotFoundError, RunStore
from code_review_agent.runtime.types import RunEvent, RunRecord, RunStatus, utc_now


def _normalize_database_url(database_url: str) -> str:
    if database_url.startswith("sqlite+aiosqlite://"):
        return database_url
    if database_url.startswith("sqlite:///"):
        return database_url.replace("sqlite:///", "sqlite+aiosqlite:///", 1)
    return database_url


class Base(DeclarativeBase):
    """SQLAlchemy declarative base."""


class RunRow(Base):
    """Database row for runtime runs."""

    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    app_name: Mapped[str | None] = mapped_column(String(128))
    user_input: Mapped[str] = mapped_column(Text, nullable=False)
    workspace_root: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    system_prompt: Mapped[str | None] = mapped_column(Text)
    max_iterations: Mapped[int] = mapped_column(Integer, nullable=False)
    temperature: Mapped[float | None]
    max_tokens: Mapped[int | None]
    provider: Mapped[str | None]
    model: Mapped[str | None]
    tool_names_json: Mapped[str | None] = mapped_column(Text)
    failure_reason: Mapped[str | None] = mapped_column(Text)
    result_json: Mapped[str | None] = mapped_column(Text)


class RunEventRow(Base):
    """Database row for runtime events."""

    __tablename__ = "run_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    event_index: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    data_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")


class SqliteRunStore(RunStore):
    """SQLite-backed store for runs and runtime events."""

    def __init__(self, database_url: str) -> None:
        self.database_url = _normalize_database_url(database_url)
        self._engine = create_async_engine(self.database_url, future=True)
        self._session_factory = async_sessionmaker(
            self._engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        self._initialized = False
        self._initialize_lock = asyncio.Lock()

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        async with self._initialize_lock:
            if self._initialized:
                return
            async with self._engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
                await connection.run_sync(self._ensure_run_columns)
            self._initialized = True

    def _ensure_run_columns(self, connection) -> None:
        """Add new nullable columns to existing SQLite databases."""
        rows = connection.exec_driver_sql("PRAGMA table_info(runs)").fetchall()
        columns = {row[1] for row in rows}
        if "provider" not in columns:
            connection.exec_driver_sql("ALTER TABLE runs ADD COLUMN provider VARCHAR")
        if "tool_names_json" not in columns:
            connection.exec_driver_sql("ALTER TABLE runs ADD COLUMN tool_names_json TEXT")

    async def create_run(self, run: RunRecord) -> RunRecord:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            row = RunRow(
                id=run.id,
                status=run.status,
                app_name=run.app_name,
                user_input=run.user_input,
                workspace_root=run.workspace_root,
                created_at=run.created_at,
                started_at=run.started_at,
                finished_at=run.finished_at,
                system_prompt=run.system_prompt,
                max_iterations=run.max_iterations,
                temperature=run.temperature,
                max_tokens=run.max_tokens,
                provider=run.provider,
                model=run.model,
                tool_names_json=json.dumps(run.tool_names)
                if run.tool_names is not None
                else None,
                failure_reason=run.failure_reason,
                result_json=run.result.model_dump_json() if run.result else None,
            )
            session.add(row)
        return await self.get_run(run.id)

    async def get_run(self, run_id: str) -> RunRecord:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            row = await session.get(RunRow, run_id)
            if row is None:
                raise RunNotFoundError(run_id)
            return self._row_to_run_record(row)

    async def list_runs(self) -> list[RunRecord]:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            result = await session.execute(
                select(RunRow).order_by(RunRow.created_at.desc(), RunRow.id.desc()),
            )
            rows = result.scalars().all()
            return [self._row_to_run_record(row) for row in rows]

    async def get_events(self, run_id: str) -> list[RunEvent]:
        await self._ensure_initialized()
        await self.get_run(run_id)
        async with self._session_factory() as session:
            result = await session.execute(
                select(RunEventRow)
                .where(RunEventRow.run_id == run_id)
                .order_by(RunEventRow.event_index.asc()),
            )
            rows = result.scalars().all()
            return [self._row_to_event(row) for row in rows]

    async def append_event(self, run_id: str, event: RunEvent) -> RunEvent:
        await self._ensure_initialized()
        await self.get_run(run_id)
        async with self._session_factory() as session, session.begin():
            row = RunEventRow(
                run_id=run_id,
                event_index=event.index,
                type=event.type,
                timestamp=event.timestamp,
                data_json=json.dumps(
                    {
                        "data": event.data,
                        "payload": event.payload,
                        "event_type": event.event_type,
                        "trace_id": event.trace_id,
                        "span_id": event.span_id,
                        "parent_span_id": event.parent_span_id,
                        "status": event.status,
                        "duration_ms": event.duration_ms,
                        "failure_reason": event.failure_reason,
                    },
                ),
            )
            session.add(row)
        return event.model_copy(deep=True)

    async def update_status(
        self,
        run_id: str,
        status: RunStatus,
        *,
        failure_reason: str | None = None,
    ) -> RunRecord:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            row = await session.get(RunRow, run_id)
            if row is None:
                raise RunNotFoundError(run_id)

            row.status = status
            if status == "running" and row.started_at is None:
                row.started_at = utc_now()
            if status in {"completed", "failed", "max_iterations", "cancelled"}:
                row.finished_at = utc_now()
            if failure_reason is not None:
                row.failure_reason = failure_reason
        return await self.get_run(run_id)

    async def attach_result(self, run_id: str, result) -> RunRecord:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            row = await session.get(RunRow, run_id)
            if row is None:
                raise RunNotFoundError(run_id)

            row.result_json = result.model_dump_json()
            row.failure_reason = result.failure_reason
        return await self.get_run(run_id)

    async def aclose(self) -> None:
        await self._engine.dispose()

    def _row_to_run_record(self, row: RunRow) -> RunRecord:
        result = (
            AgentRunResult.model_validate_json(row.result_json)
            if row.result_json
            else None
        )
        return RunRecord(
            id=row.id,
            status=row.status,
            app_name=row.app_name,
            user_input=row.user_input,
            workspace_root=row.workspace_root,
            created_at=row.created_at,
            started_at=row.started_at,
            finished_at=row.finished_at,
            system_prompt=row.system_prompt,
            max_iterations=row.max_iterations,
            temperature=row.temperature,
            max_tokens=row.max_tokens,
            provider=row.provider,
            model=row.model,
            tool_names=json.loads(row.tool_names_json)
            if row.tool_names_json is not None
            else None,
            failure_reason=row.failure_reason,
            result=result,
        )

    def _row_to_event(self, row: RunEventRow) -> RunEvent:
        data = json.loads(row.data_json) if row.data_json else {}
        if (
            isinstance(data, dict)
            and any(
                key in data
                for key in (
                    "payload",
                    "event_type",
                    "trace_id",
                    "span_id",
                    "parent_span_id",
                    "status",
                    "duration_ms",
                    "failure_reason",
                )
            )
        ):
            event_data = data.get("data", {})
            payload = data.get("payload", event_data)
            return RunEvent(
                index=row.event_index,
                type=row.type,
                event_type=data.get("event_type"),
                timestamp=row.timestamp,
                data=event_data,
                payload=payload,
                trace_id=data.get("trace_id"),
                span_id=data.get("span_id"),
                parent_span_id=data.get("parent_span_id"),
                status=data.get("status"),
                duration_ms=data.get("duration_ms"),
                failure_reason=data.get("failure_reason"),
            )
        return RunEvent(
            index=row.event_index,
            type=row.type,
            timestamp=row.timestamp,
            data=data,
        )
