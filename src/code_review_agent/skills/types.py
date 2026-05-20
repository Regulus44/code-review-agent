"""Types for declarative skills."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class SkillRouting(BaseModel):
    """Lightweight routing hints shown to the skill router."""

    model_config = ConfigDict(extra="forbid")

    intents: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    file_globs: list[str] = Field(default_factory=list)
    priority: int = 0


class SkillDescriptor(BaseModel):
    """Public skill metadata, excluding the full prompt body."""

    model_config = ConfigDict(extra="forbid")

    name: str
    display_name: str
    description: str
    routing: SkillRouting = Field(default_factory=SkillRouting)
    tools: list[str] = Field(default_factory=list)
    default_max_iterations: int | None = None
    default_max_tokens: int | None = None


class SkillDefinition(SkillDescriptor):
    """Full skill definition loaded from package resources."""

    prompt: str
