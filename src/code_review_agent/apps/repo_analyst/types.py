"""Types for the repository analyst app."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.harness import AgentRunResult
from code_review_agent.runtime import RunDiagnostics, RunEvent, RunRecord


class RepoModule(BaseModel):
    """One logical module found in the repository."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str


class RepoAnalystReport(BaseModel):
    """Structured output of the repository analyst app."""

    model_config = ConfigDict(extra="forbid")

    summary: str
    modules: list[RepoModule]
    architecture: list[str]
    risks: list[str]
    next_steps: list[str]


RepoAnalystMode = Literal["overview", "review"]


class RepoReviewTestResult(BaseModel):
    """Test execution summary for review mode."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["passed", "failed", "not_run", "unknown"]
    command: str | None = None
    exit_code: int | None = None
    summary: str


class RepoReviewFinding(BaseModel):
    """One code review finding."""

    model_config = ConfigDict(extra="forbid")

    severity: Literal["critical", "high", "medium", "low", "info"]
    file: str | None = None
    line: int | None = Field(default=None, ge=1)
    title: str
    description: str
    suggestion: str


class RepoReviewReport(BaseModel):
    """Structured output of review mode."""

    model_config = ConfigDict(extra="forbid")

    summary: str
    changed_files: list[str]
    test_result: RepoReviewTestResult
    findings: list[RepoReviewFinding]
    risks: list[str]
    next_steps: list[str]


class RepoAnalystRequest(BaseModel):
    """API request for repo analyst runs."""

    model_config = ConfigDict(extra="forbid")

    workspace_root: str
    question: str | None = None
    mode: RepoAnalystMode = "overview"
    max_iterations: int = 100
    temperature: float | None = None
    max_tokens: int | None = None
    provider: str | None = None
    model: str | None = None
    enabled_tools: list[str] | None = None


class RepoAnalystRunResult(BaseModel):
    """App-level result returned by the repo analyst service."""

    model_config = ConfigDict(extra="forbid")

    id: str
    status: str
    mode: RepoAnalystMode = "overview"
    report_type: RepoAnalystMode = "overview"
    workspace_root: str
    question: str
    created_at: RunRecord.model_fields["created_at"].annotation
    started_at: RunRecord.model_fields["started_at"].annotation = None
    finished_at: RunRecord.model_fields["finished_at"].annotation = None
    report: RepoAnalystReport | None = None
    review_report: RepoReviewReport | None = None
    result: AgentRunResult | None = None
    failure_reason: str | None = None
    parse_diagnostics: "RepoAnalystParseDiagnostics | None" = None
    diagnostics: RunDiagnostics | None = None
    provider: str | None = None
    model: str | None = None
    tool_names: list[str] | None = None


class RepoAnalystParseDiagnostics(BaseModel):
    """Minimal diagnostics for strict repo analyst parsing failures."""

    model_config = ConfigDict(extra="forbid")

    code: str
    message: str


class RepoAnalystRunView(BaseModel):
    """App-level run view with events."""

    model_config = ConfigDict(extra="forbid")

    run: RepoAnalystRunResult
    events: list[RunEvent] = Field(default_factory=list)
