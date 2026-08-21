import type { ToolDefinition, ToolResult, JsonSchema, ToolRiskLevel } from "@code-review-agent/contracts";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolRegistry } from "@code-review-agent/tools";
import type { McpServerConfig } from "./config.js";
import type { McpToolDescriptor } from "./discovery.js";

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/gu;

export interface McpToolRegistration {
  readonly definition: ToolDefinition;
  readonly rawName: string;
}

export function publicToolName(serverName: string, rawName: string): string {
  const identity = `mcp__${serverName}__${rawName}`;
  const normalized = identity.replace(INVALID_NAME_CHARS, "_");
  if (normalized === identity && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  // Stable, bounded collision suffix without exposing raw secrets in the name.
  let hash = 0;
  for (const char of `${serverName}\u0000${rawName}`) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const suffix = hash.toString(16).padStart(8, "0");
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
}

export function createMcpToolRegistrations(
  client: Client,
  serverName: string,
  config: McpServerConfig,
  tools: readonly McpToolDescriptor[],
): readonly McpToolRegistration[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    const name = publicToolName(serverName, tool.name);
    if (names.has(name)) throw new Error(`MCP server ${serverName} has duplicate tool identity: ${tool.name}`);
    names.add(name);
    const definition: ToolDefinition = {
      name,
      description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
      inputSchema: normalizeJsonSchema(tool.inputSchema),
      executionMode: "parallel",
      riskLevel: resolveRisk(config, tool),
      approvalMode: "auto",
      interruptBehavior: "cancel",
      source: { kind: "mcp", serverName, rawName: tool.name },
      execute: async (input, context) => executeMcpTool(client, tool.name, input, context.signal, context.reportProgress, config.toolCallTimeoutMs ?? 120_000),
    };
    return { definition, rawName: tool.name };
  });
}

export function registerMcpTools(registry: ToolRegistry, registrations: readonly McpToolRegistration[]): readonly string[] {
  const registered: string[] = [];
  try {
    for (const item of registrations) {
      registry.register(item.definition);
      registered.push(item.definition.name);
    }
    return registered;
  } catch (error) {
    for (const name of registered) registry.unregister(name);
    throw error;
  }
}

export function unregisterMcpTools(registry: ToolRegistry, names: readonly string[]): void {
  for (const name of names) registry.unregister(name);
}

async function executeMcpTool(
  client: Client,
  rawName: string,
  input: unknown,
  signal: AbortSignal,
  reportProgress: (payload: Readonly<Record<string, unknown>>) => Promise<void>,
  timeout: number,
): Promise<ToolResult> {
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  try {
    const result = await client.callTool(
      { name: rawName, arguments: args },
      CallToolResultSchema,
      {
        signal,
        timeout,
        onprogress: (progress) => { void reportProgress({ source: "mcp", rawTool: rawName, progress: { ...progress } }); },
        resetTimeoutOnProgress: true,
      },
    );
    const content = Array.isArray(result.content) ? result.content as readonly unknown[] : [];
    const text = extractText(content);
    const output = {
      content,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    };
    if (result.isError === true) {
      return {
        ok: false,
        output,
        audit: output,
        modelView: text,
        error: { code: "MCP_TOOL_ERROR", message: text || `MCP tool ${rawName} returned an error` },
        presentation: { kind: "tool", title: `MCP ${rawName} failed`, text },
      };
    }
    return { ok: true, output, audit: output, modelView: text, presentation: { kind: "tool", title: `MCP ${rawName}`, text } };
  } catch (error) {
    const code = isAbortError(error) ? "MCP_CANCELLED" : "MCP_REQUEST_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(message);
    Object.assign(wrapped, { code });
    throw wrapped;
  }
}

function resolveRisk(config: McpServerConfig, tool: McpToolDescriptor): ToolRiskLevel {
  if (config.riskLevel !== undefined) return config.riskLevel;
  const annotations = tool.annotations ?? {};
  if (annotations["readOnlyHint"] === true || annotations["read_only"] === true) return "read";
  if (annotations["destructiveHint"] === true || annotations["destructive"] === true) return "write";
  return "network";
}

function normalizeJsonSchema(value: unknown): JsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { type: "object", additionalProperties: true };
  const input = value as Record<string, unknown>;
  const typeValue = input["type"];
  const type = typeValue === "object" || typeValue === "array" || typeValue === "string" || typeValue === "number" || typeValue === "integer" || typeValue === "boolean" || typeValue === "null" ? typeValue : undefined;
  const properties = input["properties"];
  const required = input["required"];
  const enumValue = input["enum"];
  const items = input["items"];
  return {
    ...(type === undefined ? {} : { type }),
    ...(properties !== null && typeof properties === "object" && !Array.isArray(properties) ? { properties: Object.fromEntries(Object.entries(properties as Record<string, unknown>).map(([key, schema]) => [key, normalizeJsonSchema(schema)])) } : {}),
    ...(Array.isArray(required) ? { required: required.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof input["additionalProperties"] === "boolean" ? { additionalProperties: input["additionalProperties"] } : {}),
    ...(items === undefined ? {} : { items: normalizeJsonSchema(items) }),
    ...(Array.isArray(enumValue) ? { enum: enumValue } : {}),
    ...(typeof input["minLength"] === "number" ? { minLength: input["minLength"] } : {}),
    ...(typeof input["maxLength"] === "number" ? { maxLength: input["maxLength"] } : {}),
    ...(typeof input["minimum"] === "number" ? { minimum: input["minimum"] } : {}),
    ...(typeof input["maximum"] === "number" ? { maximum: input["maximum"] } : {}),
    ...(typeof input["pattern"] === "string" ? { pattern: input["pattern"] } : {}),
    ...(typeof input["minItems"] === "number" ? { minItems: input["minItems"] } : {}),
    ...(typeof input["maxItems"] === "number" ? { maxItems: input["maxItems"] } : {}),
  };
}

function extractText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      parts.push("[unsupported MCP content]");
      continue;
    }
    const block = item as Record<string, unknown>;
    if (block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"]);
    else if (block["type"] === "image") parts.push(`[image: ${typeof block["mimeType"] === "string" ? block["mimeType"] : "unknown"}]`);
    else if (block["type"] === "audio") parts.push(`[audio: ${typeof block["mimeType"] === "string" ? block["mimeType"] : "unknown"}]`);
    else if (block["type"] === "resource" || block["type"] === "resource_link") parts.push("[resource]");
    else parts.push(`[${String(block["type"] ?? "unknown")}]`);
  }
  return parts.join("\n");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|cancelled|canceled/iu.test(error.message));
}
