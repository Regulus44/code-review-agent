import type { SkillCatalogSnapshot, SkillSummary } from "@coding-agent/contracts";

export interface SkillRowIntent {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly trust: string;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  readonly marker: string;
}

/** Bounded read-only catalog rows; no Skill body or filesystem path is exposed. */
export function presentSkillCatalog(catalog: SkillCatalogSnapshot): { readonly complete: boolean; readonly revision: number; readonly rows: readonly SkillRowIntent[]; readonly suggestions: readonly SkillRowIntent[] } {
  const rows = catalog.skills.map(skillRow);
  return { complete: catalog.complete, revision: catalog.revision, rows, suggestions: rows.slice(0, 8) };
}

function skillRow(skill: SkillSummary): SkillRowIntent {
  const marker = skill.invocation.userInvocable && !skill.invocation.modelInvocable ? "仅用户" : skill.invocation.modelInvocable ? "可调用" : "禁用";
  return { name: skill.name, description: skill.description, source: skill.source, trust: skill.trust, modelInvocable: skill.invocation.modelInvocable, userInvocable: skill.invocation.userInvocable, marker };
}
