import type { McpConfigBackend, McpConfigRecord, McpCredentialReference, ToolApprovalMode, ToolRiskLevel } from "@coding-agent/contracts";

export type { McpServerScope } from "@coding-agent/contracts";
import type { McpServerScope } from "@coding-agent/contracts";
export type McpTransportKind = "stdio" | "sse" | "streamable-http";
export type McpServerStatus = "pending" | "connected" | "failed" | "needs_auth" | "disabled" | "stopped";

export interface McpReconnectPolicy {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

export interface McpToolPolicy {
  readonly enabled?: boolean;
  readonly riskLevel?: ToolRiskLevel;
  readonly approvalMode?: ToolApprovalMode;
}

export interface McpToolCatalogEntry {
  readonly name: string;
  readonly rawName: string;
  readonly generation: number;
  readonly riskLevel: ToolRiskLevel;
  readonly approvalMode: ToolApprovalMode;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly schemaWarning?: string;
}

export interface McpServerConfig {
  readonly name: string;
  readonly scope: McpServerScope;
  /** Optional tenant owner; absent keeps legacy local MCP behavior. */
  readonly tenantId?: string;
  readonly ownerId?: string;
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly revision?: number;
  readonly transport: McpTransportKind;
  readonly enabled?: boolean;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentialRef?: McpCredentialReference;
  readonly toolAllowlist?: readonly string[];
  readonly toolPolicies?: Readonly<Record<string, McpToolPolicy>>;
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
  readonly revision: number;
  readonly generation: number;
  readonly catalog: readonly McpToolCatalogEntry[];
  readonly retry?: { readonly nextAttemptAt?: string; readonly maxAttempts: number };
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

/** Config registry with an optional durable backend. Secrets stay process-local and public views are scrubbed. */
export class McpConfigStore {
  private readonly configs = new Map<string, McpServerConfig>();

  constructor(initial: readonly McpServerConfig[] = [], private readonly backend?: McpConfigBackend) {
    const durable = backend?.listMcpConfigs() ?? [];
    for (const record of durable) this.configs.set(record.name, fromRecord(record));
    for (const config of initial) this.upsert(config);
  }

  upsert(config: McpServerConfig): McpServerConfig {
    validateName(config.name);
    validateConfig(config);
    const existing = this.configs.get(config.name);
    if (existing !== undefined && (existing.tenantId ?? undefined) !== (config.tenantId ?? undefined)) {
      const error = new Error(`MCP server ${config.name} is owned by another tenant`);
      Object.assign(error, { code: "MCP_TENANT_SCOPE_CONFLICT" });
      throw error;
    }
    const normalized: McpServerConfig = {
      ...config,
      enabled: config.enabled ?? true,
      revision: config.revision ?? (existing !== undefined && sameConfig(existing, config) ? existing.revision ?? 1 : (existing?.revision ?? 0) + 1),
      ...(config.args === undefined ? {} : { args: [...config.args] }),
      ...(config.env === undefined ? {} : { env: cloneMap(config.env) as Record<string, string> }),
      ...(config.headers === undefined ? {} : { headers: cloneMap(config.headers) as Record<string, string> }),
    };
    this.configs.set(config.name, normalized);
    this.persist(normalized);
    return normalized;
  }

  get(name: string, tenantId?: string, includeTenantScoped = true): McpServerConfig | undefined {
    const config = this.configs.get(name);
    if (config === undefined || (tenantId !== undefined && config.tenantId !== tenantId) || (tenantId === undefined && !includeTenantScoped && config.tenantId !== undefined)) return undefined;
    return config;
  }

  list(scope?: McpServerScope, tenantId?: string, includeTenantScoped = true): readonly McpServerConfig[] {
    return [...this.configs.values()]
      .filter((config) => scope === undefined || config.scope === scope)
      .filter((config) => tenantId === undefined ? includeTenantScoped || config.tenantId === undefined : config.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  remove(name: string, tenantId?: string, includeTenantScoped = true): boolean {
    if (this.get(name, tenantId, includeTenantScoped) === undefined) return false;
    const removed = this.configs.delete(name);
    if (removed) this.backend?.deleteMcpConfig(name);
    return removed;
  }

  setEnabled(name: string, enabled: boolean, tenantId?: string, includeTenantScoped = true): McpServerConfig {
    const existing = this.get(name, tenantId, includeTenantScoped);
    if (existing === undefined) throw new Error(`Unknown MCP server: ${name}`);
    const revision = existing.revision === undefined ? 1 : existing.enabled === enabled ? existing.revision : existing.revision + 1;
    const next = { ...existing, enabled, revision };
    this.configs.set(name, next);
    this.persist(next);
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

  private persist(config: McpServerConfig): void {
    if (this.backend === undefined) return;
    const timestamp = new Date().toISOString();
    const record: McpConfigRecord = {
      name: config.name,
      scope: config.scope,
      ...(config.tenantId === undefined ? {} : { tenantId: config.tenantId }),
      ...(config.ownerId === undefined ? {} : { ownerId: config.ownerId }),
      ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
      ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
      enabled: config.enabled !== false,
      revision: config.revision ?? 1,
      ...(config.credentialRef === undefined ? {} : { credentialRef: config.credentialRef }),
      config: scrubPersistedConfig(config),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.backend.upsertMcpConfig(record);
  }
}

export function redactConfig(config: McpServerConfig): McpServerPublicConfig {
  return new McpConfigStore().publicView(config);
}

function scrubPersistedConfig(config: McpServerConfig): Record<string, unknown> {
  const scrubMap = (value: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)));
  };
  return {
    ...config,
    ...(scrubMap(config.env) === undefined ? {} : { env: scrubMap(config.env) }),
    ...(scrubMap(config.headers) === undefined ? {} : { headers: scrubMap(config.headers) }),
  };
}

function fromRecord(record: McpConfigRecord): McpServerConfig {
  const config = { ...record.config, name: record.name, scope: record.scope, enabled: record.enabled, revision: record.revision } as unknown as McpServerConfig;
  return {
    ...config,
    ...(record.tenantId === undefined ? {} : { tenantId: record.tenantId }),
    ...(record.ownerId === undefined ? {} : { ownerId: record.ownerId }),
    ...(record.workspaceRoot === undefined ? {} : { workspaceRoot: record.workspaceRoot }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.credentialRef === undefined ? {} : { credentialRef: record.credentialRef }),
  };
}

function sameConfig(left: McpServerConfig, right: McpServerConfig): boolean {
  const strip = (value: McpServerConfig): Record<string, unknown> => {
    const { revision: _revision, enabled: _enabled, ...rest } = value;
    return rest as Record<string, unknown>;
  };
  return JSON.stringify(stable(strip(left))) === JSON.stringify(stable(strip(right))) && (left.enabled !== false) === (right.enabled !== false);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

function validateConfig(config: McpServerConfig): void {
  if (config.tenantId !== undefined && config.tenantId.trim() === "") throw new Error(`MCP server ${config.name} has an invalid tenant scope`);
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
