"""Load declarative skills from package resources."""

from __future__ import annotations

from functools import lru_cache
from importlib import resources
import json

from .types import SkillDefinition, SkillDescriptor


class SkillCatalog:
    """In-memory registry of loaded skills."""

    def __init__(self, skills: list[SkillDefinition]) -> None:
        self._skills = {skill.name: skill for skill in skills}

    def list(self) -> list[SkillDefinition]:
        """Return full skill definitions sorted by routing priority and name."""
        return sorted(
            self._skills.values(),
            key=lambda skill: (-skill.routing.priority, skill.name),
        )

    def descriptors(self) -> list[SkillDescriptor]:
        """Return public descriptors without full skill prompts."""
        return [
            SkillDescriptor(**skill.model_dump(exclude={"prompt"}))
            for skill in self.list()
        ]

    def get(self, name: str) -> SkillDefinition | None:
        """Return one skill by name."""
        return self._skills.get(name)

    def require(self, name: str) -> SkillDefinition:
        """Return one skill or raise ValueError."""
        skill = self.get(name)
        if skill is None:
            raise ValueError(f"unknown skill: {name}")
        return skill


@lru_cache(maxsize=1)
def load_builtin_skill_catalog() -> SkillCatalog:
    """Load built-in skills packaged under ``skills/catalog``."""
    root = resources.files("code_review_agent.skills").joinpath("catalog")
    skills: list[SkillDefinition] = []
    if not root.is_dir():
        return SkillCatalog([])

    for child in sorted(root.iterdir(), key=lambda item: item.name):
        if not child.is_dir():
            continue
        metadata_path = child.joinpath("skill.json")
        prompt_path = child.joinpath("SKILL.md")
        if not metadata_path.is_file() or not prompt_path.is_file():
            continue

        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        prompt = prompt_path.read_text(encoding="utf-8").strip()
        skills.append(SkillDefinition(**metadata, prompt=prompt))

    return SkillCatalog(skills)
