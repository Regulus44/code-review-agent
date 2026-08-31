import type {
  AgentEvent,
  AttachmentReceipt,
  ArtifactRef,
  InteractionId,
  GoalStatus,
  PermissionId,
  PermissionPreset,
  PlanStatus,
  SessionId,
  SessionProjection,
  SessionSummary,
  TaskId,
  TaskProjection,
  TodoItem,
  ToolRiskLevel,
  ToolSource,
  TurnId,
  WorkspaceCatalog,
  WorktreeProjection,
  ProductizationCapability,
  McpCredentialReference,
  CredentialRecord,
  ModelCatalogEntry,
  ModelSelection,
  ProviderCatalogGroup,
  ProviderProfileRecord,
} from "@code-review-agent/contracts";

export interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly executionMode: "parallel" | "exclusive";
  readonly riskLevel: ToolRiskLevel;
  readonly approvalMode: "auto" | "ask" | "deny";
  readonly interruptBehavior: "cancel" | "block";
  readonly source: ToolSource;
}

export interface ModelCatalogResponse {
  readonly provider: string;
  readonly current: string;
  readonly configured: boolean;
  readonly models: readonly string[];
  readonly providers?: readonly ProviderCatalogGroup[];
  readonly profiles?: readonly Readonly<Record<string, unknown>>[];
  readonly catalogError?: string;
  readonly reasoning?: {
    readonly supported: boolean;
    readonly current?: string;
    readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  };
  readonly route?: {
    readonly provider: string;
    readonly model: string;
    readonly baseUrl?: string;
    readonly credentialRef?: McpCredentialReference;
    readonly updatedAt: string;
  };
}

export interface ProviderCatalogResponse {
  readonly providers: readonly ProviderCatalogGroup[];
  readonly profiles: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Session-scoped model directory returned by the Host. `selection` is null when
 * the session inherits its effective route; `effective` is the route that will
 * be used for the next turn in that case. Provider groups are advisory catalog
 * data and never contain credential material.
 */
export interface SessionModelsResponse {
  readonly sessionId: SessionId;
  readonly selection: ModelSelection | null;
  readonly providers: readonly ProviderCatalogGroup[];
  readonly effective?: {
    readonly provider: string;
    readonly model: string;
  };
}

/** Current Session selection and inheritance state. */
export interface SessionModelSelectionResponse {
  readonly sessionId: SessionId;
  readonly selection: ModelSelection | null;
  readonly inherited?: boolean;
  readonly effective?: {
    readonly provider: string;
    readonly model: string;
  };
}

/** Receipt returned after a Session-scoped model switch. */
export interface SessionModelSelectionMutationResponse {
  readonly sessionId: SessionId;
  readonly selection: ModelSelection;
  readonly model: Readonly<Record<string, unknown>>;
  readonly effective: {
    readonly provider: string;
    readonly model: string;
  };
}

export interface ProviderProfileInput {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: string;
  readonly baseUrl?: string;
  readonly credentialRef?: McpCredentialReference;
  readonly models: readonly (string | Omit<ModelCatalogEntry, "provider">)[];
  readonly enabled?: boolean;
}

export interface CredentialMaterialInput {
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CredentialMutationInput {
  readonly kind: McpCredentialReference["kind"];
  readonly label?: string;
  readonly material: CredentialMaterialInput;
}

export interface CredentialListResponse {
  readonly credentials: readonly CredentialRecord[];
}

export interface AttachmentCapability {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly allowedMediaTypes: readonly string[];
  readonly imagesEnabled: boolean;
  readonly reason?: string;
}

export interface ContextCapability {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly budget?: {
    readonly maxTokens?: number;
    readonly recentMessageTokens?: number;
    readonly maxToolResultChars?: number;
    readonly maxSummaryChars?: number;
  };
  readonly collapse?: {
    readonly version: 1;
    readonly enabled: boolean;
    readonly status: "deferred" | "unavailable";
    readonly reason: string;
    readonly features: {
      readonly readTimeProjection: boolean;
      readonly backgroundCollapse: boolean;
      readonly overflowDrain: boolean;
      readonly snip: boolean;
    };
  };
}

export interface CodeModeCapability {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly limits?: {
    readonly maxCodeBytes?: number;
    readonly maxRuntimeMs?: number;
    readonly maxOutputBytes?: number;
    readonly network?: "disabled";
    readonly networkEnforcement?: "process-policy" | "os-required";
    readonly osNetworkIsolation?: boolean;
    readonly [key: string]: unknown;
  };
}

export interface LspCapability {
  readonly configured: boolean;
  readonly servers: readonly string[];
}

export interface PluginsCapability {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly status: "available" | "deferred" | "unavailable";
  readonly reason: string;
}

export type ProductizationCapabilityResponse = ProductizationCapability;

export interface CapabilityResponse {
  readonly attachments: AttachmentCapability;
  readonly context: ContextCapability;
  readonly toolExecution: {
    readonly maxParallelToolCalls: number;
  };
  readonly codeMode: CodeModeCapability;
  readonly lsp: LspCapability;
  readonly plugins: PluginsCapability;
  readonly productization: ProductizationCapabilityResponse;
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly service: string;
  readonly runtime: string;
  readonly persistence: string;
  readonly model?: Readonly<Record<string, unknown>>;
}

export interface McpServerView {
  readonly name?: string;
  readonly status?: string;
  readonly revision?: number;
  readonly generation?: number;
  readonly [key: string]: unknown;
}

export interface SubagentCatalogEntry {
  readonly task: TaskProjection;
  readonly status: string;
  readonly live: boolean;
  readonly resumable: boolean;
}

export interface TaskOutputResponse {
  readonly task: TaskProjection;
  readonly report?: Readonly<Record<string, unknown>>;
  readonly events: readonly AgentEvent[];
}

export interface JobSummaryResponse {
  readonly jobId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly command: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "orphaned";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly bufferedBytes: number;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly spillPath?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly deadlineAt?: string;
  readonly retryable: boolean;
  readonly lastError?: { readonly code: string; readonly message: string };
}

export type ArtifactAvailability = "available" | "external" | "blocked" | "missing" | "not_file" | "too_large" | "unavailable";

export interface ArtifactAccessResponse {
  readonly taskId: string;
  readonly artifact: ArtifactRef;
  readonly availability: ArtifactAvailability;
  readonly reason: string;
  readonly sizeBytes?: number;
  readonly contentType?: string;
}

export interface EventPageResponse {
  readonly events: readonly AgentEvent[];
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly oldestSequence?: number;
  readonly newestSequence?: number;
}

export interface EventPageOptions {
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly limit?: number;
}

export interface CreateSessionResponse extends SessionProjection {}

export interface WebApiClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** Typed error returned by a Web API command. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${status}`;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Browser-facing command/query client. It owns URL construction, JSON parsing,
 * error normalization and idempotency headers; state projection belongs to
 * SessionStore rather than this transport class.
 */
export class WebApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: WebApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/u, "");
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health");
  }

  /**
   * `includeArchived` is a Web navigation filter. It selects the host-backed
   * projection returned by this query; it does not mutate SessionSummary.archived.
   */
  listSessions(includeArchived = false): Promise<{ readonly sessions: readonly SessionSummary[] }> {
    return this.request(`/v1/sessions?include_archived=${String(includeArchived)}`);
  }

  /** `includeArchived` has the same read-only filter semantics as listSessions. */
  listWorkspaces(includeArchived = false): Promise<WorkspaceCatalog> {
    return this.request<WorkspaceCatalog>(`/v1/workspaces${includeArchived ? "?include_archived=true" : ""}`);
  }

  reorderWorkspaces(order: readonly string[], commandId?: string): Promise<WorkspaceCatalog> {
    return this.request<WorkspaceCatalog>("/v1/workspaces/reorder", {
      method: "POST",
      commandId,
      body: { order },
    });
  }

  renameWorkspace(key: string, label: string, commandId?: string): Promise<WorkspaceCatalog> {
    return this.request<WorkspaceCatalog>(`/v1/workspaces/${encodeURIComponent(key)}/label`, {
      method: "POST",
      commandId,
      body: { label },
    });
  }

  archiveWorkspace(key: string, archived = true, commandId?: string): Promise<WorkspaceCatalog> {
    return this.request<WorkspaceCatalog>(`/v1/workspaces/${encodeURIComponent(key)}/archive`, {
      method: "POST",
      commandId,
      body: { archived },
    });
  }

  deleteWorkspace(key: string, commandId?: string): Promise<WorkspaceCatalog> {
    return this.request<WorkspaceCatalog>(`/v1/workspaces/${encodeURIComponent(key)}`, {
      method: "DELETE",
      commandId,
    });
  }

  createSession(workspaceRoot: string, permissionPreset?: PermissionPreset): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>("/v1/sessions", {
      method: "POST",
      body: { workspaceRoot, ...(permissionPreset === undefined ? {} : { permissionPreset }) },
    });
  }

  getSession(sessionId: SessionId): Promise<SessionProjection | undefined> {
    return this.request<SessionProjection>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  listEvents(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    return this.request<readonly AgentEvent[]>(`/v1/sessions/${encodeURIComponent(sessionId)}/events?format=json&after_sequence=${afterSequence}`);
  }

  listEventsPage(sessionId: SessionId, options: EventPageOptions = {}): Promise<EventPageResponse> {
    const params = new URLSearchParams({ format: "json" });
    if (options.afterSequence !== undefined) params.set("after_sequence", String(Math.max(0, Math.floor(options.afterSequence))));
    if (options.beforeSequence !== undefined) params.set("before_sequence", String(Math.max(0, Math.floor(options.beforeSequence))));
    if (options.limit !== undefined) params.set("limit", String(Math.min(1_000, Math.max(1, Math.floor(options.limit)))));
    return this.request<unknown>(`/v1/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`).then(normalizeEventPage);
  }

  listJobs(sessionId: SessionId): Promise<{ readonly jobs: readonly JobSummaryResponse[] }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/jobs`);
  }

  retryJob(sessionId: SessionId, jobId: string, backoffMs?: number, commandId?: string): Promise<unknown> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", commandId, body: backoffMs === undefined ? {} : { backoffMs } });
  }

  cancelJob(sessionId: SessionId, jobId: string, commandId?: string): Promise<unknown> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", commandId, body: {} });
  }

  exportSession(sessionId: SessionId): Promise<{ readonly session: SessionProjection; readonly events: readonly AgentEvent[] }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/export`);
  }

  diagnostics(sessionId?: SessionId): Promise<Readonly<Record<string, unknown>>> {
    return this.request(sessionId === undefined ? "/v1/diagnostics" : `/v1/diagnostics?sessionId=${encodeURIComponent(sessionId)}`);
  }

  metrics(): Promise<Readonly<Record<string, unknown>>> {
    return this.request("/v1/metrics");
  }

  sendMessage(sessionId: SessionId, content: string, commandId?: string, reasoningEffort?: string): Promise<{ readonly turnId: TurnId }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      commandId,
      body: { content, ...(reasoningEffort === undefined || reasoningEffort === "default" ? {} : { reasoningEffort }) },
    });
  }

  setPermissionPreset(sessionId: SessionId, permissionPreset: PermissionPreset, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/mode`, {
      method: "POST",
      commandId,
      body: { permissionPreset },
    });
  }

  renameSession(sessionId: SessionId, title: string, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/title`, {
      method: "POST",
      commandId,
      body: { title },
    });
  }

  archiveSession(sessionId: SessionId, archived = true, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, {
      method: "POST",
      commandId,
      body: { archived },
    });
  }

  restoreSession(sessionId: SessionId, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST", commandId, body: {} });
  }

  deleteSession(sessionId: SessionId, commandId?: string): Promise<{ readonly deleted: boolean; readonly sessionId: SessionId }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", commandId });
  }

  cancelTurn(sessionId: SessionId, turnId: TurnId, commandId?: string): Promise<{ readonly cancelled: boolean }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      commandId,
      body: { turnId },
    });
  }

  reorderQueue(sessionId: SessionId, turnId: TurnId, position: number, commandId?: string): Promise<{ readonly reordered: boolean; readonly queuedTurnIds: readonly TurnId[] }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/queue`, {
      method: "POST",
      commandId,
      body: { turnId, position },
    });
  }

  steerTurn(sessionId: SessionId, turnId: TurnId, content: string, commandId?: string): Promise<{ readonly accepted: boolean; readonly turnId: TurnId; readonly receiptId?: string }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/steer`, {
      method: "POST",
      commandId,
      body: { content },
    });
  }

  resolvePermission(sessionId: SessionId, permissionId: PermissionId, status: "approved" | "denied" | "cancelled", commandId?: string): Promise<unknown> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: "POST",
      commandId,
      body: { status },
    });
  }

  resolveInteraction(sessionId: SessionId, interactionId: InteractionId, answer?: string, status: "answered" | "cancelled" = "answered", commandId?: string): Promise<unknown> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}`, {
      method: "POST",
      commandId,
      body: { status, ...(answer === undefined ? {} : { answer }) },
    });
  }

  updateGoal(sessionId: SessionId, goalId: string, input: { readonly status?: GoalStatus; readonly title?: string; readonly successCriteria?: readonly string[]; readonly budget?: Readonly<Record<string, unknown>>; readonly result?: unknown; readonly reason?: string }, expectedSequence?: number, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/goals/${encodeURIComponent(goalId)}`, {
      method: "POST",
      commandId,
      body: { ...input, ...(expectedSequence === undefined ? {} : { expectedSequence }) },
    });
  }

  updatePlan(sessionId: SessionId, content: string, status: PlanStatus, expectedSequence?: number, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/plan`, {
      method: "POST",
      commandId,
      body: { content, status, ...(expectedSequence === undefined ? {} : { expectedSequence }) },
    });
  }

  updateTodos(sessionId: SessionId, todos: readonly TodoItem[], expectedSequence?: number, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/todos`, {
      method: "POST",
      commandId,
      body: { todos, ...(expectedSequence === undefined ? {} : { expectedSequence }) },
    });
  }

  listWorktrees(sessionId: SessionId): Promise<{ readonly worktrees: readonly WorktreeProjection[] }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/worktrees`);
  }

  createWorktree(sessionId: SessionId, input: { readonly id?: string; readonly path?: string; readonly branch?: string; readonly taskId?: string }, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/worktrees`, { method: "POST", commandId, body: input });
  }

  attachWorktree(sessionId: SessionId, worktreeId: string, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/worktrees/${encodeURIComponent(worktreeId)}/attach`, { method: "POST", commandId, body: {} });
  }

  switchWorktree(sessionId: SessionId, worktreeId: string, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/worktrees/${encodeURIComponent(worktreeId)}/switch`, { method: "POST", commandId, body: {} });
  }

  cleanupWorktree(sessionId: SessionId, worktreeId: string, force = false, commandId?: string): Promise<SessionProjection> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/worktrees/${encodeURIComponent(worktreeId)}/cleanup`, { method: "POST", commandId, body: { force } });
  }

  listTools(sessionId?: SessionId): Promise<{ readonly tools: readonly ToolCatalogEntry[] }> {
    const suffix = sessionId === undefined ? "" : `?session_id=${encodeURIComponent(sessionId)}`;
    return this.request(`/v1/tools${suffix}`);
  }

  listCapabilities(): Promise<CapabilityResponse> {
    return this.request("/v1/capabilities");
  }

  uploadAttachment(sessionId: SessionId, input: { readonly fileName: string; readonly mediaType: string; readonly data: string }, commandId?: string): Promise<AttachmentReceipt> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "POST",
      commandId,
      body: input,
    });
  }

  listModels(): Promise<ModelCatalogResponse> {
    return this.request("/v1/models");
  }

  listProviders(): Promise<ProviderCatalogResponse> {
    return this.request("/v1/providers");
  }

  createProvider(input: ProviderProfileInput): Promise<{ readonly provider: Readonly<Record<string, unknown>> }> {
    return this.request("/v1/providers", { method: "POST", body: input });
  }

  discoverProvider(provider: string): Promise<{ readonly provider: ProviderCatalogGroup }> {
    return this.request(`/v1/providers/${encodeURIComponent(provider)}/discover`, { method: "POST" });
  }

  listSessionModels(sessionId: SessionId): Promise<SessionModelsResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/models`);
  }

  /** Read the explicit Session selection and its inherited effective route. */
  getSessionModelSelection(sessionId: SessionId): Promise<SessionModelSelectionResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/model`);
  }

  /**
   * Select the complete provider/model/reasoning tuple for one Session. This is
   * the primary Web path; the host-scoped `selectModel` method below remains for
   * legacy `/v1/models` callers and provider credential binding flows.
   */
  selectSessionModel(sessionId: SessionId, selection: ModelSelection, commandId?: string): Promise<SessionModelSelectionMutationResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      commandId,
      body: selection,
    });
  }

  selectModel(model: string, commandId?: string, credentialRef?: McpCredentialReference, reasoningEffort?: string, provider?: string): Promise<{ readonly model: Readonly<Record<string, unknown>>; readonly route?: ModelCatalogResponse["route"]; readonly reasoning?: ModelCatalogResponse["reasoning"] }> {
    return this.request("/v1/models", { method: "POST", commandId, body: { model, ...(provider === undefined ? {} : { provider }), ...(credentialRef === undefined ? {} : { credentialRef }), ...(reasoningEffort === undefined || reasoningEffort === "default" ? {} : { reasoningEffort }) } });
  }

  listCredentials(): Promise<CredentialListResponse> {
    return this.request("/v1/credentials");
  }

  createCredential(input: CredentialMutationInput): Promise<{ readonly credential: CredentialRecord }> {
    return this.request("/v1/credentials", { method: "POST", body: input });
  }

  rotateCredential(id: string, input: CredentialMutationInput): Promise<{ readonly credential: CredentialRecord }> {
    return this.request(`/v1/credentials/${encodeURIComponent(id)}/rotate`, { method: "POST", body: input });
  }

  revokeCredential(id: string): Promise<{ readonly credential: CredentialRecord }> {
    return this.request(`/v1/credentials/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  }

  deleteCredential(id: string): Promise<{ readonly removed: boolean }> {
    return this.request(`/v1/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  listMcpServers(): Promise<{ readonly servers: readonly McpServerView[] }> {
    return this.request("/v1/mcp/servers");
  }

  listSubagents(sessionId: SessionId, scope: "children" | "descendants" = "children"): Promise<{ readonly agents: readonly SubagentCatalogEntry[] }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/subagents?scope=${scope}`);
  }

  taskOutput(sessionId: SessionId, taskId: TaskId): Promise<TaskOutputResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/output`);
  }

  inspectArtifact(sessionId: SessionId, artifactId: string): Promise<ArtifactAccessResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`);
  }

  artifactContentUrl(sessionId: SessionId, artifactId: string, download = false): string {
    const suffix = download ? "?download=true" : "";
    return this.url(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/content${suffix}`);
  }

  cancelTask(sessionId: SessionId, taskId: TaskId, commandId?: string): Promise<unknown> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", commandId, body: {} });
  }

  /** Build an EventSource URL; the controller owns the actual stream lifecycle. */
  eventsUrl(sessionId: SessionId, afterSequence = 0): string {
    return this.url(`/v1/sessions/${encodeURIComponent(sessionId)}/events?after_sequence=${afterSequence}`);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(path: string, options: { readonly method?: string; readonly body?: unknown; readonly commandId?: string | undefined } = {}): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.commandId !== undefined) headers.set("idempotency-key", options.commandId);
    const response = await this.fetcher(this.url(path), {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body: unknown = response.status === 204
      ? undefined
      : contentType.includes("application/json")
        ? await response.json()
        : await response.text();
    if (!response.ok) throw new ApiError(response.status, body);
    return body as T;
  }
}

function normalizeEventPage(value: unknown): EventPageResponse {
  if (Array.isArray(value)) {
    const events = value as AgentEvent[];
    const newestSequence = events.at(-1)?.sequence;
    return {
      events,
      hasMoreBefore: false,
      hasMoreAfter: false,
      ...(events[0] === undefined ? {} : { oldestSequence: events[0].sequence }),
      ...(newestSequence === undefined ? {} : { newestSequence }),
    };
  }
  if (typeof value !== "object" || value === null || !Array.isArray((value as { events?: unknown }).events)) throw new Error("Invalid event page response");
  const page = value as Partial<EventPageResponse> & { events: readonly AgentEvent[] };
  return {
    events: page.events,
    hasMoreBefore: page.hasMoreBefore === true,
    hasMoreAfter: page.hasMoreAfter === true,
    ...(typeof page.oldestSequence === "number" ? { oldestSequence: page.oldestSequence } : {}),
    ...(typeof page.newestSequence === "number" ? { newestSequence: page.newestSequence } : {}),
  };
}
