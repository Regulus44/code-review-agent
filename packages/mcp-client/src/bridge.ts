import { createHash } from "node:crypto";
import { brand, type ToolApprovalMode, type ToolDefinition, type ToolResult, type JsonSchema, type ToolRiskLevel } from "@coding-agent/contracts";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolRegistry } from "@coding-agent/tools";
import type { McpServerConfig } from "./config.js";
import type { McpToolDescriptor } from "./discovery.js";

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/gu;

export interface McpToolRegistration {
  readonly definition: ToolDefinition;
  readonly rawName: string;
  readonly schemaWarning?: string;
}

export function publicToolName(serverName: string, rawName: string): string {
  const identity = `mcp__${serverName}__${rawName}`;
  const normalized = identity.replace(INVALID_NAME_CHARS, "_");
  if (normalized === identity && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  // DSH-aligned deterministic identity: stable across processes and runtimes.
  const suffix = createHash("sha256").update(`${serverName}\u0000${rawName}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
}

export function createMcpToolRegistrations(
  client: Client,
  serverName: string,
  config: McpServerConfig,
  tools: readonly McpToolDescriptor[],
): readonly McpToolRegistration[] {
  const names = new Set<string>();
  return tools.flatMap((tool) => {
    if (config.toolAllowlist !== undefined && !config.toolAllowlist.includes(tool.name)) return [];
    if (config.toolPolicies?.[tool.name]?.enabled === false) return [];
    const name = publicToolName(serverName, tool.name);
    if (names.has(name)) throw new Error(`MCP server ${serverName} has duplicate tool identity: ${tool.name}`);
    names.add(name);
    const definition: ToolDefinition = {
      name,
      description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
      inputSchema: normalizeJsonSchema(tool.inputSchema),
      executionMode: "parallel",
      riskLevel: resolveRisk(config, tool),
      approvalMode: resolveApproval(config, tool),
      interruptBehavior: "cancel",
      source: { kind: "mcp", serverName, rawName: tool.name, ...(config.tenantId === undefined ? {} : { tenantId: brand<string, "TenantId">(config.tenantId) }) },
      execute: async (input, context) => executeMcpTool(client, tool.name, input, context.signal, context.reportProgress, config.toolCallTimeoutMs ?? 120_000),
    };
    const warning = schemaWarning(tool.inputSchema);
    return { definition, rawName: tool.name, ...(warning === undefined ? {} : { schemaWarning: warning }) };
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

export function replaceMcpTools(registry: ToolRegistry, previousNames: readonly string[], registrations: readonly McpToolRegistration[]): readonly string[] {
  registry.replace(previousNames, registrations.map((item) => item.definition));
  return registrations.map((item) => item.definition.name);
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
  const override = config.toolPolicies?.[tool.name]?.riskLevel;
  if (override !== undefined) return override;
  if (config.riskLevel !== undefined) return config.riskLevel;
  const annotations = tool.annotations ?? {};
  if (annotations["readOnlyHint"] === true || annotations["read_only"] === true) return "read";
  if (annotations["destructiveHint"] === true || annotations["destructive"] === true) return "write";
  return "network";
}

function resolveApproval(config: McpServerConfig, tool: McpToolDescriptor): ToolApprovalMode {
  const override = config.toolPolicies?.[tool.name]?.approvalMode;
  if (override !== undefined) return override;
  return resolveRisk(config, tool) === "read" ? "auto" : "ask";
}

function normalizeJsonSchema(value: unknown): JsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { type: "object", additionalProperties: true, "x-mcp-schema-fallback": "invalid-root" };
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return { type: "object", additionalProperties: true, "x-mcp-schema-fallback": "schema-not-serializable" }; }
  if (encoded.length > 262_144) return { type: "object", additionalProperties: true, "x-mcp-schema-fallback": "schema-too-large" };
  return cloneSchemaValue(value, 0) as JsonSchema;
}

function cloneSchemaValue(value: unknown, depth: number): unknown {
  if (depth > 32) return { type: "object", additionalProperties: true, "x-mcp-schema-fallback": "schema-too-deep" };
  if (Array.isArray(value)) return value.slice(0, 512).map((item) => cloneSchemaValue(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneSchemaValue(item, depth + 1)]));
}

function schemaWarning(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid-root";
  try {
    if (JSON.stringify(value).length > 262_144) return "schema-too-large";
  } catch {
    return "schema-not-serializable";
  }
  return undefined;
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
