import type { ToolRiskLevel } from "@code-review-agent/contracts";

export type McpServerScope = "user" | "project" | "session";
export type McpTransportKind = "stdio" | "sse" | "streamable-http";
export type McpServerStatus = "pending" | "connected" | "failed" | "needs_auth" | "disabled" | "stopped";

export interface McpReconnectPolicy {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

export interface McpServerConfig {
  readonly name: string;
  readonly scope: McpServerScope;
  readonly transport: McpTransportKind;
  readonly enabled?: boolean;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Conservative default is network; callers may explicitly choose read/write/execute. */
  readonly riskLevel?: ToolRiskLevel;
  readonly toolCallTimeoutMs?: number;
  readonly reconnect?: McpReconnectPolicy;
  /** If true, initial connection failure rejects add/start; otherwise it is reported as failed. */
  readonly failOnStartupError?: boolean;
}

export interface McpServerPublicConfig extends Omit<McpServerConfig, "env" | "headers"> {
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface McpServerRecord {
  readonly config: McpServerPublicConfig;
  readonly status: McpServerStatus;
  readonly toolNames: readonly string[];
  readonly discoveredAt?: string;
  readonly lastError?: string;
  readonly reconnectAttempt: number;
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/iu;

function validateName(name: string): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) throw new Error("MCP server name must match [A-Za-z0-9_-]{1,32}");
}

function cloneMap(value: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  return value === undefined ? undefined : { ...value };
}

function sanitizeMap(value: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : item]));
}

/** In-memory config registry. It never exposes credential values through public views or event payloads. */
export class McpConfigStore {
  private readonly configs = new Map<string, McpServerConfig>();

  constructor(initial: readonly McpServerConfig[] = []) {
    for (const config of initial) this.upsert(config);
  }

  upsert(config: McpServerConfig): McpServerConfig {
    validateName(config.name);
    validateConfig(config);
    const normalized: McpServerConfig = {
      ...config,
      enabled: config.enabled ?? true,
      ...(config.args === undefined ? {} : { args: [...config.args] }),
      ...(config.env === undefined ? {} : { env: cloneMap(config.env) as Record<string, string> }),
      ...(config.headers === undefined ? {} : { headers: cloneMap(config.headers) as Record<string, string> }),
    };
    this.configs.set(config.name, normalized);
    return normalized;
  }

  get(name: string): McpServerConfig | undefined {
    return this.configs.get(name);
  }

  list(scope?: McpServerScope): readonly McpServerConfig[] {
    return [...this.configs.values()]
      .filter((config) => scope === undefined || config.scope === scope)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  remove(name: string): boolean {
    return this.configs.delete(name);
  }

  setEnabled(name: string, enabled: boolean): McpServerConfig {
    const existing = this.configs.get(name);
    if (existing === undefined) throw new Error(`Unknown MCP server: ${name}`);
    const next = { ...existing, enabled };
    this.configs.set(name, next);
    return next;
  }

  publicView(config: McpServerConfig): McpServerPublicConfig {
    const { env, headers, ...rest } = config;
    return {
      ...rest,
      ...(env === undefined ? {} : { env: sanitizeMap(env) as Record<string, string> }),
      ...(headers === undefined ? {} : { headers: sanitizeMap(headers) as Record<string, string> }),
    };
  }
}

export function redactConfig(config: McpServerConfig): McpServerPublicConfig {
  return new McpConfigStore().publicView(config);
}

function validateConfig(config: McpServerConfig): void {
  if (config.scope !== "user" && config.scope !== "project" && config.scope !== "session") throw new Error(`MCP server ${config.name} has an invalid scope`);
  if (config.transport !== "stdio" && config.transport !== "sse" && config.transport !== "streamable-http") throw new Error(`MCP server ${config.name} has an invalid transport`);
  if (config.transport === "stdio") {
    if (typeof config.command !== "string" || config.command.trim() === "") throw new Error(`MCP stdio server ${config.name} requires command`);
    if (config.url !== undefined) throw new Error(`MCP stdio server ${config.name} cannot define url`);
  } else {
    if (typeof config.url !== "string" || config.url.trim() === "") throw new Error(`MCP HTTP server ${config.name} requires url`);
    try { new URL(config.url); } catch { throw new Error(`MCP HTTP server ${config.name} has an invalid url`); }
    if (config.command !== undefined) throw new Error(`MCP HTTP server ${config.name} cannot define command`);
  }
  if (config.toolCallTimeoutMs !== undefined && (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)) throw new Error("toolCallTimeoutMs must be positive");
  const reconnect = config.reconnect;
  if (reconnect !== undefined) {
    const initial = reconnect.initialDelayMs ?? 500;
    const maximum = reconnect.maxDelayMs ?? 30_000;
    const attempts = reconnect.maxAttempts ?? 10;
    if (!Number.isFinite(initial) || initial <= 0 || initial > maximum) throw new Error("reconnect initialDelayMs must be positive and <= maxDelayMs");
    if (!Number.isFinite(maximum) || maximum <= 0) throw new Error("reconnect maxDelayMs must be positive");
    if (!Number.isInteger(attempts) || attempts < 1) throw new Error("reconnect maxAttempts must be a positive integer");
  }
}
