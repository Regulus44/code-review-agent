import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfigBackend, McpCredentialReference, SessionEventStore } from "@code-review-agent/contracts";
import { ToolRegistry } from "@code-review-agent/tools";
import { McpConfigStore, type McpServerConfig, type McpServerRecord, type McpServerStatus, type McpToolCatalogEntry } from "./config.js";
import { createMcpToolRegistrations, replaceMcpTools, unregisterMcpTools } from "./bridge.js";
import { discover, type McpDiscoverySnapshot } from "./discovery.js";
import { McpPromptAdapter, McpResourceAdapter } from "./adapters.js";
import { createMcpTransport, type McpCredentialResolver, type McpTransportFactory } from "./transport.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpConnectionManagerOptions {
  readonly registry: ToolRegistry;
  readonly store?: SessionEventStore;
  readonly configStore?: McpConfigStore;
  readonly configBackend?: McpConfigBackend;
  readonly credentialResolver?: McpCredentialResolver;
  readonly transportFactory?: McpTransportFactory;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

interface RuntimeState {
  readonly name: string;
  status: McpServerStatus;
  client: Client | undefined;
  transport: Transport | undefined;
  toolNames: string[];
  discovery: McpDiscoverySnapshot | undefined;
  discoveredAt: string | undefined;
  lastError: string | undefined;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | undefined;
  generation: number;
  intentionalClose: boolean;
  catalog: McpToolCatalogEntry[];
  syncChain: Promise<void>;
  listChangedTimer: NodeJS.Timeout | undefined;
  nextRetryAt: string | undefined;
  connectedAt: number | undefined;
}

const DEFAULT_RECONNECT = Object.freeze({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 });

/** Owns MCP server lifecycles and keeps one ToolRegistry generation per server. */
export class McpConnectionManager {
  readonly configs: McpConfigStore;
  private readonly states = new Map<string, RuntimeState>();
  private readonly transportFactory: McpTransportFactory;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private closed = false;
  private readonly listChangedDebounceMs = 50;
  private readonly stableWindowMs = 5_000;

  constructor(private readonly options: McpConnectionManagerOptions) {
    this.configs = options.configStore ?? new McpConfigStore([], options.configBackend);
    this.transportFactory = options.transportFactory ?? createMcpTransport;
    this.clientName = options.clientName ?? "code-review-agent";
    this.clientVersion = options.clientVersion ?? "0.2.0-dev.1";
    for (const config of this.configs.list()) this.ensureState(config);
  }

  list(tenantId?: string): readonly McpServerRecord[] {
    return this.configs.list(undefined, tenantId, tenantId === undefined ? false : true).map((config) => this.toRecord(this.ensureState(config)));
  }

  get(name: string, tenantId?: string): McpServerRecord | undefined {
    const config = this.configs.get(name, tenantId, tenantId === undefined ? false : true);
    return config === undefined ? undefined : this.toRecord(this.ensureState(config));
  }

  discovery(name: string, tenantId?: string): McpDiscoverySnapshot | undefined {
    if (this.get(name, tenantId) === undefined) return undefined;
    return this.states.get(name)?.discovery;
  }

  async readResource(name: string, uri: string, signal?: AbortSignal, tenantId?: string): Promise<Awaited<ReturnType<Client["readResource"]>>> {
    const config = this.requireScopedConfig(name, tenantId);
    if (config === undefined) throw new Error(`Unknown MCP server: ${name}`);
    const client = this.requireClient(name);
    const result = await new McpResourceAdapter(client).read(uri, config.toolCallTimeoutMs ?? 120_000, signal);
    await this.emit("mcp/resource", { serverName: name, action: "read", uri, bytes: result.usage.bytes, truncated: result.usage.truncated });
    return result;
  }

  async getPrompt(name: string, promptName: string, args?: Readonly<Record<string, string>>, signal?: AbortSignal, tenantId?: string): Promise<Awaited<ReturnType<Client["getPrompt"]>>> {
    const config = this.requireScopedConfig(name, tenantId);
    if (config === undefined) throw new Error(`Unknown MCP server: ${name}`);
    const client = this.requireClient(name);
    const result = await new McpPromptAdapter(client).get(promptName, args, config.toolCallTimeoutMs ?? 120_000, signal);
    await this.emit("mcp/prompt", { serverName: name, action: "get", promptName, bytes: result.usage.bytes, truncated: result.usage.truncated, trust: result.trust });
    return result;
  }

  async add(config: McpServerConfig, start = true): Promise<McpServerRecord> {
    if (this.closed) throw new Error("MCP connection manager is closed");
    this.configs.upsert(config);
    const state = this.ensureState(config);
    if (start && config.enabled !== false) await this.startInternal(config.name, true);
    return this.toRecord(state);
  }

  async start(name: string, tenantId?: string): Promise<McpServerRecord> {
    this.requireScopedConfig(name, tenantId);
    return this.startInternal(name, true);
  }

  private async startInternal(name: string, resetAttempts: boolean): Promise<McpServerRecord> {
    if (this.closed) throw new Error("MCP connection manager is closed");
    const config = this.configs.get(name);
    if (config === undefined) throw new Error(`Unknown MCP server: ${name}`);
    const state = this.ensureState(config);
    await this.stopRuntime(state, false);
    state.generation += 1;
    state.intentionalClose = false;
    if (resetAttempts) state.reconnectAttempt = 0;
    if (config.enabled === false) {
      state.status = "disabled";
      await this.emitServer(state, "disabled");
      return this.toRecord(state);
    }
    state.status = "pending";
    state.lastError = undefined;
    await this.emitServer(state, "pending");
    try {
      await this.connectGeneration(state, config, state.generation);
    } catch (error) {
      state.status = classifyStatus(error);
      state.lastError = safeMessage(error);
      await this.emitServer(state, state.status, state.lastError);
      this.scheduleReconnect(state, config);
      if (config.failOnStartupError === true) throw error;
    }
    return this.toRecord(state);
  }

  async stop(name: string, tenantId?: string): Promise<McpServerRecord> {
    const config = this.requireScopedConfig(name, tenantId);
    if (config === undefined) throw new Error(`Unknown MCP server: ${name}`);
    const state = this.ensureState(config);
    await this.stopRuntime(state, true);
    state.status = config.enabled === false ? "disabled" : "stopped";
    await this.emitServer(state, state.status);
    return this.toRecord(state);
  }

  async reconnect(name: string, tenantId?: string): Promise<McpServerRecord> {
    return this.start(name, tenantId);
  }

  async setEnabled(name: string, enabled: boolean, tenantId?: string): Promise<McpServerRecord> {
    this.requireScopedConfig(name, tenantId);
    const config = this.configs.setEnabled(name, enabled, tenantId, tenantId === undefined ? false : true);
    const state = this.ensureState(config);
    if (enabled) return this.startInternal(name, true);
    await this.stopRuntime(state, true);
    state.status = "disabled";
    await this.emitServer(state, "disabled");
    return this.toRecord(state);
  }

  /** Stop live connections before a referenced credential is revoked or rotated. */
  async invalidateCredential(tenantId: string, credentialId: string): Promise<void> {
    for (const config of this.configs.list(undefined, tenantId, true)) {
      if (config.credentialRef?.id !== credentialId) continue;
      const state = this.ensureState(config);
      await this.stopRuntime(state, true);
      state.status = "needs_auth";
      state.lastError = "MCP credential reference is revoked or stale";
      await this.emitServer(state, "needs_auth", state.lastError);
    }
  }

  /** Move tenant-owned MCP configs to a newly rotated reference and reconnect them. */
  async refreshCredential(tenantId: string, credentialId: string, reference: McpCredentialReference): Promise<void> {
    for (const config of this.configs.list(undefined, tenantId, true)) {
      if (config.credentialRef?.id !== credentialId) continue;
      const revision = (config.revision ?? 0) + 1;
      this.configs.upsert({ ...config, credentialRef: reference, revision });
      await this.reconnect(config.name, tenantId);
    }
  }

  async remove(name: string, tenantId?: string): Promise<boolean> {
    const config = this.requireScopedConfig(name, tenantId, false);
    if (config === undefined) return false;
    const state = this.ensureState(config);
    await this.stopRuntime(state, true);
    this.states.delete(name);
    return this.configs.remove(name, tenantId, tenantId === undefined ? false : true);
  }

  async startConfigured(): Promise<void> {
    await Promise.all(this.configs.list().filter((config) => config.enabled !== false).map(async (config) => {
      try { await this.start(config.name); } catch { /* state and event retain the actionable failure */ }
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.states.values()].map((state) => this.stopRuntime(state, true)));
  }

  private ensureState(config: McpServerConfig): RuntimeState {
    const existing = this.states.get(config.name);
    if (existing !== undefined) return existing;
    const state: RuntimeState = {
      name: config.name,
      status: config.enabled === false ? "disabled" : "stopped",
      client: undefined,
      transport: undefined,
      toolNames: [],
      discovery: undefined,
      discoveredAt: undefined,
      lastError: undefined,
      reconnectAttempt: 0,
      reconnectTimer: undefined,
      generation: 0,
      intentionalClose: false,
      catalog: [],
      syncChain: Promise.resolve(),
      listChangedTimer: undefined,
      nextRetryAt: undefined,
      connectedAt: undefined,
    };
    this.states.set(config.name, state);
    return state;
  }

  private requireClient(name: string): Client {
    const state = this.states.get(name);
    if (state?.client === undefined || state.status !== "connected") throw new Error(`MCP server is not connected: ${name}`);
    return state.client;
  }

  private requireScopedConfig(name: string, tenantId?: string, throwOnMissing = true): McpServerConfig | undefined {
    const config = this.configs.get(name, tenantId, tenantId === undefined ? false : true);
    if (config === undefined && throwOnMissing) {
      const error = new Error(`Unknown MCP server: ${name}`);
      Object.assign(error, { code: "MCP_SERVER_NOT_FOUND" });
      throw error;
    }
    return config;
  }

  private async connectGeneration(state: RuntimeState, config: McpServerConfig, generation: number): Promise<void> {
    const client = new Client({ name: this.clientName, version: this.clientVersion }, { capabilities: {} });
    let transportConfig = config;
    if (config.credentialRef !== undefined) {
      if (this.options.credentialResolver === undefined) throw credentialUnavailable("MCP credential resolver is not configured");
      const material = await this.options.credentialResolver(config.credentialRef, config.tenantId);
      if (material === undefined) throw credentialUnavailable("MCP credential reference is unavailable or stale");
      transportConfig = mergeCredential(config, material);
    }
    const transport = await this.transportFactory(transportConfig);
    state.client = client;
    state.transport = transport;
    client.onclose = () => {
      if (state.generation !== generation || state.intentionalClose || this.closed) return;
      state.client = undefined;
      state.transport = undefined;
      state.status = "failed";
      state.lastError = "MCP transport closed";
      state.connectedAt = undefined;
      unregisterMcpTools(this.options.registry, state.toolNames);
      state.toolNames = [];
      void this.emitServer(state, "failed", state.lastError);
      this.scheduleReconnect(state, config);
    };
    transport.onerror = (error) => {
      if (!state.intentionalClose) state.lastError = safeMessage(error);
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (state.generation !== generation || state.client !== client || state.intentionalClose) return;
      this.queueRefresh(state, config, client, generation);
    });
    await client.connect(transport);
    if (state.generation !== generation || state.intentionalClose) return;
    await this.refreshTools(state, config, client, generation);
    state.status = "connected";
    state.lastError = undefined;
    state.connectedAt = Date.now();
    state.nextRetryAt = undefined;
    const stableTimer = setTimeout(() => {
      if (state.generation === generation && state.status === "connected" && state.connectedAt !== undefined && Date.now() - state.connectedAt >= this.stableWindowMs) state.reconnectAttempt = 0;
    }, this.stableWindowMs);
    stableTimer.unref();
    await this.emitServer(state, "connected");
  }

  private queueRefresh(state: RuntimeState, config: McpServerConfig, client: Client, generation: number): void {
    if (state.listChangedTimer !== undefined) clearTimeout(state.listChangedTimer);
    state.listChangedTimer = setTimeout(() => {
      state.listChangedTimer = undefined;
      state.syncChain = state.syncChain.then(async () => {
        if (state.generation !== generation || state.client !== client || state.intentionalClose) return;
        try {
          await this.refreshTools(state, config, client, generation);
        } catch (error) {
          state.lastError = safeMessage(error);
          await this.emitServer(state, "failed", state.lastError);
        }
      }).catch(() => undefined);
    }, this.listChangedDebounceMs);
    state.listChangedTimer.unref();
  }

  private async refreshTools(state: RuntimeState, config: McpServerConfig, client: Client, generation: number): Promise<void> {
    const next = await discover(client);
    if (state.generation !== generation || state.client !== client || state.intentionalClose) return;
    const registrations = createMcpToolRegistrations(client, config.name, config, next.tools);
    const toolNames = replaceMcpTools(this.options.registry, state.toolNames, registrations);
    state.toolNames = [...toolNames];
    state.catalog = next.tools.map((tool) => {
      const registration = registrations.find((item) => item.rawName === tool.name);
      const policy = config.toolPolicies?.[tool.name];
      return {
        name: registration?.definition.name ?? `mcp__${config.name}__${tool.name}`.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64),
        rawName: tool.name,
        generation,
        riskLevel: registration?.definition.riskLevel ?? (policy?.riskLevel ?? config.riskLevel ?? "network"),
        approvalMode: registration?.definition.approvalMode ?? (policy?.approvalMode ?? "ask"),
        enabled: registration !== undefined,
        ...(registration === undefined ? { disabledReason: policy?.enabled === false ? "tool-policy-disabled" : "server-allowlist" } : {}),
        ...(registration?.schemaWarning === undefined ? {} : { schemaWarning: registration.schemaWarning }),
      } satisfies McpToolCatalogEntry;
    });
    state.discovery = next;
    state.discoveredAt = new Date().toISOString();
    for (const item of registrations) await this.emitTool(state, "discovered", item.definition.name, item.rawName);
  }

  private async stopRuntime(state: RuntimeState, intentional: boolean): Promise<void> {
    state.intentionalClose = intentional;
    if (state.listChangedTimer !== undefined) {
      clearTimeout(state.listChangedTimer);
      state.listChangedTimer = undefined;
    }
    if (state.reconnectTimer !== undefined) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = undefined;
    }
    const sync = state.syncChain;
    state.generation += 1;
    state.connectedAt = undefined;
    state.nextRetryAt = undefined;
    await sync;
    unregisterMcpTools(this.options.registry, state.toolNames);
    state.toolNames = [];
    const client = state.client;
    state.client = undefined;
    state.transport = undefined;
    if (client !== undefined) {
      try { await client.close(); } catch { /* transport may already be closed */ }
    }
  }

  private scheduleReconnect(state: RuntimeState, config: McpServerConfig): void {
    const policy = { ...DEFAULT_RECONNECT, ...(config.reconnect ?? {}) };
    if (!policy.enabled || state.intentionalClose || this.closed || config.enabled === false) return;
    if (state.reconnectAttempt >= policy.maxAttempts) {
      state.lastError = "MCP reconnect budget exhausted";
      void this.emitServer(state, "failed", state.lastError);
      return;
    }
    const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * (2 ** state.reconnectAttempt));
    state.reconnectAttempt += 1;
    state.nextRetryAt = new Date(Date.now() + delay).toISOString();
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      state.nextRetryAt = undefined;
      void this.startInternal(state.name, false).catch(() => undefined);
    }, delay);
    state.reconnectTimer.unref();
  }

  private toRecord(state: RuntimeState): McpServerRecord {
    const config = this.configs.get(state.name);
    if (config === undefined) throw new Error(`Unknown MCP server: ${state.name}`);
    return {
      config: this.configs.publicView(config),
      status: state.status,
      toolNames: [...state.toolNames],
      ...(state.discoveredAt === undefined ? {} : { discoveredAt: state.discoveredAt }),
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      reconnectAttempt: state.reconnectAttempt,
      revision: config.revision ?? 1,
      generation: state.generation,
      catalog: [...state.catalog],
      ...(state.nextRetryAt === undefined ? {} : { retry: { nextAttemptAt: state.nextRetryAt, maxAttempts: config.reconnect?.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts } }),
    };
  }

  private async emitServer(state: RuntimeState, status: McpServerStatus, error?: string): Promise<void> {
    await this.emit("mcp/server", { serverName: state.name, status, ...(error === undefined ? {} : { error }) });
  }

  private async emitTool(state: RuntimeState, action: string, name: string, rawName: string): Promise<void> {
    await this.emit("mcp/tool", { serverName: state.name, action, name, rawName });
  }

  private async emit(type: "mcp/server" | "mcp/tool" | "mcp/resource" | "mcp/prompt", payload: Record<string, unknown>): Promise<void> {
    if (this.options.store === undefined) return;
    for (const session of await this.options.store.listSessions()) {
      const config = this.configs.get(String(payload["serverName"]));
      if (config !== undefined && !isVisibleToSession(config, session)) continue;
      await this.options.store.append({ sessionId: session.id, type, payload });
    }
  }
}

function isVisibleToSession(config: McpServerConfig, session: { id: unknown; workspaceRoot: string; ownership?: { readonly tenantId?: string } }): boolean {
  if (config.tenantId !== undefined && session.ownership?.tenantId !== config.tenantId) return false;
  if (config.scope === "session") return config.sessionId === undefined || config.sessionId === session.id;
  if (config.scope === "project") return config.workspaceRoot === undefined || config.workspaceRoot === session.workspaceRoot;
  return true;
}

function mergeCredential(config: McpServerConfig, material: { readonly env?: Readonly<Record<string, string>>; readonly headers?: Readonly<Record<string, string>> } | undefined): McpServerConfig {
  if (material === undefined) return config;
  return {
    ...config,
    ...(material.env === undefined ? {} : { env: { ...(config.env ?? {}), ...material.env } }),
    ...(material.headers === undefined ? {} : { headers: { ...(config.headers ?? {}), ...material.headers } }),
  };
}

function credentialUnavailable(message: string): Error & { readonly code: string } {
  const error = new Error(message) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: "MCP_CREDENTIAL_UNAVAILABLE", enumerable: true });
  return error;
}

function classifyStatus(error: unknown): McpServerStatus {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "MCP_CREDENTIAL_UNAVAILABLE") return "needs_auth";
  const message = safeMessage(error);
  return /401|403|unauthorized|forbidden|authentication|auth/iu.test(message) ? "needs_auth" : "failed";
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
