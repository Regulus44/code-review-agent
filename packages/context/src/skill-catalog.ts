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

export type SkillContentRendererVersion = "v1" | "v2";

export interface SkillContentRenderOptions {
  /** Renderer shape; v2 is the canonical default and v1 is a rollback path. */
  readonly version?: SkillContentRendererVersion;
}

/**
 * Canonical renderer for invoked Skill content. The v2 shape makes the Skill
 * resource package explicit without exposing a provider-owned host path.
 * User arguments remain data and are not expanded for remote or explicitly
 * shell-expansion-disabled definitions.
 */
export function renderSkillContent(
  definition: SkillDefinition,
  args = "",
  options: SkillContentRenderOptions = {},
): string {
  return options.version === "v1"
    ? renderSkillContentV1(definition, args)
    : renderSkillContentV2(definition, args);
}

/** Legacy renderer retained for transcript/tool compatibility and rollback. */
export function renderSkillContentV1(definition: SkillDefinition, args = ""): string {
  const body = renderSkillBody(definition, args);
  return `<skill name=${JSON.stringify(definition.name)} source=${JSON.stringify(definition.source)}>${body}</skill>`;
}

/** Canonical v2 renderer shared by context injection and SkillTool results. */
export function renderSkillContentV2(definition: SkillDefinition, args = ""): string {
  const name = escapeAttr(definition.name);
  const skillReference = escapeAttr(definition.name);
  return [
    `<skill_content name="${name}">`,
    "<skill_resources>",
    "Resources for this skill are available as a package.",
    `Use read_skill_resource with skill="${skillReference}" and a Skill-relative path such as references/foo.md or scripts/check.ts.`,
    "Load referenced resources only as needed; the directory is not preloaded.",
    "</skill_resources>",
    "",
    "<skill_instructions>",
    renderSkillBody(definition, args),
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}

function renderSkillBody(definition: SkillDefinition, args: string): string {
  const metadata = definition.metadata ?? {};
  if (definition.trust === "remote" || metadata.disableShellExpansion === true) return definition.content;
  return definition.content.replace(/\$\{?ARGUMENTS\}?/gu, args);
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
