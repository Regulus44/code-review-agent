import { describe, expect, it } from "vitest";
import type { SkillDefinition } from "@coding-agent/contracts";
import { renderSkillContent, renderSkillContentV1, renderSkillContentV2 } from "./skill-catalog.js";

function definition(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "review",
    description: "Review code",
    content: "Check $ARGUMENTS",
    source: "local",
    provider: "fixture",
    trust: "local",
    invocation: { modelInvocable: true, userInvocable: true },
    ...overrides,
  };
}

describe("Skill content renderer", () => {
  it("renders the canonical v2 resource package envelope exactly", () => {
    expect(renderSkillContent(definition(), "the diff")).toBe([
      '<skill_content name="review">',
      "<skill_resources>",
      "Resources for this skill are available as a package.",
      'Use read_skill_resource with skill="review" and a Skill-relative path such as references/foo.md or scripts/check.ts.',
      "Load referenced resources only as needed; the directory is not preloaded.",
      "</skill_resources>",
      "",
      "<skill_instructions>",
      "Check the diff",
      "</skill_instructions>",
      "</skill_content>",
    ].join("\n"));
  });

  it("escapes the skill name in the wrapper and resource hint", () => {
    const rendered = renderSkillContentV2(definition({ name: 'x"&<>y' }), "");
    expect(rendered).toContain('<skill_content name="x&quot;&amp;&lt;&gt;y">');
    expect(rendered).toContain('skill="x&quot;&amp;&lt;&gt;y"');
  });

  it("does not expand arguments for remote or shell-expansion-disabled skills", () => {
    expect(renderSkillContentV2(definition({ trust: "remote" }), "secret")).toContain("Check $ARGUMENTS");
    expect(renderSkillContentV2(definition({ metadata: { disableShellExpansion: true } }), "secret")).toContain("Check $ARGUMENTS");
  });

  it("keeps the legacy v1 renderer available as an explicit rollback", () => {
    expect(renderSkillContentV1(definition(), "the diff")).toBe('<skill name="review" source="local">Check the diff</skill>');
    expect(renderSkillContent(definition(), "the diff", { version: "v1" })).toBe('<skill name="review" source="local">Check the diff</skill>');
  });
});
