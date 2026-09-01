import { createReadStream, existsSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createDefaultSessionMemoryExtractor, FileSessionMemoryStore, FileProjectMemoryStore, createInProcessSubagentProvider, sessionId, AgentHost, turnId, type AgentHostOptions, type TenantModelRoute } from "@coding-agent/runtime";
import { resolveDefaultSqliteDatabasePath, SqliteEventStore } from "@coding-agent/storage";
import { brand, type AgentEvent, type ChatModel, type ContextBudgetConfig, type GoalStatus, type InteractionId, type PermissionId, type PlanStatus, type SessionEventStore, type TodoItem, type ProductizationCapability, type SessionOwnership, type ModelRouteBackend, type ModelRouteRecord, type CredentialBackend, type McpCredentialReference, type PrincipalBackend, type ModelSelection as ContractModelSelection, type ModelCatalogEntry, type ProviderCatalogGroup, type ProviderProfileRecord, type MemoryInspectionResponse } from "@coding-agent/contracts";
import { SubagentRuntime } from "@coding-agent/subagent";
import { SkillRegistry } from "@coding-agent/skills";
import type { PluginRuntime } from "@coding-agent/plugin-runtime";
import { FileSystemSkillProvider, defaultSkillFilesystemRoots, type SkillFilesystemLimits, type SkillFilesystemRoot } from "@coding-agent/skills-filesystem";
import { ANTHROPIC_MESSAGES_DEFAULT_MAX_OUTPUT_TOKENS, ANTHROPIC_MESSAGES_MAX_OUTPUT_TOKENS, createBuiltInModelProtocolRegistry, createConfiguredModelBootstrap, createModelFromProviderProfile, ModelCatalog, type ModelConfigView, type ProviderCredentialMaterial } from "@coding-agent/llm";
import { McpConnectionManager, type McpServerConfig } from "@coding-agent/mcp-client";
import type { CodeModeSandbox, PermissionPreset } from "@coding-agent/tools";
import { artifactAccessResponse, inspectArtifact, isAvailableArtifact, type ArtifactAccess } from "./artifacts.js";
import { attachmentCapability, AttachmentInputError, stageAttachment, type AttachmentPolicy } from "./attachments.js";
import { CredentialLifecycleError, CredentialVault, LocalFileSecretProvider, type CredentialInput, type CredentialMaterial, type SecretProvider } from "./credentials.js";
import { LocalProviderProfileStore } from "./provider-profiles.js";
import { verifyProductizationJwt, type ProductizationJwtOptions } from "./auth.js";

export interface ModelSelection {
  readonly model: ChatModel;
  readonly config: ModelConfigView;
}

export type ModelSelector = (model: string, tenantId?: string, credential?: CredentialMaterial, provider?: string) => ModelSelection;

export interface ProductizationToken {
  readonly token: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ProductizationServerOptions {
  readonly auth?: {
    readonly required?: boolean;
    readonly tokens: readonly ProductizationToken[];
    readonly jwt?: ProductizationJwtOptions;
  };
  readonly quota?: {
    readonly maxSessionsPerTenant?: number;
    readonly maxTurnsPerTenant?: number;
  };
}

export interface ApiServerOptions {
  readonly store?: SessionEventStore;
  readonly databasePath?: string;
  readonly host?: AgentHost;
  readonly model?: ChatModel;
  readonly fallbackModels?: readonly ChatModel[];
  /** @deprecated Retained for API compatibility; AgentHost no longer enforces a step limit. */
  readonly maxSteps?: number;
  /** Maximum in-flight parallel-safe tool calls per assistant step. */
  readonly maxParallelToolCalls?: number;
  readonly modelInfo?: ModelConfigView;
  readonly availableModels?: readonly string[];
  readonly modelSelector?: ModelSelector;
  /** Host-scoped or tenant-scoped provider profiles used by the MR5 model catalog. */
  readonly providerProfiles?: readonly ProviderProfileRecord[];
  /** Optional provider discovery hook. Failures are isolated to the corresponding provider group. */
  readonly providerDiscovery?: (profile: ProviderProfileRecord, signal?: AbortSignal) => Promise<readonly ModelCatalogEntry[]>;
  /** Optional durable tenant-scoped routing backend; SQLite stores implement it directly. */
  readonly modelRouting?: ModelRouteBackend;
  /** Optional durable credential metadata backend; SQLite stores implement it directly. */
  readonly credentialBackend?: CredentialBackend;
  /** Durable principal catalog used by verified external IdP subjects. */
  readonly principalBackend?: PrincipalBackend;
  /** Test/deployment hook for a host-owned credential vault. */
  readonly credentials?: CredentialVault;
  /** Explicit external secret-manager adapter; absent means host-only memory. */
  readonly secretProvider?: SecretProvider;
  /** Local durable secret file; defaults to apps/api/.data/credentials.secrets.json for SQLite hosts. */
  readonly credentialSecretsPath?: string;
  /** Local durable custom provider profile file; defaults to apps/api/.data/provider-profiles.json for SQLite hosts. */
  readonly providerProfilesPath?: string;
  /** Enables unauthenticated mutation for the single local host scope. */
  readonly localHostMode?: boolean;
  /** Test/deployment hook for bounded provider catalog recovery fixtures. */
  readonly modelCatalogFailures?: number;
  readonly permissionPreset?: PermissionPreset;
  readonly mcp?: McpConnectionManager;
  readonly subagentRuntime?: SubagentRuntime;
  /** Optional Skill registry/provider. S1 local filesystem discovery is enabled by default for API hosts. */
  readonly skills?: AgentHostOptions["skills"];
  /** Optional local bundle/plugin runtime. Installation and enablement remain explicit. */
  readonly plugins?: PluginRuntime;
  readonly skillToolEnabled?: AgentHostOptions["skillToolEnabled"];
  readonly skillFilesystem?: { readonly enabled?: boolean; readonly roots?: readonly SkillFilesystemRoot[]; readonly customPaths?: readonly string[]; readonly bundledPath?: string; readonly userPath?: string; readonly limits?: SkillFilesystemLimits; readonly watch?: boolean };
  /** Optional host-owned Session Memory store and background extractor. */
  readonly sessionMemory?: AgentHostOptions["sessionMemory"];
  /** Host-owned directory for the default local Session Memory adapter. */
  readonly sessionMemoryRootDir?: string;
  readonly sessionMemoryEnabled?: AgentHostOptions["sessionMemoryEnabled"];
  readonly sessionMemoryCompact?: AgentHostOptions["sessionMemoryCompact"];
  readonly sessionMemoryExtractor?: AgentHostOptions["sessionMemoryExtractor"];
  readonly sessionMemoryExtraction?: AgentHostOptions["sessionMemoryExtraction"];
  /** Optional host-owned workspace/tenant Project Memory store. */
  readonly projectMemory?: AgentHostOptions["projectMemory"];
  /** Host-owned directory for the default local Project Memory adapter. */
  readonly projectMemoryRootDir?: string;
  readonly projectMemoryEnabled?: AgentHostOptions["projectMemoryEnabled"];
  readonly projectMemoryValidation?: AgentHostOptions["projectMemoryValidation"];
  readonly projectMemoryScopeKey?: AgentHostOptions["projectMemoryScopeKey"];
  readonly attachmentPolicy?: AttachmentPolicy;
  readonly contextBudget?: {
    readonly maxTokens?: number;
    readonly recentMessageTokens?: number;
    readonly maxToolResultChars?: number;
    readonly maxSummaryChars?: number;
  };
  readonly contextPolicy?: Partial<ContextBudgetConfig>;
  readonly codeMode?: CodeModeSandbox;
  readonly productization?: ProductizationServerOptions;
  readonly webRoot?: string;
  /** Injectable process environment for the configured local model bootstrap. */
  readonly modelEnvironment?: NodeJS.ProcessEnv;
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const ownsStore = options.store === undefined && options.host === undefined;
  const store = options.store ?? (options.host === undefined ? new SqliteEventStore({ databasePath: options.databasePath ?? defaultDatabasePath() }) : undefined);
  const localHostMode = options.localHostMode ?? (options.productization?.auth === undefined && store instanceof SqliteEventStore);
  const secretProvider = options.secretProvider ?? (store instanceof SqliteEventStore ? new LocalFileSecretProvider({ filePath: options.credentialSecretsPath ?? defaultCredentialSecretsPath() }) : undefined);
  const credentials = options.credentials ?? new CredentialVault(options.credentialBackend ?? credentialBackendFrom(store), secretProvider);
  const providerProfileStore = store instanceof SqliteEventStore ? new LocalProviderProfileStore(options.providerProfilesPath ?? defaultProviderProfilesPath()) : undefined;
  const principals = options.principalBackend ?? principalBackendFrom(store);
  const sqliteDatabasePath = store instanceof SqliteEventStore ? store.databasePath : undefined;
  const defaultSessionMemory = options.host === undefined && (sqliteDatabasePath !== undefined || options.sessionMemoryRootDir !== undefined) && options.sessionMemoryEnabled !== false && options.sessionMemory === undefined
    ? new FileSessionMemoryStore({ rootDir: options.sessionMemoryRootDir ?? defaultSessionMemoryRoot(sqliteDatabasePath ?? ":memory:") })
    : undefined;
  const sessionMemory = options.sessionMemory ?? defaultSessionMemory;
  const sessionMemoryExtractor = options.sessionMemoryExtractor ?? (sessionMemory === undefined || options.sessionMemoryEnabled === false ? undefined : createDefaultSessionMemoryExtractor());
  const defaultProjectMemory = options.host === undefined && (sqliteDatabasePath !== undefined || options.projectMemoryRootDir !== undefined) && options.projectMemoryEnabled !== false && options.projectMemory === undefined
    ? new FileProjectMemoryStore({ rootDir: options.projectMemoryRootDir ?? defaultProjectMemoryRoot(sqliteDatabasePath ?? ":memory:") })
    : undefined;
  const projectMemory = options.projectMemory ?? defaultProjectMemory;
  const skills = options.skills ?? (options.host === undefined && options.skillFilesystem?.enabled !== false ? new SkillRegistry() : undefined);
  if (options.skills === undefined && skills !== undefined) {
    const provider = new FileSystemSkillProvider({
      roots: options.skillFilesystem?.roots ?? defaultSkillFilesystemRoots({ cwd: process.cwd(), ...(options.skillFilesystem?.bundledPath === undefined ? {} : { bundledPath: options.skillFilesystem.bundledPath }), ...(options.skillFilesystem?.userPath === undefined ? {} : { userPath: options.skillFilesystem.userPath }), ...(options.skillFilesystem?.customPaths === undefined ? {} : { customPaths: options.skillFilesystem.customPaths }) }),
      ...(options.skillFilesystem?.limits === undefined ? {} : { limits: options.skillFilesystem.limits }),
      ...(options.skillFilesystem?.watch === undefined ? {} : { watch: options.skillFilesystem.watch }),
    });
    skills.registerProvider(provider);
  }
  const subagentRuntime = options.subagentRuntime ?? new SubagentRuntime({ store: store as SessionEventStore });
  const host = options.host ?? new AgentHost({ store: store as SessionEventStore, ...(options.skillToolEnabled === undefined ? {} : { skillToolEnabled: options.skillToolEnabled }), ...(options.model === undefined ? {} : { model: options.model }), ...(options.fallbackModels === undefined ? {} : { fallbackModels: options.fallbackModels }), ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }), ...(options.maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls: options.maxParallelToolCalls }), ...(options.permissionPreset === undefined ? {} : { permissionPreset: options.permissionPreset }), ...(options.contextBudget === undefined ? {} : { contextBudget: options.contextBudget }), ...(options.contextPolicy === undefined ? {} : { contextPolicy: options.contextPolicy }), ...(options.codeMode === undefined ? {} : { codeMode: options.codeMode }), ...(sessionMemory === undefined ? {} : { sessionMemory }), ...(options.sessionMemoryEnabled === undefined ? {} : { sessionMemoryEnabled: options.sessionMemoryEnabled }), ...(options.sessionMemoryCompact === undefined ? {} : { sessionMemoryCompact: options.sessionMemoryCompact }), ...(sessionMemoryExtractor === undefined ? {} : { sessionMemoryExtractor }), ...(options.sessionMemoryExtraction === undefined ? {} : { sessionMemoryExtraction: options.sessionMemoryExtraction }), ...(projectMemory === undefined ? {} : { projectMemory }), ...(options.projectMemoryEnabled === undefined ? {} : { projectMemoryEnabled: options.projectMemoryEnabled }), ...(options.projectMemoryValidation === undefined ? {} : { projectMemoryValidation: options.projectMemoryValidation }), ...(options.projectMemoryScopeKey === undefined ? {} : { projectMemoryScopeKey: options.projectMemoryScopeKey }), ...(skills === undefined ? {} : { skills }), ...(options.plugins === undefined ? {} : { plugins: options.plugins }), ...(options.productization?.quota === undefined ? {} : { quota: options.productization.quota }), ...(store instanceof SqliteEventStore ? { operations: { backup: "available", migration: "available", upgrade: "deferred" } } : {}), subagentRuntime });
  if (options.plugins !== undefined && options.host === undefined) void options.plugins.reconcile().catch(() => undefined);
  if (!subagentRuntime.providerCatalog().some((provider) => provider.name === "in-process")) subagentRuntime.registerProvider(createInProcessSubagentProvider({ store: store as SessionEventStore, ...(options.model === undefined ? {} : { model: options.model }), baseToolDefinitions: host.toolRegistry().listAll(), subagentRuntime }));
  const modelRuntime: ModelRuntimeState = {
    availableModels: options.availableModels ?? [],
    remainingCatalogFailures: Math.max(0, Math.floor(options.modelCatalogFailures ?? 0)),
    ...(options.modelInfo === undefined ? {} : { info: options.modelInfo }),
    ...(options.modelSelector === undefined ? {} : { selector: options.modelSelector }),
    routes: new Map(),
    catalog: new ModelCatalog(),
    credentials,
    ...(options.modelRouting === undefined && (store === undefined || typeof (store as Partial<ModelRouteBackend>).listModelRoutes !== "function") ? {} : { routeBackend: options.modelRouting ?? store as unknown as ModelRouteBackend }),
  };
  for (const profile of [...(providerProfileStore?.listAll() ?? []), ...(options.providerProfiles ?? [])]) {
    createBuiltInModelProtocolRegistry().get(profile.protocol);
    modelRuntime.catalog.register(profile, options.providerDiscovery === undefined ? undefined : { listModels: options.providerDiscovery });
  }
  registerBootstrapCatalog(modelRuntime, options.modelInfo, options.availableModels);
  for (const route of modelRuntime.routeBackend?.listModelRoutes() ?? []) {
    const material = route.credentialRef === undefined ? undefined : credentials.resolve(route.credentialRef, route.tenantId);
    if (route.credentialRef !== undefined && material === undefined) continue;
    try {
      const selected = selectCatalogModel(modelRuntime, route.model, route.tenantId, material, route.provider);
      modelRuntime.routes.set(route.tenantId, route);
      host.setTenantModel(route.tenantId, selected.model, routeSelection(route));
    } catch {
      // Keep durable metadata intact while failing closed when a local secret
      // file or provider profile is unavailable during host restart.
    }
  }
  modelRuntime.selectionRestore = restoreSessionSelections(store as SessionEventStore | undefined, host, modelRuntime, localHostMode);
  const ownsMcp = options.mcp === undefined;
  const mcp = options.mcp ?? new McpConnectionManager({
    registry: host.toolRegistry(),
    ...(store === undefined ? {} : { store }),
    ...(store instanceof SqliteEventStore ? { configBackend: store } : {}),
    credentialResolver: (reference, tenantId) => credentials.resolve(reference, tenantId),
  });
  void mcp.startConfigured();
  const persistence = store instanceof SqliteEventStore ? "sqlite" : "custom";
  const webRoot = options.webRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  const server = createServer((request, response) => {
    void handleRequest(request, response, host, mcp, subagentRuntime, webRoot, persistence, modelRuntime, credentials, principals, options.attachmentPolicy, options.productization, localHostMode, providerProfileStore);
  });
  server.on("close", () => { void host.shutdown(); });
  if (ownsStore && store instanceof SqliteEventStore) server.on("close", () => store.close());
  if (ownsMcp) server.on("close", () => { void mcp.close(); });
  return server;
}

function defaultDatabasePath(): string {
  // Keep the local database stable when the API is started from the repository
  // root, apps/api, or a process manager with a different working directory.
  return resolveDefaultSqliteDatabasePath(
    process.env,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
}

function defaultCredentialSecretsPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data/credentials.secrets.json");
}

function defaultProviderProfilesPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data/provider-profiles.json");
}

function defaultSessionMemoryRoot(databasePath: string): string {
  const hostDataRoot = databasePath === ":memory:" || databasePath.startsWith("file:")
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data")
    : path.dirname(path.resolve(databasePath));
  const identity = createHash("sha256").update(databasePath === ":memory:" ? "memory" : path.resolve(databasePath), "utf8").digest("hex").slice(0, 16);
  return path.resolve(hostDataRoot, "session-memory", identity);
}

function defaultProjectMemoryRoot(databasePath: string): string {
  const hostDataRoot = databasePath === ":memory:" || databasePath.startsWith("file:")
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data")
    : path.dirname(path.resolve(databasePath));
  const identity = createHash("sha256").update(databasePath === ":memory:" ? "memory" : path.resolve(databasePath), "utf8").digest("hex").slice(0, 16);
  return path.resolve(hostDataRoot, "project-memory", identity);
}

/** CLI/runtime entry that opts into local `.env` model configuration. Tests stay deterministic via createApiServer(). */
export function createConfiguredApiServer(options: ApiServerOptions = {}): Server {
  if (options.host !== undefined || options.model !== undefined) return createApiServer(options);
  const bootstrap = createConfiguredModelBootstrap(options.modelEnvironment);
  const bootstrapSelector = bootstrap.selectModel;
  const switchOptions: ApiServerOptions = {
    ...(options.availableModels === undefined ? { availableModels: bootstrap.availableModels } : { availableModels: options.availableModels }),
    ...(options.modelSelector === undefined && bootstrapSelector !== undefined ? {
      modelSelector: (model: string, _tenantId: string | undefined, credential: CredentialMaterial | undefined) => {
        const selected = bootstrapSelector(model, credential?.env);
        return { model: selected.model, config: selected.config };
      },
    } : options.modelSelector === undefined ? {} : { modelSelector: options.modelSelector }),
  };
  return createApiServer({
    ...options,
    model: bootstrap.initial.model,
    modelInfo: options.modelInfo ?? bootstrap.initial.config,
    ...switchOptions,
  });
}

interface ModelRuntimeState {
  info?: ModelConfigView;
  readonly availableModels: readonly string[];
  readonly selector?: ModelSelector;
  readonly routeBackend?: ModelRouteBackend;
  readonly credentials: CredentialVault;
  readonly routes: Map<string, ModelRouteRecord>;
  readonly catalog: ModelCatalog;
  remainingCatalogFailures: number;
  selectionRestore?: Promise<void>;
}

const LOCAL_HOST_IDENTITY: SessionOwnership = {
  principalId: brand<string, "PrincipalId">("local-host"),
  tenantId: brand<string, "TenantId">("local"),
};

function currentAttachmentCapability(policy: AttachmentPolicy | undefined, modelRuntime: ModelRuntimeState, tenantId?: string) {
  return attachmentCapability(policy, (modelRuntime.routes.get(tenantId ?? "")?.model ?? modelRuntime.info?.model)?.includes("vision") === true);
}

function credentialBackendFrom(store: SessionEventStore | undefined): CredentialBackend | undefined {
  if (store === undefined) return undefined;
  const candidate = store as Partial<CredentialBackend>;
  return typeof candidate.listCredentials === "function" && typeof candidate.getCredential === "function" && typeof candidate.upsertCredential === "function" && typeof candidate.deleteCredential === "function"
    ? store as unknown as CredentialBackend
    : undefined;
}

function principalBackendFrom(store: SessionEventStore | undefined): PrincipalBackend | undefined {
  const candidate = store as Partial<PrincipalBackend> | undefined;
  return candidate !== undefined && typeof candidate.getPrincipal === "function" && typeof candidate.listPrincipals === "function" && typeof candidate.upsertPrincipal === "function"
    ? store as unknown as PrincipalBackend
    : undefined;
}

function registerBootstrapCatalog(modelRuntime: ModelRuntimeState, info: ModelConfigView | undefined, availableModels: readonly string[] | undefined): void {
  if (info === undefined) return;
  if (modelRuntime.catalog.profile(info.provider) !== undefined) return;
  const models = [...new Set([info.model, ...(availableModels ?? [])])].filter((model) => model.trim() !== "");
  const entries: ModelCatalogEntry[] = models.map((model) => ({
    provider: info.provider,
    model,
    displayName: model,
    ...(info.provider === "deepseek" ? {
      contextCapability: {
        provider: "deepseek",
        model,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 8_000,
        supportsExactCount: false,
        supportsPromptCache: false,
        source: "provider" as const,
      },
    } : {}),
    ...(info.provider === "anthropic" ? {
      contextCapability: {
        provider: "anthropic",
        model,
        maxInputTokens: 200_000,
        maxOutputTokens: ANTHROPIC_MESSAGES_MAX_OUTPUT_TOKENS,
        defaultMaxOutputTokens: ANTHROPIC_MESSAGES_DEFAULT_MAX_OUTPUT_TOKENS,
        supportsExactCount: false,
        supportsPromptCache: false,
        source: "provider" as const,
      },
    } : {}),
  }));
  const now = new Date().toISOString();
  modelRuntime.catalog.register({
    id: info.provider,
    displayName: info.provider,
    protocol: info.provider === "anthropic" ? "anthropic-messages" : info.provider === "echo" ? "echo" : "openai-chat-completions",
    ...(info.baseUrl === undefined ? {} : { baseUrl: info.baseUrl }),
    models: entries,
    enabled: true,
    revision: 1,
    source: "builtin",
    createdAt: now,
    updatedAt: now,
  });
}

function selectCatalogModel(modelRuntime: ModelRuntimeState, model: string, tenantId: string | undefined, credential: CredentialMaterial | undefined, provider?: string): ModelSelection {
  const profile = provider === undefined ? undefined : modelRuntime.catalog.profile(provider, tenantId);
  if (modelRuntime.selector !== undefined && profile?.source !== "custom") {
    const selected = modelRuntime.selector(model, tenantId, credential, provider);
    if (provider !== undefined && selected.config.provider !== provider) throw new HttpError(400, "provider does not match the selected model");
    return selected;
  }
  const resolvedProvider = provider ?? modelRuntime.info?.provider ?? modelRuntime.catalog.listProfiles(tenantId)[0]?.id;
  if (resolvedProvider === undefined) throw new HttpError(409, "model switching is not configured");
  const resolved = modelRuntime.catalog.resolve(resolvedProvider, model, tenantId);
  const material: ProviderCredentialMaterial | undefined = credential === undefined ? undefined : { ...(credential.env === undefined ? {} : { env: credential.env }), ...(credential.headers === undefined ? {} : { headers: credential.headers }) };
  const created = createModelFromProviderProfile(resolved.profile, model, material);
  return {
    model: created.model,
    config: { provider: resolved.profile.id, model, ...(created.config.baseUrl === undefined ? {} : { baseUrl: created.config.baseUrl }), configured: created.config.configured },
  };
}

function publicProviderProfile(profile: ProviderProfileRecord): Record<string, unknown> {
  return {
    id: profile.id,
    ...(profile.tenantId === undefined ? {} : { tenantId: profile.tenantId }),
    displayName: profile.displayName,
    protocol: profile.protocol,
    ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
    ...(profile.credentialRef === undefined ? {} : { credentialRef: profile.credentialRef }),
    enabled: profile.enabled,
    revision: profile.revision,
    source: profile.source ?? "custom",
    models: profile.models,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function publicCatalogGroups(groups: readonly ProviderCatalogGroup[]): readonly Record<string, unknown>[] {
  return groups.map((group) => ({
    provider: group.provider,
    displayName: group.displayName,
    protocol: group.protocol,
    enabled: group.enabled,
    source: group.source,
    status: group.status,
    models: group.models,
    ...(group.refreshedAt === undefined ? {} : { refreshedAt: group.refreshedAt }),
    ...(group.error === undefined ? {} : { error: group.error }),
  }));
}

function requireTenantIdentity(identity: SessionOwnership | undefined): SessionOwnership {
  if (identity === undefined) throw new HttpError(401, "tenant authentication is required for credential management");
  return identity;
}

function publicCredential(record: import("@coding-agent/contracts").CredentialRecord): Record<string, unknown> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    kind: record.kind,
    ...(record.label === undefined ? {} : { label: record.label }),
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}

function parseCredentialInput(body: Readonly<Record<string, unknown>>): CredentialInput {
  const kind = body.kind;
  if (kind !== "header" && kind !== "env" && kind !== "oauth" && kind !== "custom") throw new HttpError(400, "credential kind must be header, env, oauth, or custom");
  const label = body.label === undefined ? undefined : requireString(body.label, "label");
  if (label !== undefined && (label.trim().length === 0 || label.length > 120)) throw new HttpError(400, "label must be between 1 and 120 characters");
  const material = requireRecord(body.material, "material");
  const env = parseCredentialMap(material.env, "material.env");
  const headers = parseCredentialMap(material.headers, "material.headers");
  if (env === undefined && headers === undefined) throw new HttpError(400, "material must contain env or headers");
  return { kind, ...(label === undefined ? {} : { label }), material: { ...(env === undefined ? {} : { env }), ...(headers === undefined ? {} : { headers }) } };
}

function parseCredentialMap(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, field);
  const entries = Object.entries(record);
  if (entries.length === 0 || entries.length > 32) throw new HttpError(400, `${field} must contain between 1 and 32 entries`);
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(key) || typeof item !== "string" || item.length === 0 || item.length > 16_384) throw new HttpError(400, `${field} contains an invalid entry`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseCredentialReference(value: unknown): McpCredentialReference {
  const record = requireRecord(value, "credentialRef");
  const id = requireString(record.id, "credentialRef.id");
  const kind = record.kind;
  if (kind !== "header" && kind !== "env" && kind !== "oauth" && kind !== "custom") throw new HttpError(400, "credentialRef.kind is invalid");
  const version = record.version;
  if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) throw new HttpError(400, "credentialRef.version must be a positive integer");
  return { id, kind, ...(typeof record.label === "string" ? { label: record.label } : {}), ...(version === undefined ? {} : { version }) };
}

function parseProviderProfile(body: Readonly<Record<string, unknown>>, tenantId?: string): ProviderProfileRecord {
  const id = requireString(body.id ?? body.provider, "id").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(id)) throw new HttpError(400, "provider id must be a lowercase identifier");
  const displayName = requireString(body.displayName ?? body.name ?? id, "displayName").trim();
  const protocol = requireString(body.protocol, "protocol").trim().toLowerCase();
  const baseUrl = body.baseUrl === undefined ? undefined : requireString(body.baseUrl, "baseUrl").trim();
  if (baseUrl !== undefined) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new HttpError(400, "baseUrl must be an http(s) URL");
    }
  }
  const rawModels = body.models;
  if (!Array.isArray(rawModels) || rawModels.length > 256) throw new HttpError(400, "models must be an array with at most 256 entries");
  const models: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawModels) {
    const model = typeof raw === "string" ? { model: raw } : requireRecord(raw, "models[]");
    const modelId = requireString(model.model ?? model.id, "models[].model").trim();
    if (modelId.length === 0 || seen.has(modelId)) continue;
    seen.add(modelId);
    const capability = typeof model.contextCapability === "object" && model.contextCapability !== null ? model.contextCapability as NonNullable<ModelCatalogEntry["contextCapability"]> : undefined;
    models.push({
      provider: id,
      model: modelId,
      ...(typeof model.displayName === "string" ? { displayName: model.displayName.slice(0, 200) } : {}),
      ...(typeof model.defaultMaxOutputTokens === "number" && Number.isInteger(model.defaultMaxOutputTokens) && model.defaultMaxOutputTokens > 0 ? { defaultMaxOutputTokens: model.defaultMaxOutputTokens } : {}),
      ...(capability === undefined ? {} : { contextCapability: capability }),
      ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((item): item is "text" | "image" => item === "text" || item === "image") } : {}),
    });
  }
  const enabled = body.enabled === undefined ? true : body.enabled === true;
  const credentialRef = body.credentialRef === undefined ? undefined : parseCredentialReference(body.credentialRef);
  const timestamp = new Date().toISOString();
  return {
    id,
    ...(tenantId === undefined ? {} : { tenantId }),
    displayName,
    protocol,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    models,
    enabled,
    revision: 1,
    source: "custom",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function isCredentialReferenced(tenantId: string, credentialId: string, modelRuntime: ModelRuntimeState, mcp: McpConnectionManager): boolean {
  if ([...modelRuntime.routes.values()].some((route) => route.tenantId === tenantId && route.credentialRef?.id === credentialId)) return true;
  return mcp.configs.list(undefined, tenantId, true).some((config) => config.credentialRef?.id === credentialId);
}

function rebindModelCredential(tenantId: string, credentialId: string, record: import("@coding-agent/contracts").CredentialRecord, host: AgentHost, modelRuntime: ModelRuntimeState, credentials: CredentialVault): void {
  const reference = credentials.reference(record);
  const material = credentials.resolve(reference, tenantId);
  for (const route of [...modelRuntime.routes.values()]) {
    if (route.tenantId !== tenantId || route.credentialRef?.id !== credentialId) continue;
    if (modelRuntime.routeBackend === undefined || material === undefined) {
      clearModelCredential(tenantId, credentialId, host, modelRuntime);
      continue;
    }
    try {
      const selected = selectCatalogModel(modelRuntime, route.model, tenantId, material, route.provider);
      const next: ModelRouteRecord = {
        ...route,
        provider: selected.config.provider,
        model: selected.config.model,
        ...(selected.config.baseUrl === undefined ? {} : { baseUrl: selected.config.baseUrl }),
        ...(selected.model.contextCapability === undefined ? {} : { contextCapability: selected.model.contextCapability }),
        credentialRef: reference,
        updatedAt: new Date().toISOString(),
      };
      const persisted = modelRuntime.routeBackend.upsertModelRoute(next);
      modelRuntime.routes.set(tenantId, persisted);
      host.setTenantModel(tenantId, selected.model, routeSelection(persisted));
    } catch {
      clearModelCredential(tenantId, credentialId, host, modelRuntime);
    }
  }
}

function clearModelCredential(tenantId: string, credentialId: string, host: AgentHost, modelRuntime: ModelRuntimeState): void {
  const route = modelRuntime.routes.get(tenantId);
  if (route?.credentialRef?.id !== credentialId) return;
  modelRuntime.routeBackend?.deleteModelRoute(tenantId);
  modelRuntime.routes.delete(tenantId);
  host.clearTenantModel(tenantId);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, host: AgentHost, mcp: McpConnectionManager, subagents: SubagentRuntime, webRoot: string, persistence: string, modelRuntime: ModelRuntimeState, credentials: CredentialVault, principals: PrincipalBackend | undefined, attachmentPolicy: AttachmentPolicy | undefined, productization: ProductizationServerOptions | undefined, localHostMode: boolean, providerProfileStore: LocalProviderProfileStore | undefined): Promise<void> {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type, idempotency-key, last-event-id");
  response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    const identity = await authenticateRequest(request, url.pathname, productization, principals);
    const localIdentity = localHostMode ? LOCAL_HOST_IDENTITY : undefined;
    const tenantIdentity = identity ?? localIdentity;
    await modelRuntime.selectionRestore;
    const sessionResource = url.pathname.match(/^\/v1\/sessions\/([^/]+)/u);
    if (identity !== undefined && sessionResource?.[1] !== undefined) {
      await assertSessionAccess(host, sessionId(decodeURIComponent(sessionResource[1])), identity);
    }
    if (identity !== undefined && (url.pathname === "/v1/metrics" || url.pathname === "/v1/diagnostics")) throw new HttpError(403, "Global diagnostics are not exposed across tenant scope");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "coding-agent", runtime: "typescript", persistence, ...(modelRuntime.info === undefined ? {} : { model: modelRuntime.info }) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/diagnostics") {
      const rawSessionId = url.searchParams.get("sessionId");
      sendJson(response, 200, await host.diagnostics(rawSessionId === null ? undefined : sessionId(rawSessionId)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/metrics") {
      sendJson(response, 200, { runtime: "typescript", generatedAt: new Date().toISOString(), metrics: host.metrics() });
      return;
    }
    if (url.pathname === "/v1/credentials" || url.pathname.startsWith("/v1/credentials/")) {
      const tenant = requireTenantIdentity(tenantIdentity);
      if (request.method === "GET" && url.pathname === "/v1/credentials") {
        sendJson(response, 200, { credentials: credentials.list(tenant.tenantId).map(publicCredential) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/credentials") {
        const body = await readJson(request);
        sendJson(response, 201, { credential: publicCredential(credentials.create(tenant.tenantId, parseCredentialInput(body))) });
        return;
      }
      const credentialMatch = url.pathname.match(/^\/v1\/credentials\/([^/]+)(?:\/(rotate|revoke))?$/u);
      if (credentialMatch?.[1] !== undefined) {
        const id = decodeURIComponent(credentialMatch[1]);
        if (request.method === "POST" && credentialMatch[2] === "rotate") {
          const body = await readJson(request);
          const rotated = credentials.rotate(tenant.tenantId, id, parseCredentialInput(body));
          await mcp.invalidateCredential(tenant.tenantId, id);
          rebindModelCredential(tenant.tenantId, id, rotated, host, modelRuntime, credentials);
          await mcp.refreshCredential(tenant.tenantId, id, credentials.reference(rotated));
          sendJson(response, 200, { credential: publicCredential(rotated) });
          return;
        }
        if (request.method === "POST" && credentialMatch[2] === "revoke") {
          const revoked = credentials.revoke(tenant.tenantId, id);
          await mcp.invalidateCredential(tenant.tenantId, id);
          clearModelCredential(tenant.tenantId, id, host, modelRuntime);
          sendJson(response, 200, { credential: publicCredential(revoked) });
          return;
        }
        if (request.method === "DELETE" && credentialMatch[2] === undefined) {
          sendJson(response, 200, { removed: credentials.remove(tenant.tenantId, id, isCredentialReferenced(tenant.tenantId, id, modelRuntime, mcp)) });
          return;
        }
      }
      throw new HttpError(404, "credential endpoint not found");
    }
    if (url.pathname === "/v1/providers" || url.pathname.startsWith("/v1/providers/")) {
      const tenantId = tenantIdentity?.tenantId;
      if (request.method === "GET" && url.pathname === "/v1/providers") {
        const snapshot = await modelRuntime.catalog.refresh(tenantId);
        const profiles = modelRuntime.catalog.listProfiles(tenantId).map(publicProviderProfile);
        sendJson(response, 200, { providers: publicCatalogGroups(snapshot.groups), profiles });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/providers") {
        const body = await readJson(request);
        const profile = parseProviderProfile(body, tenantId);
        if (profile.tenantId !== undefined && tenantIdentity === undefined) throw new HttpError(401, "provider profile requires authenticated identity");
        if (profile.credentialRef !== undefined && tenantIdentity === undefined) throw new HttpError(401, "provider credential reference requires authenticated identity");
        if (profile.credentialRef !== undefined && tenantIdentity !== undefined) credentials.requireReference(tenantIdentity.tenantId, profile.credentialRef);
        try {
          // Validate the protocol before making the profile visible to discovery/UI.
          createBuiltInModelProtocolRegistry().get(profile.protocol);
          modelRuntime.catalog.register(profile);
          providerProfileStore?.upsert(profile);
        } catch (error) {
          throw error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        sendJson(response, 201, { provider: publicProviderProfile(profile) });
        return;
      }
      const discoverMatch = url.pathname.match(/^\/v1\/providers\/([^/]+)\/discover$/u);
      if (discoverMatch?.[1] !== undefined && request.method === "POST") {
        const providerId = decodeURIComponent(discoverMatch[1]);
        const profile = modelRuntime.catalog.profile(providerId, tenantId);
        if (profile === undefined) throw new HttpError(404, "provider profile not found");
        const snapshot = await modelRuntime.catalog.refresh(tenantId);
        const group = snapshot.groups.find((item) => item.provider === providerId);
        sendJson(response, group?.status === "failed" ? 503 : 200, { provider: group ?? { provider: providerId, status: "unavailable", models: [] } });
        return;
      }
      throw new HttpError(404, "provider endpoint not found");
    }
    const sessionModelsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/models$/u);
    if (sessionModelsMatch?.[1] !== undefined) {
      if (request.method !== "GET") throw new HttpError(405, "method not allowed");
      const targetSessionId = sessionId(decodeURIComponent(sessionModelsMatch[1]));
      const projection = await host.getSession(targetSessionId);
      if (projection === undefined) throw new HttpError(404, "session not found");
      const effectiveTenantId = projection.ownership?.tenantId ?? (localHostMode ? tenantIdentity?.tenantId : undefined);
      const snapshot = await modelRuntime.catalog.refresh(effectiveTenantId);
      const effective = projection.modelSelection ?? (effectiveTenantId === undefined ? undefined : modelRuntime.routes.get(effectiveTenantId));
      sendJson(response, 200, {
        sessionId: targetSessionId,
        selection: projection.modelSelection ?? null,
        providers: publicCatalogGroups(snapshot.groups),
        ...(effective === undefined ? {} : { effective: { provider: effective.provider, model: effective.model } }),
      });
      return;
    }
    const sessionModelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/model$/u);
    if (sessionModelMatch?.[1] !== undefined) {
      const targetSessionId = sessionId(decodeURIComponent(sessionModelMatch[1]));
      const projection = await host.getSession(targetSessionId);
      if (projection === undefined) throw new HttpError(404, "session not found");
      if (request.method === "GET") {
        const inherited = projection.modelSelection === undefined;
        const effectiveTenantId = projection.ownership?.tenantId ?? (localHostMode ? tenantIdentity?.tenantId : undefined);
        const tenantRoute = effectiveTenantId === undefined ? undefined : modelRuntime.routes.get(effectiveTenantId);
        sendJson(response, 200, {
          sessionId: targetSessionId,
          selection: projection.modelSelection ?? null,
          inherited,
          ...(inherited && tenantRoute === undefined && modelRuntime.info === undefined ? {} : {
            effective: {
              provider: tenantRoute?.provider ?? modelRuntime.info?.provider ?? "custom",
              model: tenantRoute?.model ?? modelRuntime.info?.model ?? "custom",
            },
          }),
        });
        return;
      }
      if (request.method !== "POST") throw new HttpError(405, "method not allowed");
      const body = await readJson(request);
      if (typeof body.model !== "string" || body.model.trim() === "") throw new HttpError(400, "model is required");
      const requestedModel = body.model.trim();
      const reasoningEffort = body.reasoningEffort === undefined ? undefined : requireReasoningEffort(body.reasoningEffort);
      const tenantId = projection.ownership?.tenantId ?? (localHostMode ? tenantIdentity?.tenantId : undefined);
      const currentRoute = tenantId === undefined ? undefined : modelRuntime.routes.get(tenantId);
      const requestedCredential = body.credentialRef === undefined
        ? currentRoute?.credentialRef
        : tenantId === undefined ? undefined : parseCredentialReference(body.credentialRef);
      const requestedProvider = body.provider === undefined ? currentRoute?.provider : typeof body.provider === "string" ? body.provider.trim() : undefined;
      const profileCredential = requestedProvider === undefined ? undefined : modelRuntime.catalog.profile(requestedProvider, tenantId)?.credentialRef;
      const effectiveCredential = requestedCredential ?? profileCredential;
      const material = effectiveCredential === undefined || tenantId === undefined ? undefined : modelRuntime.credentials.resolve(effectiveCredential, tenantId);
      if (effectiveCredential !== undefined && material === undefined) throw new CredentialLifecycleError("CREDENTIAL_REFERENCE_INVALID", "Credential reference is missing, revoked, or stale");
      const selected = selectCatalogModel(modelRuntime, requestedModel, tenantId, material, requestedProvider);
      if (modelRuntime.selector !== undefined && requestedProvider === undefined && modelRuntime.catalog.profile(selected.config.provider, tenantId)?.source !== "custom" && modelRuntime.availableModels.length > 0 && !modelRuntime.availableModels.includes(requestedModel)) throw new HttpError(400, "unsupported model");
      const selection: ContractModelSelection = {
        provider: selected.config.provider,
        model: selected.config.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
      const route: TenantModelRoute = {
        provider: selected.config.provider,
        model: selected.config.model,
        ...(selected.config.baseUrl === undefined ? {} : { baseUrl: selected.config.baseUrl }),
        ...(selected.model.contextCapability === undefined ? {} : { contextCapability: selected.model.contextCapability }),
        ...(effectiveCredential === undefined ? {} : { credentialRef: effectiveCredential }),
      };
      const updated = await host.selectSessionModel(targetSessionId, selection, selected.model, route, commandId(request, body));
      sendJson(response, 200, { sessionId: targetSessionId, selection: updated.modelSelection ?? selection, model: selected.config, effective: { provider: selection.provider, model: selection.model } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      if (modelRuntime.remainingCatalogFailures > 0) {
        modelRuntime.remainingCatalogFailures -= 1;
        throw new HttpError(503, "model catalog temporarily unavailable");
      }
      const catalogSnapshot = await modelRuntime.catalog.refresh(tenantIdentity?.tenantId);
      const route = tenantIdentity === undefined ? undefined : modelRuntime.routes.get(tenantIdentity.tenantId);
      const currentProvider = route?.provider ?? modelRuntime.info?.provider ?? "custom";
      const currentModel = route?.model ?? modelRuntime.info?.model ?? "custom";
      const currentGroup = catalogSnapshot.groups.find((group) => group.provider === currentProvider);
      sendJson(response, 200, {
        provider: currentProvider,
        current: currentModel,
        configured: route === undefined ? modelRuntime.info?.configured ?? false : true,
        models: currentGroup?.models.map((entry) => entry.model) ?? modelRuntime.availableModels,
        providers: publicCatalogGroups(catalogSnapshot.groups),
        profiles: modelRuntime.catalog.listProfiles(tenantIdentity?.tenantId).map(publicProviderProfile),
        ...(currentGroup?.status === "failed" ? { catalogError: currentGroup.error } : {}),
        reasoning: reasoningCapability(currentProvider, host.currentReasoningEffort()),
        ...(route === undefined ? {} : { route: publicModelRoute(route) }),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/models") {
      const body = await readJson(request);
      const reasoningEffort = body.reasoningEffort === undefined ? undefined : requireReasoningEffort(body.reasoningEffort);
      const provider = typeof body.provider === "string" && body.provider.trim() !== "" ? body.provider.trim() : tenantIdentity === undefined ? modelRuntime.info?.provider : modelRuntime.routes.get(tenantIdentity.tenantId)?.provider ?? modelRuntime.info?.provider;
      if (reasoningEffort !== undefined) {
        const capability = reasoningCapability(provider, host.currentReasoningEffort());
        if (!capability.supported || !capability.options.some((option) => option.id === reasoningEffort)) throw new HttpError(400, "unsupported reasoning effort");
        host.setReasoningEffort(reasoningEffort);
      }
      if (body.model === undefined) {
        sendJson(response, 200, { reasoning: reasoningCapability(provider, host.currentReasoningEffort()) });
        return;
      }
      if (typeof body.model !== "string" || body.model.length === 0) throw new HttpError(400, "model is required");
      const requestedCredential = tenantIdentity === undefined || body.credentialRef === undefined ? undefined : parseCredentialReference(body.credentialRef);
      const profileCredential = provider === undefined ? undefined : modelRuntime.catalog.profile(provider, tenantIdentity?.tenantId)?.credentialRef;
      const effectiveCredential = requestedCredential ?? profileCredential;
      const material = effectiveCredential === undefined ? undefined : credentials.resolve(effectiveCredential, tenantIdentity?.tenantId);
      if (effectiveCredential !== undefined && material === undefined) throw new CredentialLifecycleError("CREDENTIAL_REFERENCE_INVALID", "Credential reference is missing, revoked, or stale");
      const selected = selectCatalogModel(modelRuntime, body.model, tenantIdentity?.tenantId, material, provider);
      if (modelRuntime.selector !== undefined && modelRuntime.catalog.profile(selected.config.provider, tenantIdentity?.tenantId)?.source !== "custom" && modelRuntime.availableModels.length > 0 && !modelRuntime.availableModels.includes(body.model)) throw new HttpError(400, "unsupported model");
      if (tenantIdentity === undefined) {
        host.setModel(selected.model);
        modelRuntime.info = selected.config;
        sendJson(response, 200, { model: selected.config, reasoning: reasoningCapability(selected.config.provider, host.currentReasoningEffort()) });
        return;
      }
      const route: ModelRouteRecord = {
        tenantId: tenantIdentity.tenantId,
        provider: selected.config.provider,
        model: selected.config.model,
        ...(selected.config.baseUrl === undefined ? {} : { baseUrl: selected.config.baseUrl }),
        ...(selected.model.contextCapability === undefined ? {} : { contextCapability: selected.model.contextCapability }),
        ...(effectiveCredential === undefined ? {} : { credentialRef: credentials.reference(credentials.requireReference(tenantIdentity.tenantId, effectiveCredential)) }),
        updatedAt: new Date().toISOString(),
      };
      if (modelRuntime.routeBackend === undefined) throw new HttpError(409, "tenant model routing persistence is not configured");
      const persisted = modelRuntime.routeBackend.upsertModelRoute(route);
      host.setTenantModel(tenantIdentity.tenantId, selected.model, routeSelection(persisted));
      modelRuntime.routes.set(tenantIdentity.tenantId, persisted);
      sendJson(response, 200, { model: selected.config, route: publicModelRoute(persisted), reasoning: reasoningCapability(selected.config.provider, host.currentReasoningEffort()) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/tools") {
      sendJson(response, 200, { tools: host.listTools(undefined, tenantIdentity?.tenantId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/skills") {
      const rawSessionId = url.searchParams.get("session_id");
      const targetSessionId = rawSessionId === null || rawSessionId.trim() === "" ? undefined : sessionId(rawSessionId);
      if (targetSessionId !== undefined) {
        const projection = await host.getSession(targetSessionId);
        if (projection === undefined) throw new HttpError(404, "session not found");
        if (identity !== undefined && projection.ownership?.tenantId !== identity.tenantId) throw new HttpError(404, "session not found");
      } else if (identity !== undefined) {
        throw new HttpError(400, "session_id is required for tenant-scoped skill catalog");
      }
      const rawPaths = url.searchParams.get("paths");
      const paths = rawPaths === null ? undefined : rawPaths.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 64);
      const catalog = await host.skillCatalog(targetSessionId, paths);
      const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
      const suggestions = query === "" ? catalog.skills.slice(0, 8) : catalog.skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query)).slice(0, 8);
      sendJson(response, 200, { ...catalog, suggestions });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/plugins") {
      sendJson(response, 200, host.pluginsInventory());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        sendJson(response, 200, { attachments: currentAttachmentCapability(attachmentPolicy, modelRuntime, tenantIdentity?.tenantId), context: host.contextSettings(tenantIdentity?.tenantId), toolExecution: host.toolExecutionSettings(), codeMode: host.codeModeSettings(), lsp: host.lspSettings(), skills: host.skillSettings(), plugins: host.pluginsSettings(), productization: productizationCapability(host.productizationSettings(tenantIdentity?.tenantId), productization, principals, credentials) });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/v1/principals" || url.pathname.startsWith("/v1/principals/"))) {
      if (identity === undefined) throw new HttpError(401, "Principal catalog requires authenticated identity");
      if (principals === undefined) throw new HttpError(409, "Principal catalog is not configured");
      const requestedId = url.pathname === "/v1/principals" ? undefined : decodeURIComponent(url.pathname.slice("/v1/principals/".length));
      const catalog = principals.listPrincipals(identity.tenantId).filter((principal) => requestedId === undefined || principal.id === requestedId);
      if (requestedId !== undefined && catalog.length === 0) throw new HttpError(404, "principal not found");
      sendJson(response, 200, { principals: catalog.map(publicPrincipal) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/workspaces") {
      sendJson(response, 200, await host.listWorkspaces(url.searchParams.get("include_archived") === "true", identity));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/workspaces/reorder") {
      const body = await readJson(request);
      if (!Array.isArray(body.order) || body.order.some((value: unknown) => typeof value !== "string")) throw new HttpError(400, "order must be an array of workspace keys");
      sendJson(response, 200, await host.reorderWorkspaces(body.order as string[], commandId(request, body), identity));
      return;
    }
    const workspaceRenameMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/label$/u);
    if (request.method === "POST" && workspaceRenameMatch?.[1] !== undefined) {
      const body = await readJson(request);
      if (typeof body.label !== "string") throw new HttpError(400, "label is required");
      sendJson(response, 200, await host.renameWorkspace(decodeURIComponent(workspaceRenameMatch[1]), body.label, commandId(request, body), identity));
      return;
    }
    const workspaceArchiveMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/archive$/u);
    if (request.method === "POST" && workspaceArchiveMatch?.[1] !== undefined) {
      const body = await readJson(request);
      const archived = body.archived === undefined ? true : body.archived;
      if (typeof archived !== "boolean") throw new HttpError(400, "archived must be a boolean");
      sendJson(response, 200, await host.archiveWorkspace(decodeURIComponent(workspaceArchiveMatch[1]), archived, commandId(request, body), identity));
      return;
    }
    const workspaceDeleteMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)$/u);
    if (request.method === "DELETE" && workspaceDeleteMatch?.[1] !== undefined) {
      sendJson(response, 200, await host.deleteWorkspace(decodeURIComponent(workspaceDeleteMatch[1]), commandId(request), identity));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/mcp/servers") {
      sendJson(response, 200, { servers: mcp.list(identity?.tenantId) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/mcp/servers") {
      const body = await readJson(request);
      const { start, tenantId: _requestedTenantId, ...configBody } = body;
      if (configBody.credentialRef !== undefined && identity !== undefined) {
        credentials.requireReference(identity.tenantId, parseCredentialReference(configBody.credentialRef));
      }
      const existing = typeof configBody.name === "string" ? mcp.get(configBody.name, identity?.tenantId) : undefined;
      if (typeof body.expectedRevision === "number" && existing?.revision !== body.expectedRevision) throw new HttpError(409, "MCP config revision conflict");
      const scopedConfig = identity === undefined ? configBody : { ...configBody, tenantId: identity.tenantId };
      sendJson(response, 201, await mcp.add(scopedConfig as unknown as McpServerConfig, start !== false));
      return;
    }
    const mcpMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)$/u);
    const mcpResourceMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/resources$/u);
    const mcpCatalogMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/catalog$/u);
    if (mcpCatalogMatch?.[1] !== undefined && request.method === "GET") {
      const name = decodeURIComponent(mcpCatalogMatch[1]);
      const server = mcp.get(name, identity?.tenantId);
      if (server === undefined) throw new HttpError(404, "MCP server not found");
      sendJson(response, 200, { server, discovery: mcp.discovery(name, identity?.tenantId) ?? { tools: [], resources: [], prompts: [] } });
      return;
    }
    if (mcpResourceMatch?.[1] !== undefined && request.method === "GET") {
      const uri = url.searchParams.get("uri");
      if (uri === null || uri.length === 0) throw new HttpError(400, "uri is required");
      sendJson(response, 200, await mcp.readResource(decodeURIComponent(mcpResourceMatch[1]), uri, undefined, identity?.tenantId));
      return;
    }
    const mcpPromptMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/prompts$/u);
    if (mcpPromptMatch?.[1] !== undefined && request.method === "POST") {
      const body = await readJson(request);
      if (typeof body.name !== "string") throw new HttpError(400, "name is required");
      sendJson(response, 200, await mcp.getPrompt(decodeURIComponent(mcpPromptMatch[1]), body.name, body.arguments as Record<string, string> | undefined, undefined, identity?.tenantId));
      return;
    }
    if (mcpMatch?.[1] !== undefined && request.method === "DELETE") {
      const name = decodeURIComponent(mcpMatch[1]);
      if (mcp.get(name, identity?.tenantId) === undefined) throw new HttpError(404, "MCP server not found");
      sendJson(response, 200, { removed: await mcp.remove(name, identity?.tenantId) });
      return;
    }
    const mcpActionMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/(reconnect|enable|disable)$/u);
    if (mcpActionMatch?.[1] !== undefined && mcpActionMatch[2] !== undefined && request.method === "POST") {
      const name = decodeURIComponent(mcpActionMatch[1]);
      const action = mcpActionMatch[2];
      const result = action === "reconnect" ? await mcp.reconnect(name, identity?.tenantId) : await mcp.setEnabled(name, action === "enable", identity?.tenantId);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveIndex(response, webRoot);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/web/")) {
      serveWebAsset(response, webRoot, url.pathname.slice("/web/".length));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/workspaces/validate") {
      const body = await readJson(request);
      if (typeof body.workspaceRoot !== "string" || body.workspaceRoot.trim().length === 0) throw new HttpError(400, "workspaceRoot is required");
      const requested = body.workspaceRoot.trim();
      try {
        const resolved = await realpath(requested);
        const info = await stat(resolved);
        if (!info.isDirectory()) throw new HttpError(400, "workspaceRoot must be a directory");
        sendJson(response, 200, { valid: true, workspaceRoot: resolved, name: path.basename(resolved), isGitRepository: existsSync(path.join(resolved, ".git")) });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "workspaceRoot directory does not exist or is not accessible");
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = await readJson(request);
      const workspaceRoot = typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0 ? body.workspaceRoot : process.cwd();
      const permissionPreset = body.permissionPreset === undefined ? undefined : parsePermissionPreset(body.permissionPreset);
      sendJson(response, 201, await host.createSession(workspaceRoot, permissionPreset, undefined, identity));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions") {
      const sessions = await host.listSessions(url.searchParams.get("include_archived") === "true");
      sendJson(response, 200, { sessions: identity === undefined ? sessions : sessions.filter((session) => session.ownership?.tenantId === identity.tenantId) });
      return;
    }
    const memoryInspectionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/memory$/u);
    if (request.method === "GET" && memoryInspectionMatch?.[1] !== undefined) {
      const targetSessionId = sessionId(decodeURIComponent(memoryInspectionMatch[1]));
      const projection = await host.getSession(targetSessionId);
      if (projection === undefined) throw new HttpError(404, "session not found");
      const responseBody: MemoryInspectionResponse = {
        version: 1,
        sessionId: targetSessionId,
        capability: host.memorySettings(),
        ...(projection.contextSessionMemory === undefined ? {} : { session: projection.contextSessionMemory }),
        ...(projection.contextProjectMemory === undefined ? {} : { project: projection.contextProjectMemory }),
      };
      sendJson(response, 200, responseBody);
      return;
    }
    const attachmentMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attachments$/u);
    if (request.method === "POST" && attachmentMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(attachmentMatch[1]));
      const session = await host.getSession(id);
      if (session === undefined) throw new HttpError(404, "session not found");
      const body = await readJson(request);
      if (typeof body.fileName !== "string") throw new HttpError(400, "fileName is required");
      if (typeof body.mediaType !== "string") throw new HttpError(400, "mediaType is required");
      if (typeof body.data !== "string") throw new HttpError(400, "data is required");
      const idempotencyKey = commandId(request, body) ?? `attachment_${randomUUID()}`;
      let receipt;
      try {
        receipt = await stageAttachment(session, { fileName: body.fileName, mediaType: body.mediaType, data: body.data }, currentAttachmentCapability(attachmentPolicy, modelRuntime), idempotencyKey);
      } catch (error) {
        if (error instanceof AttachmentInputError) throw new HttpError(400, error.message);
        throw error;
      }
      sendJson(response, receipt.status === "accepted" ? 201 : 200, await host.recordAttachment(id, receipt, idempotencyKey));
      return;
    }
    const eventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/u);
    if (request.method === "GET" && eventsMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(eventsMatch[1]));
      const after = parseSequence(url.searchParams.get("after_sequence") ?? request.headers["last-event-id"]);
      const before = parseOptionalSequence(url.searchParams.get("before_sequence"));
      const limit = parsePageLimit(url.searchParams.get("limit"));
      const session = await host.getSession(id);
      if (session === undefined) throw new HttpError(404, "session not found");
      if (url.searchParams.get("format") === "json") {
        if (before !== undefined || limit !== undefined) {
          sendJson(response, 200, await host.eventsPage(id, { afterSequence: after, ...(before === undefined ? {} : { beforeSequence: before }), ...(limit === undefined ? {} : { limit }) }));
        } else {
          sendJson(response, 200, await host.events(id, after));
        }
        return;
      }
      await streamEvents(request, response, host, id, after);
      return;
    }
    const artifactMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/artifacts\/([^/]+)(?:\/(content))?$/u);
    if (request.method === "GET" && artifactMatch?.[1] !== undefined && artifactMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(artifactMatch[1]));
      const session = await host.getSession(id);
      if (session === undefined) throw new HttpError(404, "session not found");
      const access = await inspectArtifact(session, decodeURIComponent(artifactMatch[2]));
      if (access === undefined) throw new HttpError(404, "artifact not found");
      if (artifactMatch[3] === "content") {
        if (!isAvailableArtifact(access)) throw new HttpError(artifactFailureStatus(access), access.reason);
        serveArtifactContent(response, access, url.searchParams.get("download") === "true");
      } else {
        sendJson(response, 200, artifactAccessResponse(access));
      }
      return;
    }
    const scopedEventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/events$/u);
    if (request.method === "GET" && scopedEventsMatch?.[1] !== undefined) {
      const parentSessionId = sessionId(decodeURIComponent(scopedEventsMatch[1]));
      const after = parseSequence(url.searchParams.get("after_sequence") ?? request.headers["last-event-id"]);
      const parent = await host.getSession(parentSessionId);
      if (parent === undefined) throw new HttpError(404, "session not found");
      const children = await subagents.agentCatalog(parentSessionId, "descendants");
      const childSessionIds = children.flatMap((entry) => entry.task.childSessionId === undefined ? [] : [entry.task.childSessionId]);
      if (url.searchParams.get("format") === "json") {
        const events = await scopedEvents(host, parentSessionId, childSessionIds, after);
        sendJson(response, 200, events);
      } else {
        await streamScopedEvents(request, response, host, parentSessionId, childSessionIds, after);
      }
      return;
    }
    const modeMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/mode$/u);
    if (request.method === "POST" && modeMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(modeMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.setSessionPermissionPreset(id, parsePermissionPreset(body.permissionPreset)));
      return;
    }
    const titleMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/title$/u);
    if (request.method === "POST" && titleMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(titleMatch[1]));
      const body = await readJson(request);
      if (typeof body.title !== "string") throw new HttpError(400, "title is required");
      sendJson(response, 200, await host.renameSession(id, body.title, commandId(request, body)));
      return;
    }
    const goalMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goals\/([^/]+)$/u);
    if (request.method === "POST" && goalMatch?.[1] !== undefined && goalMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(goalMatch[1]));
      const body = await readJson(request);
      const input = {
        ...(body.status === undefined ? {} : { status: parseGoalStatus(body.status) }),
        ...(body.title === undefined ? {} : { title: requireString(body.title, "title") }),
        ...(body.successCriteria === undefined ? {} : { successCriteria: requireStringArray(body.successCriteria, "successCriteria") }),
        ...(body.budget === undefined ? {} : { budget: requireRecord(body.budget, "budget") }),
        ...(Object.prototype.hasOwnProperty.call(body, "result") ? { result: body.result } : {}),
        ...(body.reason === undefined ? {} : { reason: requireString(body.reason, "reason") }),
      };
      sendJson(response, 200, await host.updateGoal(id, decodeURIComponent(goalMatch[2]), input, optionalSequence(body.expectedSequence), commandId(request, body)));
      return;
    }
    const planMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/plan$/u);
    if (request.method === "POST" && planMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(planMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.updatePlan(id, requireString(body.content, "content"), parsePlanStatus(body.status), optionalSequence(body.expectedSequence), commandId(request, body)));
      return;
    }
    const todoMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/todos$/u);
    if (request.method === "POST" && todoMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(todoMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.updateTodos(id, parseTodoItems(body.todos), optionalSequence(body.expectedSequence), commandId(request, body)));
      return;
    }
    const worktreesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/worktrees$/u);
    if (worktreesMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(worktreesMatch[1]));
      if (request.method === "GET") {
        sendJson(response, 200, { worktrees: await host.listWorktrees(id) });
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        sendJson(response, 201, await host.createWorktree(id, {
          ...(body.id === undefined ? {} : { id: requireString(body.id, "id") }),
          ...(body.path === undefined ? {} : { path: requireString(body.path, "path") }),
          ...(body.branch === undefined ? {} : { branch: requireString(body.branch, "branch") }),
          ...(body.taskId === undefined ? {} : { taskId: requireString(body.taskId, "taskId") }),
        }, commandId(request, body)));
        return;
      }
    }
    const worktreeActionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/worktrees\/([^/]+)\/(attach|switch|cleanup)$/u);
    if (request.method === "POST" && worktreeActionMatch?.[1] !== undefined && worktreeActionMatch[2] !== undefined && worktreeActionMatch[3] !== undefined) {
      const id = sessionId(decodeURIComponent(worktreeActionMatch[1]));
      const worktreeId = decodeURIComponent(worktreeActionMatch[2]);
      const body = await readJson(request);
      if (worktreeActionMatch[3] === "attach") sendJson(response, 200, await host.attachWorktree(id, worktreeId, commandId(request, body)));
      else if (worktreeActionMatch[3] === "switch") sendJson(response, 200, await host.switchWorktree(id, worktreeId, commandId(request, body)));
      else sendJson(response, 200, await host.cleanupWorktree(id, worktreeId, body.force === true, commandId(request, body)));
      return;
    }
    const archiveMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/archive$/u);
    if (request.method === "POST" && archiveMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(archiveMatch[1]));
      const body = await readJson(request);
      const archived = body.archived === undefined ? true : body.archived;
      if (typeof archived !== "boolean") throw new HttpError(400, "archived must be a boolean");
      sendJson(response, 200, await host.archiveSession(id, archived));
      return;
    }
    const restoreMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/restore$/u);
    if (request.method === "POST" && restoreMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(restoreMatch[1]));
      sendJson(response, 200, await host.archiveSession(id, false));
      return;
    }
    const resumeMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/resume$/u);
    if (request.method === "POST" && resumeMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(resumeMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.resumeSession(id, commandId(request, body)));
      return;
    }
    const permissionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/permissions\/([^/]+)$/u);
    if (request.method === "POST" && permissionMatch?.[1] !== undefined && permissionMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(permissionMatch[1]));
      const body = await readJson(request);
      const status = body.status;
      if (status !== "approved" && status !== "denied" && status !== "cancelled") throw new HttpError(400, "status must be approved, denied, or cancelled");
      sendJson(response, 200, await host.resolvePermission(id, brand<string, "PermissionId">(decodeURIComponent(permissionMatch[2])), status, commandId(request, body)));
      return;
    }
    const interactionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/interactions\/([^/]+)$/u);
    if (request.method === "POST" && interactionMatch?.[1] !== undefined && interactionMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(interactionMatch[1]));
      const body = await readJson(request);
      const status = body.status ?? "answered";
      if (status !== "answered" && status !== "cancelled") throw new HttpError(400, "status must be answered or cancelled");
      if (status === "answered" && typeof body.answer !== "string") throw new HttpError(400, "answer is required when status is answered");
      sendJson(response, 200, await host.resolveInteraction(id, brand<string, "InteractionId">(decodeURIComponent(interactionMatch[2])), status, typeof body.answer === "string" ? body.answer : undefined, commandId(request, body)));
      return;
    }
    const cancelToolMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tools\/([^/]+)\/cancel$/u);
    if (request.method === "POST" && cancelToolMatch?.[1] !== undefined && cancelToolMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(cancelToolMatch[1]));
      const body = await readJson(request);
      const toolCallId = brand<string, "ToolCallId">(decodeURIComponent(cancelToolMatch[2]));
      sendJson(response, 200, { cancelled: await host.cancelTool(id, toolCallId, commandId(request, body)) });
      return;
    }
    const forkMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/u);
    if (request.method === "POST" && forkMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(forkMatch[1]));
      const body = await readJson(request);
      const workspaceRoot = typeof body.workspaceRoot === "string" ? body.workspaceRoot : undefined;
      sendJson(response, 201, { sessionId: await host.forkSession(id, workspaceRoot, commandId(request, body)) });
      return;
    }
    const exportMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/export$/u);
    if (request.method === "GET" && exportMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(exportMatch[1]));
      sendJson(response, 200, await host.exportSession(id));
      return;
    }
    const jobActionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/jobs(?:\/([^/]+)\/(retry|cancel))?$/u);
    if (jobActionMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(jobActionMatch[1]));
      if (request.method === "GET" && jobActionMatch[2] === undefined) {
        sendJson(response, 200, { jobs: await host.listJobs(id) });
        return;
      }
      if (request.method === "POST" && jobActionMatch[2] !== undefined && jobActionMatch[3] !== undefined) {
        const body = await readJson(request);
        const jobId = decodeURIComponent(jobActionMatch[2]);
        if (jobActionMatch[3] === "retry") {
          const backoffMs = body.backoffMs === undefined ? undefined : requireFiniteNumber(body.backoffMs, "backoffMs");
          sendJson(response, 200, await host.retryJob(id, jobId, backoffMs, commandId(request, body)));
        } else {
          sendJson(response, 200, await host.killJob(id, jobId, commandId(request, body)));
        }
        return;
      }
    }
    const subagentsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents$/u);
    if (subagentsMatch?.[1] !== undefined) {
      const parentSessionId = sessionId(decodeURIComponent(subagentsMatch[1]));
      if (request.method === "GET") {
        const scope = url.searchParams.get("scope") === "descendants" ? "descendants" : "children";
        sendJson(response, 200, { agents: await subagents.agentCatalog(parentSessionId, scope) });
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const parent = await host.getSession(parentSessionId);
        if (parent === undefined) throw new HttpError(404, "session not found");
        if (typeof body.prompt !== "string") throw new HttpError(400, "prompt is required");
        const permissionPreset = body.permissionPreset === undefined ? parent.permissionPreset : parsePermissionPreset(body.permissionPreset);
        const receipt = await subagents.spawn({
          parentSessionId,
          prompt: body.prompt,
          workspaceRoot: typeof body.workspaceRoot === "string" ? body.workspaceRoot : parent.workspaceRoot,
          permissionPreset,
          ...(body.mode === "one-shot" || body.mode === "continuable" ? { mode: body.mode } : {}),
          ...(typeof body.background === "boolean" ? { background: body.background } : {}),
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
          ...(Array.isArray(body.toolAllowlist) ? { toolAllowlist: body.toolAllowlist as string[] } : {}),
          ...(Array.isArray(body.mcpAllowlist) ? { mcpAllowlist: body.mcpAllowlist as string[] } : {}),
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.delegationDepth === "number" ? { delegationDepth: body.delegationDepth } : {}),
          ...(typeof body.commandId === "string" ? { commandId: body.commandId } : {}),
          ...(parent.ownership === undefined ? {} : { ownership: parent.ownership }),
        });
        sendJson(response, receipt.report === undefined ? 202 : 200, receipt);
        return;
      }
    }
    const subagentActionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/([^/]+)\/(prompt|interrupt)$/u);
    if (subagentActionMatch?.[1] !== undefined && subagentActionMatch[2] !== undefined && subagentActionMatch[3] !== undefined && request.method === "POST") {
      const parentSessionId = sessionId(decodeURIComponent(subagentActionMatch[1]));
      const taskId = brand<string, "TaskId">(decodeURIComponent(subagentActionMatch[2]));
      const body = await readJson(request);
      if (subagentActionMatch[3] === "prompt") {
        if (typeof body.prompt !== "string") throw new HttpError(400, "prompt is required");
        sendJson(response, 202, await subagents.sendMessage(parentSessionId, taskId, body.prompt));
      } else {
        sendJson(response, 202, await subagents.interrupt(parentSessionId, taskId));
      }
      return;
    }
    const subagentHistoryMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/([^/]+)$/u);
    if (subagentHistoryMatch?.[1] !== undefined && subagentHistoryMatch[2] !== undefined && request.method === "GET") {
      const parentSessionId = sessionId(decodeURIComponent(subagentHistoryMatch[1]));
      const taskId = brand<string, "TaskId">(decodeURIComponent(subagentHistoryMatch[2]));
      const output = await subagents.taskOutput(parentSessionId, taskId);
      if (output === undefined) throw new HttpError(404, "task not found");
      sendJson(response, 200, output);
      return;
    }
    const taskMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tasks\/([^/]+)(?:\/(output|cancel))?$/u);
    if (taskMatch?.[1] !== undefined && taskMatch[2] !== undefined) {
      const parentSessionId = sessionId(decodeURIComponent(taskMatch[1]));
      const taskId = brand<string, "TaskId">(decodeURIComponent(taskMatch[2]));
      if (request.method === "GET" && taskMatch[3] === undefined) {
        const task = await subagents.taskQuery(parentSessionId, taskId);
        if (task === undefined) throw new HttpError(404, "task not found");
        sendJson(response, 200, task);
        return;
      }
      if (request.method === "GET" && taskMatch[3] === "output") {
        const output = await subagents.taskOutput(parentSessionId, taskId);
        if (output === undefined) throw new HttpError(404, "task not found");
        sendJson(response, 200, output);
        return;
      }
      if (request.method === "POST" && taskMatch[3] === "cancel") {
        const body = await readJson(request);
        sendJson(response, 200, await subagents.cancel(parentSessionId, taskId, commandId(request, body)));
        return;
      }
    }
    const cancelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/u);
    if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(cancelMatch[1]));
      const body = await readJson(request);
      const rawTurnId = body.turnId;
      if (typeof rawTurnId !== "string") throw new HttpError(400, "turnId is required");
      sendJson(response, 200, { cancelled: await host.cancelTurn(id, turnId(rawTurnId), commandId(request, body)) });
      return;
    }
    const queueMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/queue$/u);
    if (request.method === "POST" && queueMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(queueMatch[1]));
      const body = await readJson(request);
      if (typeof body.turnId !== "string") throw new HttpError(400, "turnId is required");
      if (typeof body.position !== "number" || !Number.isFinite(body.position)) throw new HttpError(400, "position is required");
      sendJson(response, 200, await host.reorderQueue(id, turnId(body.turnId), body.position, commandId(request, body)));
      return;
    }
    const steerMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/steer$/u);
    if (request.method === "POST" && steerMatch?.[1] !== undefined && steerMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(steerMatch[1]));
      const targetTurn = turnId(decodeURIComponent(steerMatch[2]));
      const body = await readJson(request);
      if (typeof body.content !== "string") throw new HttpError(400, "content is required");
      sendJson(response, 200, await host.steerTurn(id, targetTurn, body.content, commandId(request, body)));
      return;
    }
    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/u);
    if (sessionMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(sessionMatch[1]));
      if (request.method === "DELETE") {
        const deleted = await host.deleteSession(id);
        sendJson(response, 200, { deleted: true, sessionId: deleted.id });
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const content = body.content;
        if (typeof content !== "string") throw new HttpError(400, "content is required");
        if (/^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\s|$)/u.test(content)) {
          const invoked = await host.invokeSkill(id, content, commandId(request, body));
          if (invoked !== undefined) {
            sendJson(response, invoked.status === "awaiting_permission" ? 202 : 200, invoked);
            return;
          }
        }
        const reasoningEffort = body.reasoningEffort === undefined ? undefined : requireReasoningEffort(body.reasoningEffort);
        sendJson(response, 202, { turnId: await host.sendMessage(id, content, commandId(request, body), reasoningEffort === undefined ? undefined : { reasoningEffort }) });
        return;
      }
      if (request.method === "GET") {
        const projection = await host.getSession(id);
        if (projection === undefined) throw new HttpError(404, "session not found");
        sendJson(response, 200, projection);
        return;
      }
    }
    const toolsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tools$/u);
    if (request.method === "POST" && toolsMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(toolsMatch[1]));
      const body = await readJson(request);
      if (typeof body.name !== "string") throw new HttpError(400, "name is required");
      const result = await host.executeTool(id, body.name, body.input, typeof body.turnId === "string" ? turnId(body.turnId) : undefined, commandId(request, body));
      sendJson(response, result.status === "awaiting_permission" ? 202 : 200, result);
      return;
    }
    throw new HttpError(404, "not found");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    const status = error instanceof HttpError ? error.status : code === "INVALID_TOOL_INPUT" ? 400 : code === "TOOL_NOT_FOUND" || code === "WORKSPACE_NOT_FOUND" || code === "MCP_SERVER_NOT_FOUND" || code === "CREDENTIAL_NOT_FOUND" ? 404 : code === "TOOL_DISABLED" ? 409 : code === "MODEL_CONFIGURATION_ERROR" || code === "CREDENTIAL_REFERENCE_INVALID" ? 400 : code === "SESSION_QUOTA_EXCEEDED" || code === "TURN_QUOTA_EXCEEDED" ? 429 : code === "WORKSPACE_ORDER_INVALID" ? 400 : code === "MCP_TENANT_SCOPE_CONFLICT" || code === "COMMAND_CONFLICT" || code === "WORKTREE_DIRTY" || code === "WORKTREE_INVALID" || code === "WORKTREE_EXISTS" || code === "CREDENTIAL_BACKEND_NOT_CONFIGURED" || code === "CREDENTIAL_IN_USE" ? 409 : code === "CREDENTIAL_SECRET_PROVIDER_UNAVAILABLE" ? 503 : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) {
      if (status === 401) response.setHeader("www-authenticate", "Bearer");
      sendJson(response, status, { error: message });
    }
    else response.end();
  }
}

async function streamEvents(request: IncomingMessage, response: ServerResponse, host: AgentHost, id: ReturnType<typeof sessionId>, after: number): Promise<void> {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(": connected\n\n");
  let replaying = true;
  let buffered: AgentEvent[] = [];
  let lastSent = after;
  const unsubscribe = host.subscribe(id, (event) => {
    if (replaying) buffered.push(event);
    else if (event.sequence > lastSent) {
      writeEvent(response, event);
      lastSent = event.sequence;
    }
  });
  const close = () => unsubscribe();
  request.on("close", close);
  try {
    const historical = await host.events(id, after);
    for (const event of historical) {
      if (event.sequence > lastSent) {
        writeEvent(response, event);
        lastSent = event.sequence;
      }
    }
    replaying = false;
    for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence > lastSent) {
        writeEvent(response, event);
        lastSent = event.sequence;
      }
    }
    buffered = [];
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

async function scopedEvents(host: AgentHost, parentSessionId: ReturnType<typeof sessionId>, childSessionIds: readonly ReturnType<typeof sessionId>[], after: number): Promise<readonly { readonly sessionId: string; readonly event: AgentEvent }[]> {
  const ids = [parentSessionId, ...childSessionIds];
  const items: { readonly sessionId: string; readonly event: AgentEvent }[] = [];
  for (const id of ids) for (const event of await host.events(id, after)) items.push({ sessionId: id, event });
  return items.sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt) || left.event.sequence - right.event.sequence);
}

async function streamScopedEvents(request: IncomingMessage, response: ServerResponse, host: AgentHost, parentSessionId: ReturnType<typeof sessionId>, childSessionIds: readonly ReturnType<typeof sessionId>[], after: number): Promise<void> {
  response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream; charset=utf-8" });
  response.write(": connected\n\n");
  const ids = [parentSessionId, ...childSessionIds];
  const seen = new Set<string>();
  let replaying = true;
  const buffered: { readonly sessionId: string; readonly event: AgentEvent }[] = [];
  const unsubscribe = ids.map((id) => host.subscribe(id, (event) => {
    const key = `${id}:${event.sequence}`;
    if (seen.has(key)) return;
    if (replaying) buffered.push({ sessionId: id, event });
    else { seen.add(key); writeScopedEvent(response, id, event); }
  }));
  const close = () => unsubscribe.forEach((dispose) => dispose());
  request.on("close", close);
  const historical = await scopedEvents(host, parentSessionId, childSessionIds, after);
  for (const item of historical) {
    const key = `${item.sessionId}:${item.event.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writeScopedEvent(response, item.sessionId, item.event);
  }
  replaying = false;
  for (const item of buffered.sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt))) {
    const key = `${item.sessionId}:${item.event.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writeScopedEvent(response, item.sessionId, item.event);
  }
}

function commandId(request: IncomingMessage, body: Record<string, unknown> = {}): string | undefined {
  const header = request.headers["idempotency-key"];
  if (typeof header === "string" && header.length > 0) return header;
  return typeof body.commandId === "string" && body.commandId.length > 0 ? body.commandId : undefined;
}

async function authenticateRequest(request: IncomingMessage, pathname: string, productization: ProductizationServerOptions | undefined, principals: PrincipalBackend | undefined): Promise<SessionOwnership | undefined> {
  const auth = productization?.auth;
  if (auth === undefined) return undefined;
  const publicPath = pathname === "/health" || pathname === "/" || pathname === "/index.html" || pathname.startsWith("/web/");
  const header = request.headers.authorization;
  const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (presented === undefined || presented.length === 0) {
    if (auth.required === true && !publicPath) throw new HttpError(401, "Bearer authentication is required");
    return undefined;
  }
  for (const candidate of auth.tokens) {
    const left = Buffer.from(presented);
    const right = Buffer.from(candidate.token);
    if (left.length !== right.length) continue;
    if (!timingSafeEqual(left, right)) continue;
    return { principalId: brand<string, "PrincipalId">(candidate.principalId), tenantId: brand<string, "TenantId">(candidate.tenantId) };
  }
  if (auth.jwt !== undefined) {
    try {
      return await verifyProductizationJwt(presented, auth.jwt, principals);
    } catch (error) {
      throw new HttpError(401, error instanceof Error ? error.message : "Invalid JWT");
    }
  }
  throw new HttpError(401, "Invalid bearer token");
}

async function assertSessionAccess(host: AgentHost, id: ReturnType<typeof sessionId>, identity: SessionOwnership): Promise<void> {
  const projection = await host.getSession(id);
  if (projection === undefined || projection.ownership?.tenantId !== identity.tenantId) throw new HttpError(404, "session not found");
}

function productizationCapability(base: ProductizationCapability, policy: ProductizationServerOptions | undefined, principals: PrincipalBackend | undefined, credentials: CredentialVault): ProductizationCapability {
  const auth = policy?.auth;
  if (auth === undefined && policy?.quota === undefined && credentials.secretStoreKind() === "host-only") return base;
  const jwtConfigured = auth?.jwt !== undefined && principals !== undefined && auth.jwt.keys.length > 0;
  const authStatus = auth === undefined ? base.auth.status : jwtConfigured || auth.tokens.length > 0 ? "configured" : auth.required === true ? "unavailable" : base.auth.status;
  const authEnabled = auth?.required === true && (auth.tokens.length > 0 || jwtConfigured);
  const quotaEnabled = authEnabled && base.quota.status === "configured";
  return {
    ...base,
    enabled: authEnabled || quotaEnabled,
    status: authEnabled ? "configured" : base.status,
    reason: authEnabled ? "Bearer authentication and durable tenant-scoped Session ownership are enabled for this host." : base.reason,
    auth: { status: authStatus, mode: auth?.jwt === undefined ? (auth === undefined || auth.tokens.length === 0 ? "disabled" : "bearer") : "jwt", required: auth?.required === true },
    multiUser: auth?.jwt === undefined ? base.multiUser : { status: principals === undefined ? "unavailable" : "configured", principalCatalog: "external" },
    credentials: { ...base.credentials, status: credentials.secretStoreKind() === "external" ? "configured" : base.credentials.status, secretStore: credentials.secretStoreKind(), redaction: "required" },
    tenantIsolation: authEnabled ? { status: "configured", sessionOwnership: "durable" } : base.tenantIsolation,
    quota: quotaEnabled ? base.quota : policy?.quota === undefined ? base.quota : { status: "deferred", enforcement: "disabled" },
  };
}

function routeSelection(route: ModelRouteRecord): TenantModelRoute {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
    ...(route.credentialRef === undefined ? {} : { credentialRef: route.credentialRef }),
    ...(route.contextCapability === undefined ? {} : { contextCapability: route.contextCapability }),
  };
}

async function restoreSessionSelections(store: SessionEventStore | undefined, host: AgentHost, modelRuntime: ModelRuntimeState, localHostMode: boolean): Promise<void> {
  if (store === undefined) return;
  for (const summary of await store.listSessions(true)) {
    const projection = await store.project(summary.id);
    const selection = projection?.modelSelection;
    if (selection === undefined) continue;
    const tenantId = projection?.ownership?.tenantId ?? (localHostMode ? "local" : undefined);
    const route = tenantId === undefined ? undefined : modelRuntime.routes.get(tenantId);
    const material = route?.credentialRef === undefined || tenantId === undefined ? undefined : modelRuntime.credentials.resolve(route.credentialRef, tenantId);
    if (route?.credentialRef !== undefined && material === undefined) continue;
    try {
      const selected = selectCatalogModel(modelRuntime, selection.model, tenantId, material, selection.provider);
      const restoredRoute: TenantModelRoute | undefined = route === undefined
        ? selected.config.baseUrl === undefined && selected.model.contextCapability === undefined ? undefined : {
          provider: selected.config.provider,
          model: selected.config.model,
          ...(selected.config.baseUrl === undefined ? {} : { baseUrl: selected.config.baseUrl }),
          ...(selected.model.contextCapability === undefined ? {} : { contextCapability: selected.model.contextCapability }),
        }
        : routeSelection(route);
      host.setSessionModel(summary.id, selected.model, selection, restoredRoute);
    } catch {
      // Keep the durable selection visible, but fail closed to the tenant/default
      // route until credentials or the provider configuration become available.
    }
  }
}

function publicModelRoute(route: ModelRouteRecord): Record<string, unknown> {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
    ...(route.credentialRef === undefined ? {} : { credentialRef: route.credentialRef }),
    ...(route.contextCapability === undefined ? {} : { contextCapability: route.contextCapability }),
    updatedAt: route.updatedAt,
  };
}

function publicPrincipal(principal: import("@coding-agent/contracts").PrincipalRecord): Record<string, unknown> {
  return { id: principal.id, subject: principal.subject, tenantId: principal.tenantId, ...(principal.displayName === undefined ? {} : { displayName: principal.displayName }), roles: principal.roles, status: principal.status, createdAt: principal.createdAt, updatedAt: principal.updatedAt };
}

function serveIndex(response: ServerResponse, webRoot: string): void {
  const file = path.join(webRoot, "index.html");
  if (!existsSync(file)) throw new HttpError(404, "web shell not found");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(file).pipe(response);
}

function serveWebAsset(response: ServerResponse, webRoot: string, requestedPath: string): void {
  const assetRoot = path.resolve(webRoot, "dist");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    throw new HttpError(400, "invalid web asset encoding");
  }
  const file = path.resolve(assetRoot, decodedPath);
  const relative = path.relative(assetRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new HttpError(403, "invalid web asset path");
  if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "web asset not found");
  const extension = path.extname(file).toLowerCase();
  const contentType = extension === ".js" ? "text/javascript; charset=utf-8"
    : extension === ".map" ? "application/json; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
        : "application/octet-stream";
  response.writeHead(200, { "cache-control": "no-cache", "content-type": contentType });
  createReadStream(file).pipe(response);
}

function serveArtifactContent(response: ServerResponse, access: Extract<ArtifactAccess, { availability: "available" }>, download: boolean): void {
  const disposition = download ? "attachment" : "inline";
  const filename = encodeURIComponent(access.fileName);
  const asciiFilename = access.fileName.replace(/[^\x20-\x7E]/gu, "_");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-disposition": `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${filename}`,
    "content-length": String(access.sizeBytes),
    "content-type": access.contentType,
    "x-content-type-options": "nosniff",
  });
  const stream = createReadStream(access.filePath);
  stream.on("error", () => { if (!response.destroyed) response.destroy(); });
  stream.pipe(response);
}

function artifactFailureStatus(access: ArtifactAccess): number {
  switch (access.availability) {
    case "blocked": return 403;
    case "missing": return 404;
    case "too_large": return 413;
    case "external":
    case "not_file":
    case "unavailable": return 409;
    case "available": return 200;
  }
}

function writeEvent(response: ServerResponse, event: { sequence: number; type: string; payload: unknown }): void {
  if (response.destroyed) return;
  response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function writeScopedEvent(response: ServerResponse, sessionId: string, event: AgentEvent): void {
  if (response.destroyed) return;
  response.write(`id: ${sessionId}:${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ sessionId, event })}\n\n`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const content = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(content) });
  response.end(content);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 1_048_576) throw new HttpError(413, "request body too large");
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "JSON object required");
  return value as Record<string, unknown>;
}

function parseSequence(value: string | string[] | null | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === null || raw === undefined || raw === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseOptionalSequence(value: string | string[] | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePageLimit(value: string | string[] | null | undefined): number | undefined {
  const parsed = parseOptionalSequence(value);
  return parsed === undefined ? undefined : Math.min(1_000, Math.max(1, parsed));
}

function parsePermissionPreset(value: unknown): PermissionPreset {
  if (value === "read-only" || value === "workspace-write" || value === "ask-on-write" || value === "ask-on-execute" || value === "workspace-full-access" || value === "danger-full-access") return value;
  throw new HttpError(400, "permissionPreset must be read-only, workspace-write, ask-on-write, ask-on-execute, workspace-full-access, or danger-full-access");
}

function requireReasoningEffort(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "reasoningEffort must be a string");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized) || normalized.length > 64) throw new HttpError(400, "reasoningEffort is invalid");
  return normalized;
}

function reasoningCapability(provider: string | undefined, current: string | undefined): {
  readonly supported: boolean;
  readonly current?: string;
  readonly options: readonly { readonly id: string; readonly label: string; readonly description: string }[];
} {
  const supported = provider === "deepseek";
  const options = supported ? [
    { id: "default", label: "Default", description: "Use the provider default" },
    { id: "off", label: "Off", description: "Disable extra reasoning when supported" },
    { id: "high", label: "High", description: "More deliberate work" },
    { id: "max", label: "Max", description: "Highest available effort" },
  ] : [];
  return { supported, ...(current === undefined ? {} : { current }), options };
}

function parseGoalStatus(value: unknown): GoalStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "blocked" || value === "cancelled") return value;
  throw new HttpError(400, "goal status must be active, paused, completed, blocked, or cancelled");
}

function parsePlanStatus(value: unknown): PlanStatus {
  if (value === "draft" || value === "active" || value === "approved" || value === "rejected" || value === "cleared") return value;
  throw new HttpError(400, "plan status must be draft, active, approved, rejected, or cleared");
}

function optionalSequence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new HttpError(400, "expectedSequence must be a non-negative integer");
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new HttpError(400, `${field} must be a non-negative number`);
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HttpError(400, `${field} must be an array of strings`);
  return value as string[];
}

function requireRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, `${field} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function parseTodoItems(value: unknown): readonly TodoItem[] {
  if (!Array.isArray(value)) throw new HttpError(400, "todos must be an array");
  return value.map((item): TodoItem => {
    if (typeof item !== "object" || item === null) throw new HttpError(400, "todo items must be objects");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.content !== "string") throw new HttpError(400, "todo id and content are required");
    if (record.status !== "pending" && record.status !== "in_progress" && record.status !== "completed" && record.status !== "cancelled") throw new HttpError(400, "invalid todo status");
    return { id: record.id, content: record.content, status: record.status, ...(typeof record.activeForm === "string" ? { activeForm: record.activeForm } : {}) };
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env["PORT"] ?? "3210", 10);
  createConfiguredApiServer().listen(port, "127.0.0.1", () => {
    console.log(`Coding Agent API listening on http://127.0.0.1:${port}`);
  });
}
