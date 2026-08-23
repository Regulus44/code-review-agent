import type {
  AgentEvent,
  ArtifactRef,
  InteractionId,
  PermissionId,
  PermissionPreset,
  SessionId,
  SessionProjection,
  SessionSummary,
  TaskId,
  TaskProjection,
  ToolRiskLevel,
  ToolSource,
  TurnId,
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

  listSessions(includeArchived = false): Promise<{ readonly sessions: readonly SessionSummary[] }> {
    return this.request(`/v1/sessions?include_archived=${String(includeArchived)}`);
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

  sendMessage(sessionId: SessionId, content: string, commandId?: string): Promise<{ readonly turnId: TurnId }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      commandId,
      body: { content },
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

  listTools(sessionId?: SessionId): Promise<{ readonly tools: readonly ToolCatalogEntry[] }> {
    const suffix = sessionId === undefined ? "" : `?session_id=${encodeURIComponent(sessionId)}`;
    return this.request(`/v1/tools${suffix}`);
  }

  listModels(): Promise<ModelCatalogResponse> {
    return this.request("/v1/models");
  }

  selectModel(model: string, commandId?: string): Promise<{ readonly model: Readonly<Record<string, unknown>> }> {
    return this.request("/v1/models", { method: "POST", commandId, body: { model } });
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
