import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPromptDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly { readonly name: string; readonly description?: string; readonly required?: boolean }[];
}

export interface McpDiscoverySnapshot {
  readonly tools: readonly McpToolDescriptor[];
  readonly resources: readonly McpResourceDescriptor[];
  readonly prompts: readonly McpPromptDescriptor[];
}

/** Exhausts cursor pagination for one MCP list method. */
async function collect<T extends { nextCursor?: string | undefined }>(fetchPage: (cursor?: string) => Promise<T>, field: string): Promise<unknown[]> {
  const values: unknown[] = [];
  const cursors = new Set<string>();
  const maxPages = 128;
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > maxPages) throw new Error(`MCP ${field} pagination exceeded ${maxPages} pages`);
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error(`MCP ${field} pagination cursor repeated`);
      cursors.add(cursor);
    }
    const page = await fetchPage(cursor);
    const items = (page as Record<string, unknown>)[field];
    if (Array.isArray(items)) {
      if (values.length + items.length > 10_000) throw new Error(`MCP ${field} catalog exceeded 10000 entries`);
      values.push(...items);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor !== "");
  return values;
}

/** Discover all MCP catalogs. Tools are required; resources/prompts are optional capabilities. */
export async function discover(client: Client): Promise<McpDiscoverySnapshot> {
  const tools = await collect((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), "tools") as McpToolDescriptor[];
  const resources = await optionalList(() => collect((cursor) => client.listResources(cursor === undefined ? undefined : { cursor }), "resources")) as McpResourceDescriptor[];
  const prompts = await optionalList(() => collect((cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }), "prompts")) as McpPromptDescriptor[];
  validateNames(tools, "tool");
  validateNames(resources, "resource");
  validateNames(prompts, "prompt");
  return { tools, resources, prompts };
}

function validateNames(items: readonly unknown[], kind: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "object" || item === null) throw new Error(`MCP ${kind} descriptor is not an object`);
    const name = typeof (item as Record<string, unknown>)["name"] === "string"
      ? String((item as Record<string, unknown>)["name"])
      : typeof (item as Record<string, unknown>)["uri"] === "string" ? String((item as Record<string, unknown>)["uri"]) : "";
    if (name.length === 0 || name.length > 512) throw new Error(`MCP ${kind} identity is invalid`);
    if (seen.has(name)) throw new Error(`MCP ${kind} identity duplicated: ${name}`);
    seen.add(name);
  }
}

async function optionalList(fetch: () => Promise<unknown[]>): Promise<unknown[]> {
  try { return await fetch(); } catch (error) {
    if (isUnsupportedMethod(error)) return [];
    throw error;
  }
}

function isUnsupportedMethod(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === -32601 || /method not found|not supported|unsupported/iu.test(message);
}
