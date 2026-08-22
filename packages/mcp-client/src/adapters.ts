import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface McpContentBoundary {
  readonly trust: "untrusted-mcp-content";
  readonly modelView: string;
  readonly usage: { readonly bytes: number; readonly truncated: boolean };
}

export class McpResourceAdapter {
  constructor(private readonly client: Client) {}

  async read(uri: string, timeout = 120_000, signal?: AbortSignal): Promise<Awaited<ReturnType<Client["readResource"]>> & McpContentBoundary> {
    const result = await this.client.readResource({ uri }, { timeout, ...(signal === undefined ? {} : { signal }) });
    return { ...result, ...bound(result, 32_768) };
  }
}

export class McpPromptAdapter {
  constructor(private readonly client: Client) {}

  async get(name: string, args?: Readonly<Record<string, string>>, timeout = 120_000, signal?: AbortSignal): Promise<Awaited<ReturnType<Client["getPrompt"]>> & McpContentBoundary> {
    const result = await this.client.getPrompt({ name, ...(args === undefined ? {} : { arguments: { ...args } }) }, { timeout, ...(signal === undefined ? {} : { signal }) });
    return { ...result, ...bound(result, 32_768) };
  }
}

function bound(value: unknown, maxChars: number): McpContentBoundary {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { serialized = "[unserializable MCP content]"; }
  const truncated = serialized.length > maxChars;
  return {
    trust: "untrusted-mcp-content",
    modelView: truncated ? `${serialized.slice(0, maxChars)}…` : serialized,
    usage: { bytes: Buffer.byteLength(serialized), truncated },
  };
}
