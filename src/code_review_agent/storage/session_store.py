"""SQLite-backed session store implementation."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from code_review_agent.messages import Message, Role, ToolCall
from code_review_agent.session.store import (
    SessionNotFoundError,
    SessionStore,
    TurnNotFoundError,
)
from code_review_agent.session.types import (
    SessionRecord,
    SessionSummary,
    SessionTurn,
    utc_now,
)


def _normalize_database_url(database_url: str) -> str:
    if database_url.startswith("sqlite+aiosqlite://"):
        return database_url
    if database_url.startswith("sqlite:///"):
        return database_url.replace("sqlite:///", "sqlite+aiosqlite:///", 1)
    return database_url


class Base(DeclarativeBase):
    pass


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    last_user_input: Mapped[str | None] = mapped_column(Text)
    workspace_root: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    system_prompt: Mapped[str | None] = mapped_column(Text)
    provider: Mapped[str | None] = mapped_column(String(128))
    model: Mapped[str | None] = mapped_column(String(128))
    tool_names_json: Mapped[str | None] = mapped_column(Text)
    max_iterations: Mapped[int] = mapped_column(Integer, nullable=False)
    max_tokens: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SessionTurnRow(Base):
    __tablename__ = "session_turns"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False,
    )
    run_id: Mapped[str | None] = mapped_column(String(64))
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    user_input: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    failure_reason: Mapped[str | None] = mapped_column(Text)
    usage_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SessionMessageRow(Base):
    __tablename__ = "session_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False,
    )
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str | None] = mapped_column(Text)
    reasoning_content: Mapped[str | None] = mapped_column(Text)
    tool_calls_json: Mapped[str | None] = mapped_column(Text)
    tool_call_id: Mapped[str | None] = mapped_column(String(64))
    name: Mapped[str | None] = mapped_column(String(128))
    raw_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SqliteSessionStore(SessionStore):
    """SQLite-backed store for sessions, turns, and messages."""

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
            self._initialized = True

    async def create_session(self, record: SessionRecord) -> SessionRecord:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            row = SessionRow(
                id=record.id,
                status=record.status,
                title=record.title,
                last_user_input=record.last_user_input,
                workspace_root=record.workspace_root,
                mode=record.mode,
                system_prompt=record.system_prompt,
                provider=record.provider,
                model=record.model,
                tool_names_json=json.dumps(record.tool_names)
                if record.tool_names is not None
                else None,
                max_iterations=record.max_iterations,
                max_tokens=record.max_tokens,
                created_at=record.created_at,
                updated_at=record.updated_at,
                archived_at=record.archived_at,
            )
            session.add(row)
        return (await self.get_session(record.id))

    async def get_session(self, session_id: str) -> SessionRecord | None:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            row = await session.get(SessionRow, session_id)
            if row is None:
                return None
            return self._row_to_session_record(row)

    async def list_sessions(self) -> list[SessionSummary]:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            result = await session.execute(
                select(SessionRow).order_by(
                    SessionRow.created_at.desc(), SessionRow.id.desc(),
                ),
            )
            rows = result.scalars().all()
            summaries = []
            for row in rows:
                msg_count = await self._count_messages(session, row.id)
                turn_count = await self._count_turns(session, row.id)
                summaries.append(
                    SessionSummary(
                        id=row.id,
                        status=row.status,
                        title=row.title,
                        mode=row.mode,
                        last_user_input=row.last_user_input,
                        workspace_root=row.workspace_root,
                        message_count=msg_count,
                        turn_count=turn_count,
                        created_at=row.created_at,
                        updated_at=row.updated_at,
                    )
                )
            return summaries

    async def update_session(self, session_id: str, **fields) -> SessionRecord:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            row = await session.get(SessionRow, session_id)
            if row is None:
                raise SessionNotFoundError(session_id)
            for k, v in fields.items():
                if hasattr(row, k):
                    setattr(row, k, v)
            row.updated_at = utc_now()
        return (await self.get_session(session_id))

    async def archive_session(self, session_id: str) -> SessionRecord:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            row = await session.get(SessionRow, session_id)
            if row is None:
                raise SessionNotFoundError(session_id)
            row.status = "archived"
            row.archived_at = utc_now()
            row.updated_at = utc_now()
        return (await self.get_session(session_id))

    async def create_turn(self, turn: SessionTurn) -> SessionTurn:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            row = SessionTurnRow(
                id=turn.id,
                session_id=turn.session_id,
                run_id=turn.run_id,
                turn_index=turn.turn_index,
                user_input=turn.user_input,
                status=turn.status,
                failure_reason=turn.failure_reason,
                usage_json=turn.usage_json,
                created_at=turn.created_at,
                started_at=turn.started_at,
                finished_at=turn.finished_at,
            )
            session.add(row)
        result = await self.get_turn(turn.id)
        if result is None:
            raise TurnNotFoundError(turn.id)
        return result

    async def get_turn(self, turn_id: str) -> SessionTurn | None:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            row = await session.get(SessionTurnRow, turn_id)
            if row is None:
                return None
            return self._row_to_turn(row)

    async def list_turns(self, session_id: str) -> list[SessionTurn]:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            result = await session.execute(
                select(SessionTurnRow)
                .where(SessionTurnRow.session_id == session_id)
                .order_by(SessionTurnRow.turn_index.asc()),
            )
            rows = result.scalars().all()
            return [self._row_to_turn(row) for row in rows]

    async def update_turn(self, turn_id: str, **fields) -> SessionTurn:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            row = await session.get(SessionTurnRow, turn_id)
            if row is None:
                raise TurnNotFoundError(turn_id)
            for k, v in fields.items():
                if hasattr(row, k):
                    setattr(row, k, v)
        result = await self.get_turn(turn_id)
        if result is None:
            raise TurnNotFoundError(turn_id)
        return result

    async def next_turn_index(self, session_id: str) -> int:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            from sqlalchemy import func as sa_func
            result = await session.execute(
                select(sa_func.coalesce(sa_func.max(SessionTurnRow.turn_index), -1) + 1)
                .where(SessionTurnRow.session_id == session_id),
            )
            return result.scalar_one()

    async def append_messages(
        self, session_id: str, messages: list[Message], turn_index: int
    ) -> None:
        await self._ensure_initialized()
        async with self._session_factory() as session, session.begin():
            from sqlalchemy import func as sa_func
            seq_result = await session.execute(
                select(sa_func.coalesce(sa_func.max(SessionMessageRow.sequence), 0))
                .where(SessionMessageRow.session_id == session_id),
            )
            next_seq = seq_result.scalar_one()
            now = utc_now()
            for msg in messages:
                next_seq += 1
                row = SessionMessageRow(
                    session_id=session_id,
                    turn_index=turn_index,
                    sequence=next_seq,
                    role=msg.role.value,
                    content=msg.content,
                    reasoning_content=msg.reasoning_content,
                    tool_calls_json=json.dumps(
                        [tc.model_dump() for tc in msg.tool_calls],
                    )
                    if msg.tool_calls
                    else None,
                    tool_call_id=msg.tool_call_id,
                    name=msg.name,
                    raw_json=json.dumps(msg.raw) if msg.raw else None,
                    created_at=now,
                )
                session.add(row)

    async def get_messages(
        self, session_id: str, *, since_sequence: int = 0
    ) -> list[Message]:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            query = (
                select(SessionMessageRow)
                .where(SessionMessageRow.session_id == session_id)
                .order_by(SessionMessageRow.sequence.asc())
            )
            if since_sequence > 0:
                query = query.where(SessionMessageRow.sequence >= since_sequence)
            result = await session.execute(query)
            rows = result.scalars().all()
            return [self._row_to_message(row) for row in rows]

    async def get_messages_with_sequence(
        self, session_id: str, *, since_sequence: int = 0
    ) -> list[dict]:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            query = (
                select(SessionMessageRow)
                .where(SessionMessageRow.session_id == session_id)
                .order_by(SessionMessageRow.sequence.asc())
            )
            if since_sequence > 0:
                query = query.where(SessionMessageRow.sequence >= since_sequence)
            result = await session.execute(query)
            rows = result.scalars().all()
            return [self._row_to_message_dict(row) for row in rows]

    async def get_message_count(self, session_id: str) -> int:
        await self._ensure_initialized()
        async with self._session_factory() as session:
            from sqlalchemy import func as sa_func
            result = await session.execute(
                select(sa_func.count(SessionMessageRow.id))
                .where(SessionMessageRow.session_id == session_id),
            )
            return result.scalar_one()

    async def recover_stale_sessions(self) -> int:
        await self._ensure_initialized()
        now = utc_now()
        async with self._session_factory() as session, session.begin():
            turn_result = await session.execute(
                SessionTurnRow.__table__.update()
                .where(SessionTurnRow.status.in_(["running", "queued"]))
                .values(status="failed", failure_reason="server_restarted_during_turn", finished_at=now),
            )
            affected = turn_result.rowcount
            await session.execute(
                SessionRow.__table__.update()
                .where(SessionRow.status == "running")
                .values(status="idle", updated_at=now),
            )
        return affected or 0

    async def aclose(self) -> None:
        await self._engine.dispose()

    async def _count_messages(self, session: AsyncSession, session_id: str) -> int:
        from sqlalchemy import func as sa_func
        result = await session.execute(
            select(sa_func.count(SessionMessageRow.id))
            .where(SessionMessageRow.session_id == session_id),
        )
        return result.scalar_one()

    async def _count_turns(self, session: AsyncSession, session_id: str) -> int:
        from sqlalchemy import func as sa_func
        result = await session.execute(
            select(sa_func.count(SessionTurnRow.id))
            .where(SessionTurnRow.session_id == session_id),
        )
        return result.scalar_one()

    def _row_to_session_record(self, row: SessionRow) -> SessionRecord:
        return SessionRecord(
            id=row.id,
            status=row.status,
            title=row.title,
            last_user_input=row.last_user_input,
            workspace_root=row.workspace_root,
            mode=row.mode,
            system_prompt=row.system_prompt,
            provider=row.provider,
            model=row.model,
            tool_names=json.loads(row.tool_names_json)
            if row.tool_names_json is not None
            else None,
            max_iterations=row.max_iterations,
            max_tokens=row.max_tokens,
            created_at=row.created_at,
            updated_at=row.updated_at,
            archived_at=row.archived_at,
        )

    def _row_to_turn(self, row: SessionTurnRow) -> SessionTurn:
        return SessionTurn(
            id=row.id,
            session_id=row.session_id,
            run_id=row.run_id,
            turn_index=row.turn_index,
            user_input=row.user_input,
            status=row.status,
            failure_reason=row.failure_reason,
            usage_json=row.usage_json,
            created_at=row.created_at,
            started_at=row.started_at,
            finished_at=row.finished_at,
        )

    def _row_to_message(self, row: SessionMessageRow) -> Message:
        tool_calls = []
        if row.tool_calls_json:
            for tc_data in json.loads(row.tool_calls_json):
                tool_calls.append(ToolCall(**tc_data))
        return Message(
            role=Role(row.role),
            content=row.content,
            reasoning_content=row.reasoning_content,
            tool_calls=tool_calls,
            tool_call_id=row.tool_call_id,
            name=row.name,
            raw=json.loads(row.raw_json) if row.raw_json else None,
        )

    def _row_to_message_dict(self, row: SessionMessageRow) -> dict:
        msg = self._row_to_message(row)
        d = msg.model_dump()
        d["sequence"] = row.sequence
        d["turn_index"] = row.turn_index
        return d
