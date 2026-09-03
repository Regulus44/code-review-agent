import type { JsonSchema, SkillDefinition, SkillLookupOptions, SkillResourceReadErrorCode, SkillResourceReadResult, ToolDefinition, ToolResult } from "@coding-agent/contracts";
import { assessSkillPermission, isSkillName, type SkillRegistry, SkillRegistryError } from "@coding-agent/skills";

const MAX_RESOURCE_LIMIT = 256 * 1024;
const MAX_RESOURCE_PATH = 4 * 1024;

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    skill: { type: "string", minLength: 1, maxLength: 128 },
    path: { type: "string", minLength: 1, maxLength: MAX_RESOURCE_PATH },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: MAX_RESOURCE_LIMIT },
  },
  required: ["skill", "path"],
  additionalProperties: false,
};

export interface SkillResourceToolOptions {
  readonly enabled?: boolean;
}

/** Model-facing, Skill-bound resource reader. It never accepts a host path. */
export function createSkillResourceTool(skills: SkillRegistry, options: SkillResourceToolOptions = {}): ToolDefinition {
  return {
    name: "read_skill_resource",
    description: "Read a bounded text resource from the named Skill package using a Skill-relative path. Resources are loaded only when explicitly requested; the directory is not enumerated or exposed as a workspace path.",
    inputSchema,
    executionMode: "parallel",
    riskLevel: "read",
    approvalMode: "auto",
    interruptBehavior: "cancel",
    source: { kind: "builtin" },
    execute: async (raw, context): Promise<ToolResult> => {
      if (options.enabled === false) return failure("SKILL_RESOURCE_TOOL_DISABLED", "Skill resource reading is disabled by host configuration.");
      const input = raw as { skill?: unknown; path?: unknown; offset?: unknown; limit?: unknown };
      const rawName = typeof input.skill === "string" ? input.skill.trim().replace(/^\//u, "") : "";
      if (!isSkillName(rawName)) return failure("SKILL_NAME_INVALID", "Skill name is invalid.");
      const resourcePath = typeof input.path === "string" ? input.path : "";
      const offset = input.offset === undefined ? undefined : Number(input.offset);
      const limit = input.limit === undefined ? undefined : Number(input.limit);
      if (resourcePath.trim() === "" || resourcePath.includes("\0") || resourcePath.startsWith("/") || resourcePath.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(resourcePath)) {
        return failure("SKILL_RESOURCE_INVALID_PATH", "Skill resource path must be relative.");
      }
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) return failure("SKILL_RESOURCE_INVALID_PATH", "Resource offset must be a non-negative integer.");
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESOURCE_LIMIT)) return failure("SKILL_RESOURCE_INVALID_PATH", "Resource limit is outside the supported bounds.");
      const lookup: SkillLookupOptions = { cwd: context.workspaceRoot };
      let definition: SkillDefinition | undefined;
      try {
        definition = await skills.get(rawName, { ...lookup, signal: context.signal });
      } catch (error) {
        return registryFailure(error);
      }
      if (definition === undefined) return failure("SKILL_RESOURCE_NOT_FOUND", `Skill not found: ${rawName}`);
      if (context.caller === "agent" && !definition.invocation.modelInvocable) return failure("SKILL_MODEL_INVOCATION_DENIED", "Skill is not model-invocable.");
      const metadata = definition.metadata ?? {};
      const assessment = assessSkillPermission({
        trust: definition.trust,
        allowedTools: Array.isArray(metadata.allowedTools) ? metadata.allowedTools.filter((item): item is string => typeof item === "string") : [],
        unknownProperties: Array.isArray(metadata.unknownProperties) ? metadata.unknownProperties.filter((item): item is string => typeof item === "string") : [],
      });
      if (assessment.decision === "deny") return failure("SKILL_CAPABILITY_DISABLED", "Skill resource capability is disabled.");
      if (assessment.decision === "ask") {
        const answer = await context.requestUserInput({ question: `Allow reading resource '${resourcePath}' from Skill '${rawName}' (${definition.trust} source)?`, options: [{ label: "Allow", value: "allow" }, { label: "Deny", value: "deny" }], allowFreeform: false });
        if (answer.status !== "answered" || answer.answer !== "allow") return failure("SKILL_APPROVAL_DENIED", "Skill resource read was not approved.");
      }
      try {
        const resource = await skills.readResource(rawName, { path: resourcePath, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }, { ...lookup, signal: context.signal });
        return resourceResult(rawName, resource);
      } catch (error) {
        return registryFailure(error);
      }
    },
    presentCall: (input) => {
      const value = input as { skill?: unknown; path?: unknown };
      const skill = typeof value.skill === "string" ? value.skill : "unknown";
      const resourcePath = typeof value.path === "string" ? value.path : "unknown";
      return { kind: "tool", title: `Read Skill resource ${skill}/${resourcePath}` };
    },
  };
}

function resourceResult(skill: string, resource: SkillResourceReadResult): ToolResult {
  const footer = resource.truncated === true ? "\n\n(Output capped. Use offset=... to continue.)" : "";
  const modelView = `<skill_resource skill=${JSON.stringify(skill)} path=${JSON.stringify(resource.path)}>\n${resource.content}${footer}\n</skill_resource>`;
  return {
    ok: true,
    output: { skill, path: resource.path, content: resource.content, sizeBytes: resource.sizeBytes, ...(resource.truncated === true ? { truncated: true } : {}), ...(resource.mediaType === undefined ? {} : { mediaType: resource.mediaType }) },
    modelView,
    presentation: { kind: "tool", title: `Skill resource: ${skill}/${resource.path}`, text: modelView, data: { skill, path: resource.path, sizeBytes: resource.sizeBytes, ...(resource.truncated === true ? { truncated: true } : {}) } },
  };
}

function failure(code: string, message: string): ToolResult { return { ok: false, error: { code, message } }; }

function registryFailure(error: unknown): ToolResult {
  if (error instanceof SkillRegistryError) return failure(error.code, registryMessage(error.code as SkillResourceReadErrorCode | string));
  if (error instanceof Error && error.name === "AbortError") return failure("TOOL_CANCELLED", "Skill resource read was cancelled.");
  return failure("SKILL_RESOURCE_FAILED", "Skill resource read failed.");
}

function registryMessage(code: SkillResourceReadErrorCode | string): string {
  switch (code) {
    case "SKILL_RESOURCE_UNSUPPORTED": return "Skill provider does not support resources.";
    case "SKILL_RESOURCE_INVALID_PATH": return "Skill resource path is invalid.";
    case "SKILL_RESOURCE_NOT_FOUND": return "Skill resource was not found.";
    case "SKILL_RESOURCE_TOO_LARGE": return "Skill resource exceeds the read limit.";
    case "SKILL_NAME_INVALID": return "Skill name is invalid.";
    default: return "Skill resource read failed.";
  }
}
