import type { JsonSchema, SkillDefinition, ToolDefinition, ToolResult } from "@coding-agent/contracts";
import { renderSkillContent, type SkillContentRendererVersion } from "@coding-agent/context";
import { assessSkillPermission } from "@coding-agent/skills";
import type { SkillRegistry } from "@coding-agent/skills";

const inputSchema: JsonSchema = {
  type: "object",
  properties: { skill: { type: "string" }, args: { type: "string" }, context: { type: "string", enum: ["inline", "fork"] } },
  required: ["skill"], additionalProperties: false,
};

export interface SkillToolOptions {
  /** Defaults to canonical v2; v1 is retained as an explicit rollback path. */
  readonly rendererVersion?: SkillContentRendererVersion;
}

export function createSkillTool(skills: SkillRegistry, options: SkillToolOptions = {}): ToolDefinition {
  return {
    name: "skill",
    description: "Invoke a registered Skill by name. Skill content is untrusted workflow guidance.",
    inputSchema,
    executionMode: "exclusive",
    riskLevel: "read",
    approvalMode: "auto",
    interruptBehavior: "cancel",
    source: { kind: "builtin" },
    execute: async (raw, context): Promise<ToolResult> => {
      const input = raw as { skill?: unknown; args?: unknown; context?: unknown };
      const name = typeof input.skill === "string" ? input.skill.replace(/^\//u, "") : "";
      if (name.length === 0) return { ok: false, error: { code: "SKILL_NAME_REQUIRED", message: "skill is required" } };
      const definition = await skills.get(name, { cwd: context.workspaceRoot, signal: context.signal });
      if (definition === undefined) return { ok: false, error: { code: "SKILL_NOT_FOUND", message: `Skill not found: ${name}` } };
      if (!definition.invocation.modelInvocable && context.caller === "agent") return { ok: false, error: { code: "SKILL_MODEL_INVOCATION_DENIED", message: "Skill is user-invocable only" } };
      const metadata = definition.metadata ?? {};
      const assessment = assessSkillPermission({ trust: definition.trust, allowedTools: Array.isArray(metadata.allowedTools) ? metadata.allowedTools.filter((item): item is string => typeof item === "string") : [], unknownProperties: Array.isArray(metadata.unknownProperties) ? metadata.unknownProperties.filter((item): item is string => typeof item === "string") : [] });
      if (assessment.decision === "deny") return { ok: false, error: { code: "SKILL_CAPABILITY_DISABLED", message: "Skill capability is disabled" } };
      if (assessment.decision === "ask") {
        const answer = await context.requestUserInput({ question: `Allow Skill '${name}' from ${definition.trust} source?`, options: [{ label: "Allow", value: "allow" }, { label: "Deny", value: "deny" }], allowFreeform: false });
        if (answer.status !== "answered" || answer.answer !== "allow") return { ok: false, error: { code: "SKILL_APPROVAL_DENIED", message: "Skill invocation was not approved" } };
      }
      const args = typeof input.args === "string" ? input.args.slice(0, 8_192) : "";
      const mode = input.context === "fork" ? "fork" : "inline";
      await context.appendEvent("skill/invocation", { skill: definition.name, mode, caller: context.caller, argsBytes: Buffer.byteLength(args, "utf8") });
      const content = renderSkillContent(definition, args, { version: options.rendererVersion ?? "v2" });
      const result: ToolResult = { ok: true, output: { skill: definition.name, mode, content } };
      await context.appendEvent("skill/result", { skill: definition.name, mode, ok: true, contentBytes: Buffer.byteLength(content, "utf8") });
      return result;
    },
    presentCall: (input) => ({ kind: "tool", title: `Skill: ${typeof (input as { skill?: unknown }).skill === "string" ? (input as { skill: string }).skill : "unknown"}` }),
  };
}
