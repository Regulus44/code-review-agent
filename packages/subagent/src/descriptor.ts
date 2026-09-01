import type { AgentEvent, SubagentDescriptor, SubagentMode, PermissionPreset, SessionId, TaskId } from "@coding-agent/contracts";

export const SUBAGENT_DESCRIPTOR_VERSION = 1 as const;

export type DescriptorInput = Omit<SubagentDescriptor, "version" | "childSessionId"> & {
  readonly childSessionId: SessionId;
};

export class DescriptorError extends Error {
  readonly code: "DESCRIPTOR_INVALID" | "DESCRIPTOR_UNKNOWN_VERSION";

  constructor(code: "DESCRIPTOR_INVALID" | "DESCRIPTOR_UNKNOWN_VERSION", message: string) {
    super(message);
    this.name = "DescriptorError";
    this.code = code;
  }
}

const baseKeys = new Set([
  "version", "mode", "provider", "label", "parentTaskId", "parentSessionId", "childSessionId",
  "workspaceRoot", "permissionPreset", "toolAllowlist", "mcpAllowlist", "model", "delegationDepth",
]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DescriptorError("DESCRIPTOR_INVALID", "Subagent descriptor must be an object");
  return value as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, key: string, required = true): string | undefined {
  if (!Object.hasOwn(input, key)) {
    if (required) throw new DescriptorError("DESCRIPTOR_INVALID", `Subagent descriptor field ${key} is required`);
    return undefined;
  }
  if (typeof input[key] !== "string" || input[key].length === 0) throw new DescriptorError("DESCRIPTOR_INVALID", `Subagent descriptor field ${key} must be a non-empty string`);
  return input[key] as string;
}

function stringArrayField(input: Record<string, unknown>, key: string): readonly string[] | undefined {
  if (!Object.hasOwn(input, key)) return undefined;
  if (!Array.isArray(input[key]) || (input[key] as unknown[]).some((item) => typeof item !== "string" || item.length === 0)) {
    throw new DescriptorError("DESCRIPTOR_INVALID", `Subagent descriptor field ${key} must be an array of non-empty strings`);
  }
  return [...input[key] as string[]];
}

function modeField(value: unknown): SubagentMode {
  if (value !== "one-shot" && value !== "continuable") throw new DescriptorError("DESCRIPTOR_INVALID", "Subagent descriptor mode must be one-shot or continuable");
  return value;
}

function permissionField(value: unknown): PermissionPreset {
  if (value !== "read-only" && value !== "workspace-write" && value !== "ask-on-write" && value !== "ask-on-execute" && value !== "workspace-full-access" && value !== "danger-full-access") throw new DescriptorError("DESCRIPTOR_INVALID", "Subagent descriptor permissionPreset is invalid");
  return value;
}

export function validateDescriptor(value: unknown): SubagentDescriptor | undefined {
  const input = record(value);
  if (input["version"] !== SUBAGENT_DESCRIPTOR_VERSION) {
    if (typeof input["version"] === "number") return undefined;
    throw new DescriptorError("DESCRIPTOR_INVALID", "Subagent descriptor version must be a number");
  }
  const unknown = Object.keys(input).find((key) => !baseKeys.has(key));
  if (unknown !== undefined) throw new DescriptorError("DESCRIPTOR_INVALID", `Subagent descriptor has unknown field ${unknown}`);
  const mode = modeField(input["mode"]);
  const provider = stringField(input, "provider")!;
  const parentSessionId = stringField(input, "parentSessionId") as SessionId;
  const childSessionId = stringField(input, "childSessionId") as SessionId;
  const workspaceRoot = stringField(input, "workspaceRoot")!;
  const permissionPreset = permissionField(input["permissionPreset"]);
  const delegationDepth = input["delegationDepth"];
  if (typeof delegationDepth !== "number" || !Number.isInteger(delegationDepth) || delegationDepth < 0) throw new DescriptorError("DESCRIPTOR_INVALID", "Subagent descriptor delegationDepth must be a non-negative integer");
  const label = stringField(input, "label", false);
  const model = stringField(input, "model", false);
  const parentTaskId = stringField(input, "parentTaskId", false) as TaskId | undefined;
  const toolAllowlist = stringArrayField(input, "toolAllowlist");
  const mcpAllowlist = stringArrayField(input, "mcpAllowlist");
  return {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode,
    provider,
    ...(label === undefined ? {} : { label }),
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    parentSessionId,
    childSessionId,
    workspaceRoot,
    permissionPreset,
    ...(toolAllowlist === undefined ? {} : { toolAllowlist }),
    ...(mcpAllowlist === undefined ? {} : { mcpAllowlist }),
    ...(model === undefined ? {} : { model }),
    delegationDepth,
  };
}

export function snapshotDescriptor(input: DescriptorInput): SubagentDescriptor {
  const candidate = { version: SUBAGENT_DESCRIPTOR_VERSION, ...input };
  const validated = validateDescriptor(candidate);
  if (validated === undefined) throw new DescriptorError("DESCRIPTOR_UNKNOWN_VERSION", "Subagent descriptor version is not supported");
  return structuredClone(validated);
}

export function foldSubagentDescriptor(events: readonly AgentEvent[]): SubagentDescriptor | undefined {
  const event = events.find((item) => item.type === "subagent/descriptor");
  if (event === undefined) return undefined;
  const payload = event.payload["descriptor"] ?? event.payload;
  return validateDescriptor(payload);
}
