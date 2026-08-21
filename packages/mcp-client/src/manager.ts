import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SessionEventStore } from "@code-review-agent/contracts";
import { ToolRegistry } from "@code-review-agent/tools";
import { McpConfigStore, type McpServerConfig, type McpServerRecord, type McpServerStatus } from "./config.js";
import { createMcpToolRegistrations, registerMcpTools, unregisterMcpTools } from "./bridge.js";
import { discover, type McpDiscoverySnapshot } from "./discovery.js";
import { McpPromptAdapter, McpResourceAdapter } from "./adapters.js";
import { createMcpTransport, type McpTransportFactory } from "./transport.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpConnectionManagerOptions {
  readonly registry: ToolRegistry;
  readonly store?: SessionEventStore;
  readonly configStore?: McpConfigStore;
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

  constructor(private readonly options: McpConnectionManagerOptions) {
    this.configs = options.configStore ?? new McpConfigStore();
    this.transportFactory = options.transportFactory ?? createMcpTransport;
    this.clientName = options.clientName ?? "code-review-agent";
    this.clientVersion = options.clientVersion ?? "0.2.0-dev.1";
    for (const config of this.configs.list()) this.ensureState(config);
  }

  list(): readonly McpServerRecord[] {
    return this.configs.list().map((config) => this.toRecord(this.ensureState(config)));
  }

  get(name: string): McpServerRecord | undefined {
    const config = this.configs.get(name);
    return config === undefined ? undefined : this.toRecord(this.ensureState(config));
  }

  discovery(name: string): McpDiscoverySnapshot | undefined {
    return this.states.get(name)?.discovery;
  }

  async readResource(name: string, uri: string): Promise<Awaited<ReturnType<Client["readResource"]>>> {
    const client = this.requireClient(name);
    return new McpResourceAdapter(client).read(uri, this.configs.get(name)?.toolCallTimeoutMs ?? 120_000);
  }

  async getPrompt(name: string, promptName: string, args?: Readonly<Record<string, string>>): Promise<Awaited<ReturnType<Client["getPrompt"]>>> {
    const client = this.requireClient(name);
    return new McpPromptAdapter(client).get(promptName, args, this.configs.get(name)?.toolCallTimeoutMs ?? 120_000);
  }

  async add(config: McpServerConfig, start = true): Promise<McpServerRecord> {
    if (this.closed) throw new Error("MCP connection manager is closed");
    this.configs.upsert(config);
    const state = this.ensureState(config);
    if (start && config.enabled !== false) await this.start(config.name);
    return this.toRecord(state);
  }

  async start(name: string): Promise<McpServerRecord> {
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

  async stop(name: string): Promise<McpServerRecord> {
    const config = this.configs.get(name);
    if (config === undefined) throw new Error(`Unknown MCP server: ${name}`);
    const state = this.ensureState(config);
    await this.stopRuntime(state, true);
    state.status = config.enabled === false ? "disabled" : "stopped";
    await this.emitServer(state, state.status);
    return this.toRecord(state);
  }

  async reconnect(name: string): Promise<McpServerRecord> {
    return this.start(name);
  }

  async setEnabled(name: string, enabled: boolean): Promise<McpServerRecord> {
    const config = this.configs.setEnabled(name, enabled);
    const state = this.ensureState(config);
    if (enabled) return this.start(name);
    await this.stopRuntime(state, true);
    state.status = "disabled";
    await this.emitServer(state, "disabled");
    return this.toRecord(state);
  }

  async remove(name: string): Promise<boolean> {
    const config = this.configs.get(name);
    if (config === undefined) return false;
    const state = this.ensureState(config);
    await this.stopRuntime(state, true);
    this.states.delete(name);
    return this.configs.remove(name);
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
    };
    this.states.set(config.name, state);
    return state;
  }

  private requireClient(name: string): Client {
    const state = this.states.get(name);
    if (state?.client === undefined || state.status !== "connected") throw new Error(`MCP server is not connected: ${name}`);
    return state.client;
  }

  private async connectGeneration(state: RuntimeState, config: McpServerConfig, generation: number): Promise<void> {
    const client = new Client({ name: this.clientName, version: this.clientVersion }, { capabilities: {} });
    const transport = await this.transportFactory(config);
    state.client = client;
    state.transport = transport;
    client.onclose = () => {
      if (state.generation !== generation || state.intentionalClose || this.closed) return;
      state.client = undefined;
      state.transport = undefined;
      state.status = "failed";
      state.lastError = "MCP transport closed";
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
      try { await this.refreshTools(state, config, client); } catch (error) {
        state.lastError = safeMessage(error);
        await this.emitServer(state, "failed", state.lastError);
      }
    });
    await client.connect(transport);
    if (state.generation !== generation || state.intentionalClose) return;
    await this.refreshTools(state, config, client);
    state.status = "connected";
    state.lastError = undefined;
    state.reconnectAttempt = 0;
    await this.emitServer(state, "connected");
  }

  private async refreshTools(state: RuntimeState, config: McpServerConfig, client: Client): Promise<void> {
    const next = await discover(client);
    const registrations = createMcpToolRegistrations(client, config.name, config, next.tools);
    unregisterMcpTools(this.options.registry, state.toolNames);
    const toolNames = registerMcpTools(this.options.registry, registrations);
    state.toolNames = [...toolNames];
    state.discovery = next;
    state.discoveredAt = new Date().toISOString();
    for (const item of registrations) await this.emitTool(state, "discovered", item.definition.name, item.rawName);
  }

  private async stopRuntime(state: RuntimeState, intentional: boolean): Promise<void> {
    state.intentionalClose = intentional;
    if (state.reconnectTimer !== undefined) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = undefined;
    }
    state.generation += 1;
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
    if (state.reconnectAttempt >= policy.maxAttempts) return;
    const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * (2 ** state.reconnectAttempt));
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
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
    };
  }

  private async emitServer(state: RuntimeState, status: McpServerStatus, error?: string): Promise<void> {
    await this.emit("mcp/server", { serverName: state.name, status, ...(error === undefined ? {} : { error }) });
  }

  private async emitTool(state: RuntimeState, action: string, name: string, rawName: string): Promise<void> {
    await this.emit("mcp/tool", { serverName: state.name, action, name, rawName });
  }

  private async emit(type: "mcp/server" | "mcp/tool", payload: Record<string, unknown>): Promise<void> {
    if (this.options.store === undefined) return;
    for (const session of await this.options.store.listSessions()) {
      await this.options.store.append({ sessionId: session.id, type, payload });
    }
  }
}

function classifyStatus(error: unknown): McpServerStatus {
  const message = safeMessage(error);
  return /401|403|unauthorized|forbidden|authentication|auth/iu.test(message) ? "needs_auth" : "failed";
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
