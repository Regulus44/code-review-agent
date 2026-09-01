import type { SkillCatalogSnapshot, SkillDefinition, SkillSummary } from "@coding-agent/contracts";

export interface SkillCatalogBudget {
  readonly maxChars: number;
  readonly maxDescriptionChars?: number;
}

export interface SkillCatalogProjection {
  readonly version: 1;
  readonly digest: string;
  readonly complete: boolean;
  readonly rendered: string;
  readonly skills: readonly SkillSummary[];
}

/** Deterministic bounded catalog renderer. Bodies and paths are never rendered. */
export function renderSkillCatalog(snapshot: SkillCatalogSnapshot, budget: SkillCatalogBudget = { maxChars: 8_000 }): SkillCatalogProjection {
  const max = Math.max(0, Math.floor(budget.maxChars));
  const descMax = Math.max(1, Math.floor(budget.maxDescriptionChars ?? 250));
  const ordered = snapshot.skills.filter((skill) => skill.invocation.modelInvocable).sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const skill of ordered) {
    const description = skill.description.slice(0, descMax);
    const line = `/${skill.name}: ${description}`;
    if ([...lines, line].join("\n").length <= max) lines.push(line);
    else if (!lines.some((item) => item === `/${skill.name}`) && [...lines, `/${skill.name}`].join("\n").length <= max) lines.push(`/${skill.name}`);
  }
  const rendered = lines.join("\n");
  return { version: 1, digest: skillCatalogDigest(snapshot), complete: snapshot.complete, rendered, skills: ordered };
}

export function skillCatalogDigest(snapshot: Pick<SkillCatalogSnapshot, "revision" | "complete" | "skills">): string {
  const value = JSON.stringify({ revision: snapshot.revision, complete: snapshot.complete, skills: snapshot.skills.filter((skill) => skill.invocation.modelInvocable).sort((a, b) => a.name.localeCompare(b.name)) });
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `skillcat_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Canonical renderer for invoked Skill content; user arguments are data. */
export function renderSkillContent(definition: SkillDefinition, args = ""): string {
  const body = definition.content.replace(/\$\{?ARGUMENTS\}?/gu, args);
  return `<skill name=${JSON.stringify(definition.name)} source=${JSON.stringify(definition.source)}>${body}</skill>`;
}
