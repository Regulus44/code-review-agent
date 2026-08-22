import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./config.js";
import type { McpCredentialReference } from "@code-review-agent/contracts";

export interface McpCredentialMaterial {
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export type McpCredentialResolver = (reference: McpCredentialReference) => McpCredentialMaterial | Promise<McpCredentialMaterial | undefined> | undefined;

export type McpTransportFactory = (config: McpServerConfig) => Transport | Promise<Transport>;

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/iu;

/** Remove ambient credential-shaped values before spawning an MCP child process. */
export function scrubParentEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !SECRET_KEY.test(key))) as Record<string, string>;
}

export function createMcpTransport(config: McpServerConfig): Transport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command as string,
      args: [...(config.args ?? [])],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      env: { ...scrubParentEnvironment(), ...(config.env ?? {}) },
      stderr: "pipe",
    });
  }
  if (config.transport === "sse") {
    return new SSEClientTransport(new URL(config.url as string), {
      requestInit: { headers: { ...(config.headers ?? {}) } },
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url as string), {
    requestInit: { headers: { ...(config.headers ?? {}) } },
  }) as Transport;
}
