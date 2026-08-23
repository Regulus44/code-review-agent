import {
  brand,
  type AgentEvent,
  type ChatMessage,
  type ChatModel,
  type ModelToolCall,
  type ModelToolDefinition,
  type SessionEventStore,
  type SessionId,
  type SessionProjection,
  type SessionSummary,
  type TurnId,
  type InteractionId,
  type PermissionId,
  type PermissionRequest,
  type ToolCaller,
  type ToolCallId,
  type ToolResult,
  type UserInteractionAnswer,
  type UserInteractionRequest,
  type ChildSessionMetadata,
  type EventListOptions,
  type EventPage,
} from "@code-review-agent/contracts";
import { EchoChatModel } from "@code-review-agent/llm";
import { randomUUID } from "node:crypto";
import { BUILTIN_TOOL_PROMPT_SPECS, createBuiltinTools, createSubagentTools, DefaultPermissionPolicy, JobManager, TerminalManager, ToolPromptRegistry, ToolRegistry, ToolRuntime, type CapabilityRegistry, type ExecuteToolOutput, type LspServerConfig, type PermissionPreset } from "@code-review-agent/tools";
import type { SubagentRuntime } from "@code-review-agent/subagent";
import { buildAgentSystemPrompt } from "./system-prompt.js";

export interface AgentHostOptions {
  readonly store: SessionEventStore;
  readonly model?: ChatModel;
  readonly systemPrompt?: string;
  readonly maxSteps?: number;
  readonly toolRuntime?: ToolRuntime;
  readonly toolRegistry?: ToolRegistry;
  readonly permissionPreset?: PermissionPreset;
  readonly toolPromptRegistry?: ToolPromptRegistry;
  readonly visionEnabled?: boolean;
  readonly lspServers?: Readonly<Record<string, LspServerConfig>>;
  readonly capabilities?: CapabilityRegistry;
  readonly subagentRuntime?: SubagentRuntime;
}

interface PendingTurn {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly content: string;
  readonly previousMessages: readonly ChatMessage[];
}

interface PendingPermissionWaiter {
  readonly resolve: (output: ExecuteToolOutput) => void;
  readonly reject: (error: unknown) => void;
}

interface RecoveredTurn {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly permissionIds: Set<PermissionId>;
  readonly interactionIds: Set<InteractionId>;
}

interface CollectedModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
}

/** Coordinates durable sessions, queued turns and model execution behind storage/model interfaces. */
export class AgentHost {
  private model: ChatModel;
  private readonly customSystemPrompt: string | undefined;
  private readonly permissionPreset: PermissionPreset | undefined;
  private readonly controllers = new Map<TurnId, AbortController>();
  private readonly activeTurns = new Map<SessionId, TurnId>();
  private readonly queues = new Map<SessionId, PendingTurn[]>();
  private readonly queueChangeTails = new Map<SessionId, Promise<void>>();
  private readonly permissionWaiters = new Map<PermissionId, PendingPermissionWaiter>();
  private readonly recoveredTurns = new Map<TurnId, RecoveredTurn>();
  private readonly recoveredPermissionIndex = new Map<PermissionId, TurnId>();
  private readonly recoveredInteractionIndex = new Map<InteractionId, TurnId>();
  private readonly maxSteps: number;
  private readonly ready: Promise<void>;
  private readonly toolRuntime: ToolRuntime;
  private readonly terminalManager?: TerminalManager;
  private readonly jobManager?: JobManager;
  private readonly toolPromptRegistry: ToolPromptRegistry;

  constructor(private readonly options: AgentHostOptions) {
    this.model = options.model ?? new EchoChatModel();
    this.customSystemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 12;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1 || this.maxSteps > 100) throw new Error("maxSteps must be an integer between 1 and 100");
    const registry = options.toolRegistry ?? new ToolRegistry();
    this.toolPromptRegistry = options.toolPromptRegistry ?? new ToolPromptRegistry();
    if (options.toolPromptRegistry === undefined) this.toolPromptRegistry.registerMany(BUILTIN_TOOL_PROMPT_SPECS);
    if (options.toolRuntime === undefined) {
      this.terminalManager = new TerminalManager();
      this.jobManager = new JobManager({ eventStore: options.store });
      if (options.toolRegistry === undefined) registry.registerMany(createBuiltinTools({ terminalManager: this.terminalManager, jobManager: this.jobManager, eventStore: options.store, ...(options.visionEnabled === undefined ? {} : { visionEnabled: options.visionEnabled }), ...(options.lspServers === undefined ? {} : { lspServers: options.lspServers }), ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }) }));
      this.permissionPreset = options.permissionPreset ?? "ask-on-write";
    } else {
      this.permissionPreset = options.permissionPreset;
    }
    if (options.subagentRuntime !== undefined) registry.registerMany(createSubagentTools({ runtime: options.subagentRuntime }).filter((tool) => !registry.has(tool.name)));
    this.toolRuntime = options.toolRuntime ?? new ToolRuntime({ store: options.store, registry, ...(this.terminalManager === undefined ? {} : { terminalManager: this.terminalManager }), ...(options.permissionPreset === undefined ? {} : { policy: new DefaultPermissionPolicy({ preset: options.permissionPreset }) }) });
    this.ready = this.restoreQueuedTurns();
  }

  /** Replaces the model used for turns that have not started yet. */
  setModel(model: ChatModel): void {
    this.model = model;
  }

  async createSession(workspaceRoot: string, permissionPreset?: PermissionPreset, metadata?: ChildSessionMetadata): Promise<SessionProjection> {
    await this.ready;
    const preset = permissionPreset ?? this.permissionPreset ?? "ask-on-write";
    const id = await this.options.store.createSession(workspaceRoot, preset, metadata);
    this.toolRuntime.setSessionPermissionPreset(id, preset);
    const projection = await this.options.store.project(id);
    if (projection === undefined) throw new Error("Session projection was not created");
    return projection;
  }

  async listSessions(includeArchived = false): Promise<readonly SessionSummary[]> {
    await this.ready;
    return this.options.store.listSessions(includeArchived);
  }

  async archiveSession(sessionId: SessionId, archived = true): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    await this.options.store.append({ sessionId, type: "session/updated", payload: { archived } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async renameSession(sessionId: SessionId, title: string, commandId?: string): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const normalized = title.trim();
    if (normalized.length === 0) throw new Error("Session title cannot be empty");
    if (normalized.length > 120) throw new Error("Session title must be 120 characters or fewer");
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "rename_session",
      request: { title: normalized },
      result: { title: normalized },
    });
    if (!claim.created) {
      const saved = await this.options.store.project(sessionId);
      if (saved === undefined) throw new Error(`Session disappeared: ${sessionId}`);
      return saved;
    }
    await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "session/updated", payload: { title: normalized } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  /** Soft-deletes a session through the event stream while retaining its history for audit/recovery. */
  async deleteSession(sessionId: SessionId): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    if (current.deleted) return current;
    await this.options.store.append({ sessionId, type: "session/deleted", payload: { deleted: true } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async getSession(sessionId: SessionId): Promise<SessionProjection | undefined> {
    await this.ready;
    return this.options.store.project(sessionId);
  }

  async setSessionPermissionPreset(sessionId: SessionId, permissionPreset: PermissionPreset): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    this.toolRuntime.setSessionPermissionPreset(sessionId, permissionPreset);
    await this.options.store.append({ sessionId, type: "session/updated", payload: { permissionPreset } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async events(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    await this.ready;
    return this.options.store.list(sessionId, afterSequence);
  }

  async eventsPage(sessionId: SessionId, options: EventListOptions = {}): Promise<EventPage> {
    await this.ready;
    if (this.options.store.listPage !== undefined) return this.options.store.listPage(sessionId, options);
    const after = options.afterSequence ?? 0;
    const before = options.beforeSequence;
    const all = (await this.options.store.list(sessionId, 0)).filter((event) => event.sequence > after && (before === undefined || event.sequence < before));
    const limit = options.limit === undefined ? undefined : Math.min(1_000, Math.max(1, Math.floor(options.limit)));
    const latest = before === undefined && limit !== undefined && after === 0;
    const events = limit === undefined ? all : latest || before !== undefined ? all.slice(-limit) : all.slice(0, limit);
    const first = events[0]?.sequence;
    const last = events[events.length - 1]?.sequence;
    return {
      events,
      hasMoreBefore: first === undefined ? false : all.some((event) => event.sequence < first),
      hasMoreAfter: last === undefined ? false : all.some((event) => event.sequence > last),
      ...(first === undefined ? {} : { oldestSequence: first }),
      ...(last === undefined ? {} : { newestSequence: last }),
    };
  }

  subscribe(sessionId: SessionId, listener: (event: AgentEvent) => void): () => void {
    return this.options.store.subscribe(sessionId, listener);
  }

  listTools(sessionId?: SessionId) {
    return this.toolRuntime.listTools(sessionId).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      executionMode: tool.executionMode,
      riskLevel: tool.riskLevel,
      approvalMode: tool.approvalMode,
      interruptBehavior: tool.interruptBehavior,
      source: tool.source ?? { kind: "builtin" },
    }));
  }

  /** Exposes the shared registry to optional protocol adapters such as MCP. */
  toolRegistry(): ToolRegistry {
    return this.toolRuntime.registry;
  }

  async executeTool(sessionId: SessionId, name: string, input: unknown, turnId?: TurnId, commandId?: string, signal?: AbortSignal, caller: ToolCaller = "user"): Promise<ExecuteToolOutput> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const toolCallId = brand<string, "ToolCallId">(`tool_${randomUUID()}`);
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: commandId ?? `cmd_${randomUUID()}`,
      kind: "execute_tool",
      request: { name, input, turnId },
      result: { toolCallId },
    });
    if (!claim.created) {
      const saved = (claim.record.result as { toolCallId?: unknown }).toolCallId;
      if (typeof saved !== "string") throw new Error(`Command ${claim.record.commandId} has an invalid tool result`);
      const call = projection.toolCalls.find((item) => item.id === saved);
      if (call === undefined) throw new Error(`Tool call ${saved} is not available`);
      const permission = projection.permissions.find((item) => item.toolCallId === call.id && item.status === "pending");
      return { toolCallId: call.id, status: call.status === "awaiting_permission" ? "awaiting_permission" : call.status === "completed" ? "completed" : call.status === "cancelled" ? "cancelled" : call.status === "denied" ? "denied" : "failed", ...(call.result === undefined ? {} : { result: call.result }), ...(permission === undefined ? {} : { permission: { id: permission.id, sessionId, toolCallId: permission.toolCallId, toolName: permission.toolName, riskLevel: permission.riskLevel, reason: permission.reason, input, caller: permission.caller ?? caller, workspaceRoot: permission.workspaceRoot ?? projection.workspaceRoot, createdAt: permission.createdAt, expiresAt: permission.expiresAt ?? new Date(Date.parse(permission.createdAt) + 15 * 60_000).toISOString() } satisfies PermissionRequest }) };
    }
    return this.toolRuntime.execute({ sessionId, workspaceRoot: projection.workspaceRoot, name, input, ...(turnId === undefined ? {} : { turnId }), toolCallId, ...(commandId === undefined ? {} : { commandId }), ...(signal === undefined ? {} : { signal }), caller });
  }

  async resolvePermission(sessionId: SessionId, permissionId: PermissionId, status: "approved" | "denied" | "cancelled", commandId?: string): Promise<ExecuteToolOutput> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const permission = projection.permissions.find((item) => item.id === permissionId);
    if (permission === undefined) throw new Error(`Unknown permission: ${permissionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "resolve_permission",
      request: { permissionId, status },
      result: { permissionId, status },
    });
    if (!claim.created || permission.status !== "pending") {
      const call = projection.toolCalls.find((item) => item.id === permission.toolCallId);
      if (call === undefined) throw new Error(`Tool call ${permission.toolCallId} is not available`);
      const output = { toolCallId: call.id, status: call.status === "completed" ? "completed" : call.status === "cancelled" ? "cancelled" : call.status === "denied" ? "denied" : call.status === "awaiting_permission" ? "awaiting_permission" : "failed", ...(call.result === undefined ? {} : { result: call.result }) } as ExecuteToolOutput;
      this.settlePermissionWaiter(permissionId, output);
      void this.maybeResumeRecoveredPermission(permissionId);
      return output;
    }
    const output = await this.toolRuntime.resolvePermission(permissionId, status);
    this.settlePermissionWaiter(permissionId, output);
    void this.maybeResumeRecoveredPermission(permissionId);
    return output;
  }

  pendingUserInteractions(sessionId: SessionId): readonly UserInteractionRequest[] {
    return this.toolRuntime.pendingUserInteractions().filter((interaction) => interaction.sessionId === sessionId);
  }

  async resolveInteraction(sessionId: SessionId, interactionId: InteractionId, status: "answered" | "cancelled", answer?: string, commandId?: string): Promise<UserInteractionAnswer> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const interaction = projection.interactions.find((item) => item.id === interactionId);
    if (interaction === undefined) throw new Error(`Unknown interaction: ${interactionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "resolve_interaction",
      request: { interactionId, status, answer },
      result: { interactionId, status, ...(answer === undefined ? {} : { answer }) },
    });
    if (!claim.created || interaction.status !== "pending") {
      const saved = claim.record.result as { status?: unknown; answer?: unknown };
      const resolvedStatus = interaction.status === "answered" || interaction.status === "cancelled" || interaction.status === "expired" ? interaction.status : saved.status;
      if (resolvedStatus !== "answered" && resolvedStatus !== "cancelled" && resolvedStatus !== "expired") throw new Error(`Interaction ${interactionId} has not been resolved`);
      const resolvedAnswer = typeof interaction.answer === "string" ? interaction.answer : typeof saved.answer === "string" ? saved.answer : undefined;
      void this.maybeResumeRecoveredInteraction(interactionId);
      return { interactionId, status: resolvedStatus, ...(resolvedAnswer === undefined ? {} : { answer: resolvedAnswer }) };
    }
    const resolved = await this.toolRuntime.resolveInteraction(interactionId, status, answer);
    void this.maybeResumeRecoveredInteraction(interactionId);
    return resolved;
  }

  async cancelTool(sessionId: SessionId, toolCallId: ToolCallId, commandId?: string): Promise<boolean> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const call = projection.toolCalls.find((item) => item.id === toolCallId);
    if (call === undefined) throw new Error(`Unknown tool call: ${toolCallId}`);
    const cancellable = call.status === "pending" || call.status === "awaiting_permission" || call.status === "running";
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "cancel_tool",
      request: { toolCallId },
      result: { cancelled: cancellable },
    });
    if (!claim.created) return Boolean((claim.record.result as { cancelled?: unknown }).cancelled);
    return cancellable ? this.toolRuntime.cancel(toolCallId) : false;
  }

  async sendMessage(sessionId: SessionId, content: string, commandId?: string): Promise<TurnId> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    if (content.trim() === "") throw new Error("Message content cannot be empty");

    const turnId = brand<string, "TurnId">(`turn_${randomUUID()}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "send_message",
      request: { content },
      result: { turnId },
    });
    if (!claim.created) {
      const savedTurnId = (claim.record.result as { turnId?: unknown }).turnId;
      if (typeof savedTurnId !== "string") throw new Error(`Command ${idempotencyKey} has an invalid result`);
      return turnIdFrom(savedTurnId);
    }

    const pending: PendingTurn = {
      sessionId,
      turnId,
      content,
      previousMessages: await this.conversationMessages(sessionId),
    };
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "user/message",
      payload: { content },
    });
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "turn/queued",
      payload: { commandId: idempotencyKey },
    });
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(pending);
    this.queues.set(sessionId, queue);
    await this.appendQueueChanged(sessionId, queue, idempotencyKey);
    void this.drainSession(sessionId);
    return turnId;
  }

  async cancelTurn(sessionId: SessionId, turnId: TurnId, commandId?: string): Promise<boolean> {
    await this.ready;
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const cancellationRequested = this.controllers.has(turnId) || (this.queues.get(sessionId)?.some((item) => item.turnId === turnId) ?? false);
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "cancel_turn",
      request: { turnId },
      result: { cancelled: cancellationRequested },
    });
    if (!claim.created) return Boolean((claim.record.result as { cancelled?: unknown }).cancelled);
    if (!cancellationRequested) return false;

    const controller = this.controllers.get(turnId);
    const removed = controller === undefined ? this.removeQueuedTurn(sessionId, turnId) : undefined;
    if (controller !== undefined) controller.abort(new Error("Cancelled by user"));
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "agent/status",
      payload: { status: "stopped", reason: "cancelled_by_user" },
    });
    if (controller === undefined) {
      if (removed !== undefined) await this.appendQueueChanged(sessionId, this.queues.get(sessionId) ?? [], idempotencyKey);
      await this.options.store.append({
        sessionId,
        turnId,
        correlationId: idempotencyKey,
        type: "turn/ended",
        payload: { status: "stopped" },
      });
      void this.drainSession(sessionId);
    }
    return true;
  }

  async reorderQueue(sessionId: SessionId, turnId: TurnId, position: number, commandId?: string): Promise<{ readonly reordered: boolean; readonly queuedTurnIds: readonly TurnId[] }> {
    await this.ready;
    if (await this.options.store.project(sessionId) === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const queue = this.queues.get(sessionId) ?? [];
    const currentIndex = queue.findIndex((item) => item.turnId === turnId);
    const normalizedPosition = queue.length === 0 ? 0 : Math.min(queue.length - 1, Math.max(0, Math.floor(position)));
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const reordered = currentIndex >= 0 && currentIndex !== normalizedPosition;
    const nextOrder = queue.map((item) => item.turnId);
    if (reordered) {
      const [moved] = nextOrder.splice(currentIndex, 1);
      if (moved !== undefined) nextOrder.splice(normalizedPosition, 0, moved);
    }
    const result = { reordered, queuedTurnIds: nextOrder };
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "reorder_queue",
      request: { turnId, position: normalizedPosition },
      result,
    });
    if (!claim.created) {
      const saved = claim.record.result as { reordered?: unknown; queuedTurnIds?: unknown };
      return {
        reordered: saved.reordered === true,
        queuedTurnIds: Array.isArray(saved.queuedTurnIds) ? saved.queuedTurnIds.filter((value): value is TurnId => typeof value === "string").map((value) => brand<string, "TurnId">(value)) : [],
      };
    }
    if (!reordered) return result;
    const [moved] = queue.splice(currentIndex, 1);
    if (moved !== undefined) queue.splice(normalizedPosition, 0, moved);
    this.queues.set(sessionId, queue);
    await this.appendQueueChanged(sessionId, queue, idempotencyKey);
    return result;
  }

  async resumeSession(sessionId: SessionId, commandId?: string): Promise<SessionProjection> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "resume_session",
      request: {},
      result: { resumed: true },
    });
    if (claim.created && (projection.status === "interrupted" || projection.status === "stopped")) {
      await this.options.store.append({
        sessionId,
        correlationId: idempotencyKey,
        type: "agent/status",
        payload: { status: "idle", reason: "resumed_by_user" },
      });
    }
    void this.drainSession(sessionId);
    const resumed = await this.options.store.project(sessionId);
    if (resumed === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return resumed;
  }

  async forkSession(sessionId: SessionId, workspaceRoot?: string, commandId?: string): Promise<SessionId> {
    await this.ready;
    const source = await this.options.store.project(sessionId);
    if (source === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const forkedId = brand<string, "SessionId">(`ses_${randomUUID()}`);
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "fork_session",
      request: { workspaceRoot },
      result: { sessionId: forkedId },
    });
    if (!claim.created) {
      const savedId = (claim.record.result as { sessionId?: unknown }).sessionId;
      if (typeof savedId !== "string") throw new Error(`Command ${idempotencyKey} has an invalid result`);
      return sessionIdFrom(savedId);
    }
    return this.options.store.forkSession(sessionId, workspaceRoot, forkedId, source.permissionPreset);
  }

  async waitForTurn(turnId: TurnId, timeoutMs = 10_000): Promise<void> {
    await this.ready;
    const started = Date.now();
    while (true) {
      const sessions = await this.options.store.listSessions();
      for (const session of sessions) {
        const projection = await this.options.store.project(session.id);
        if (projection === undefined) continue;
        const turn = projection?.turns.find((item) => item.id === turnId);
        if (turn === undefined || turn.status === "queued" || turn.status === "running") continue;
        // An interrupted turn with restored approvals is still live from the
        // caller's perspective; it will become running once every approval is
        // resolved and must not make waitForTurn return early.
        if (turn.status === "interrupted") {
          const recovered = this.recoveredTurns.get(turnId);
          if (recovered !== undefined) {
            await this.reconcileRecoveredTurn(recovered, projection);
            if (this.recoveredTurns.has(turnId) || this.activeTurns.get(session.id) === turnId) continue;
          }
        }
        const events = await this.options.store.list(session.id);
        const ended = [...events].reverse().find((event) => event.turnId === turnId && event.type === "turn/ended");
        if (ended !== undefined) return;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${turnId}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private async restoreQueuedTurns(): Promise<void> {
    for (const summary of await this.options.store.listSessions(true)) {
      let projection = await this.options.store.project(summary.id);
      if (projection === undefined) continue;
      this.toolRuntime.setSessionPermissionPreset(summary.id, projection.permissionPreset ?? this.permissionPreset ?? "ask-on-write");
      await this.toolRuntime.restorePending(summary.id, projection.workspaceRoot, await this.options.store.list(summary.id));
      projection = await this.options.store.project(summary.id);
      if (projection === undefined) continue;
      for (const turn of projection.turns
        .filter((item) => item.status === "queued" && item.userMessage !== undefined)
        .sort((left, right) => (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER) || left.lastSequence - right.lastSequence)) {
        this.enqueue({
          sessionId: summary.id,
          turnId: turn.id,
          content: turn.userMessage as string,
          previousMessages: await this.conversationMessages(summary.id, turn.id),
        });
      }
      for (const turn of projection.turns.filter((item) => item.status === "interrupted")) {
        const permissionIds = new Set(projection.permissions.filter((permission) => permission.status === "pending" && permission.turnId === turn.id).map((permission) => permission.id));
        const interactionIds = new Set(projection.interactions.filter((interaction) => interaction.status === "pending" && interaction.turnId === turn.id).map((interaction) => interaction.id));
        if (permissionIds.size === 0 && interactionIds.size === 0) continue;
        const recovered: RecoveredTurn = { sessionId: summary.id, turnId: turn.id, permissionIds, interactionIds };
        this.recoveredTurns.set(turn.id, recovered);
        for (const permissionId of permissionIds) this.recoveredPermissionIndex.set(permissionId, turn.id);
        for (const interactionId of interactionIds) this.recoveredInteractionIndex.set(interactionId, turn.id);
      }
    }
  }

  private async maybeResumeRecoveredPermission(permissionId: PermissionId): Promise<void> {
    const turnId = this.recoveredPermissionIndex.get(permissionId);
    if (turnId === undefined) return;
    const recovered = this.recoveredTurns.get(turnId);
    if (recovered === undefined) return;
    recovered.permissionIds.delete(permissionId);
    this.recoveredPermissionIndex.delete(permissionId);
    await this.maybeStartRecoveredTurn(recovered);
  }

  private async maybeResumeRecoveredInteraction(interactionId: InteractionId): Promise<void> {
    const turnId = this.recoveredInteractionIndex.get(interactionId);
    if (turnId === undefined) return;
    const recovered = this.recoveredTurns.get(turnId);
    if (recovered === undefined) return;
    recovered.interactionIds.delete(interactionId);
    this.recoveredInteractionIndex.delete(interactionId);
    await this.maybeStartRecoveredTurn(recovered);
  }

  private async maybeStartRecoveredTurn(recovered: RecoveredTurn): Promise<void> {
    if (recovered.permissionIds.size > 0 || recovered.interactionIds.size > 0 || this.activeTurns.has(recovered.sessionId)) return;
    this.recoveredTurns.delete(recovered.turnId);
    const controller = new AbortController();
    this.activeTurns.set(recovered.sessionId, recovered.turnId);
    this.controllers.set(recovered.turnId, controller);
    void this.runRecoveredTurn(recovered.sessionId, recovered.turnId, controller).finally(() => {
      this.controllers.delete(recovered.turnId);
      this.activeTurns.delete(recovered.sessionId);
      void this.drainSession(recovered.sessionId);
    });
  }

  private async reconcileRecoveredTurn(recovered: RecoveredTurn, projection: SessionProjection): Promise<void> {
    const pendingPermissions = new Set(projection.permissions.filter((permission) => permission.status === "pending").map((permission) => permission.id));
    const pendingInteractions = new Set(projection.interactions.filter((interaction) => interaction.status === "pending").map((interaction) => interaction.id));
    for (const permissionId of [...recovered.permissionIds]) {
      if (pendingPermissions.has(permissionId)) continue;
      recovered.permissionIds.delete(permissionId);
      this.recoveredPermissionIndex.delete(permissionId);
    }
    for (const interactionId of [...recovered.interactionIds]) {
      if (pendingInteractions.has(interactionId)) continue;
      recovered.interactionIds.delete(interactionId);
      this.recoveredInteractionIndex.delete(interactionId);
    }
    await this.maybeStartRecoveredTurn(recovered);
  }

  private async conversationMessages(sessionId: SessionId, beforeTurnId?: TurnId): Promise<readonly ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for (const event of await this.options.store.list(sessionId)) {
      if (beforeTurnId !== undefined && event.type === "user/message" && event.turnId === beforeTurnId) break;
      if (event.type === "user/message") {
        const content = event.payload["content"];
        if (typeof content === "string") messages.push({ role: "user", content });
      } else if (event.type === "assistant/message") {
        const content = typeof event.payload["content"] === "string" ? event.payload["content"] as string : "";
        const toolCalls = parseModelToolCalls(event.payload["toolCalls"]);
        if (content.length > 0 || toolCalls.length > 0) messages.push({ role: "assistant", content, ...(toolCalls.length === 0 ? {} : { toolCalls }) });
      } else if (event.type === "tool/result") {
        const rawToolCallId = event.payload["toolCallId"];
        if (typeof rawToolCallId !== "string") continue;
        const rawResult = event.payload["result"];
        const result = rawResult !== undefined ? rawResult as ToolResult : undefined;
        messages.push({ role: "tool", toolCallId: rawToolCallId, content: modelToolResult({ toolCallId: brand<string, "ToolCallId">(rawToolCallId), status: event.payload["status"] === "completed" ? "completed" : event.payload["status"] === "cancelled" ? "cancelled" : event.payload["status"] === "denied" ? "denied" : "failed", ...(result === undefined ? {} : { result }) }) });
      }
    }
    return messages;
  }

  private async systemMessage(sessionId: SessionId, recovery = false): Promise<string> {
    const projection = await this.options.store.project(sessionId);
    const workspaceRoot = projection?.workspaceRoot ?? ".";
    return buildAgentSystemPrompt({
      workspaceRoot,
      tools: this.toolRuntime.listTools(sessionId),
      toolGuidance: this.toolPromptRegistry.assemble(this.toolRuntime.listTools(sessionId)),
      permissionPreset: projection?.permissionPreset ?? this.permissionPreset ?? "ask-on-write",
      ...(this.customSystemPrompt === undefined ? {} : { customInstructions: this.customSystemPrompt }),
      ...(recovery ? { recovery: true } : {}),
    });
  }

  private enqueue(pending: PendingTurn): void {
    const queue = this.queues.get(pending.sessionId) ?? [];
    if (!queue.some((item) => item.turnId === pending.turnId)) queue.push(pending);
    this.queues.set(pending.sessionId, queue);
  }

  private removeQueuedTurn(sessionId: SessionId, turnId: TurnId): PendingTurn | undefined {
    const queue = this.queues.get(sessionId);
    if (queue === undefined) return undefined;
    const index = queue.findIndex((item) => item.turnId === turnId);
    if (index < 0) return undefined;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(sessionId);
    return removed;
  }

  private async drainSession(sessionId: SessionId): Promise<void> {
    if (this.activeTurns.has(sessionId)) return;
    const queue = this.queues.get(sessionId);
    const pending = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.queues.delete(sessionId);
    if (pending === undefined) return;
    const controller = new AbortController();
    this.activeTurns.set(sessionId, pending.turnId);
    this.controllers.set(pending.turnId, controller);
    await this.appendQueueChanged(sessionId, queue ?? [], undefined);
    void this.runTurn(sessionId, pending.turnId, controller, pending.previousMessages, pending.content).finally(() => {
      this.controllers.delete(pending.turnId);
      this.activeTurns.delete(sessionId);
      void this.drainSession(sessionId);
    });
  }

  private async appendQueueChanged(sessionId: SessionId, queue: readonly PendingTurn[], correlationId?: string): Promise<void> {
    const queuedTurnIds = queue.map((item) => item.turnId);
    const previous = this.queueChangeTails.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await this.options.store.append({
        sessionId,
        ...(correlationId === undefined ? {} : { correlationId }),
        type: "queue/changed",
        payload: { queuedTurnIds },
      });
    });
    this.queueChangeTails.set(sessionId, next);
    await next;
  }

  private async runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    controller: AbortController,
    previousMessages: readonly ChatMessage[],
    content: string,
  ): Promise<void> {
    try {
      await this.options.store.append({ sessionId, turnId, type: "turn/started", payload: {} });
      const messages: ChatMessage[] = [
        { role: "system", content: await this.systemMessage(sessionId) },
        ...previousMessages,
        { role: "user", content },
      ];
      await this.runSteps(sessionId, turnId, controller, messages);
    } catch (error) {
      await this.finishTurnAfterError(sessionId, turnId, controller, error);
    }
  }

  private async runRecoveredTurn(sessionId: SessionId, turnId: TurnId, controller: AbortController): Promise<void> {
    try {
      await this.options.store.append({ sessionId, turnId, type: "agent/status", payload: { status: "running", reason: "permission_resolved_after_restart" } });
      const messages: ChatMessage[] = [{ role: "system", content: await this.systemMessage(sessionId, true) }, ...(await this.conversationMessages(sessionId))];
      await this.runSteps(sessionId, turnId, controller, messages);
    } catch (error) {
      await this.finishTurnAfterError(sessionId, turnId, controller, error);
    }
  }

  private async runSteps(sessionId: SessionId, turnId: TurnId, controller: AbortController, messages: ChatMessage[]): Promise<void> {
    for (let step = 1; step <= this.maxSteps; step += 1) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      await this.options.store.append({ sessionId, turnId, type: "step/started", payload: { step } });
      const response = await this.collectModelResponse(sessionId, turnId, controller, messages);
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      const assistantPayload = { content: response.text, ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls }) };
      await this.options.store.append({ sessionId, turnId, type: "assistant/message", payload: assistantPayload });
      if (response.toolCalls.length === 0) {
        await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "completed" } });
        await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "completed" } });
        return;
      }
      messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
      const outputs = await Promise.all(response.toolCalls.map((toolCall) => this.executeModelToolCall(sessionId, turnId, controller, toolCall)));
      for (let index = 0; index < outputs.length; index += 1) {
        const output = outputs[index];
        const toolCall = response.toolCalls[index];
        if (output === undefined || toolCall === undefined) throw new Error("TOOL_RESULT_MISMATCH: tool result count did not match tool call count");
        messages.push({ role: "tool", toolCallId: toolCall.id, content: modelToolResult(output) });
      }
      await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "completed", toolCalls: response.toolCalls.length } });
    }
    throw new Error(`MAX_AGENT_STEPS_EXCEEDED: model did not produce a final response within ${this.maxSteps} steps`);
  }

  private async finishTurnAfterError(sessionId: SessionId, turnId: TurnId, controller: AbortController, error: unknown): Promise<void> {
    if (controller.signal.aborted) {
      await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "stopped" } });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.store.append({ sessionId, turnId, type: "agent/error", payload: { message } });
      await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "failed", message } });
    }
  }

  private modelTools(sessionId: SessionId): readonly ModelToolDefinition[] {
    return this.toolRuntime.listTools(sessionId).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  private async collectModelResponse(
    sessionId: SessionId,
    turnId: TurnId,
    controller: AbortController,
    messages: readonly ChatMessage[],
  ): Promise<CollectedModelResponse> {
    const textParts: string[] = [];
    const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
    for await (const part of this.model.stream({ messages, tools: this.modelTools(sessionId), toolChoice: "auto", signal: controller.signal })) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      if (part.type === "text_delta") {
        textParts.push(part.text);
        await this.options.store.append({ sessionId, turnId, type: "assistant/chunk", payload: { text: part.text } });
      } else if (part.type === "tool_call_start") {
        const current = calls.get(part.index) ?? { arguments: "" };
        calls.set(part.index, { ...current, ...(part.id === undefined ? {} : { id: part.id }), ...(part.name === undefined ? {} : { name: part.name }) });
      } else if (part.type === "tool_call_delta") {
        const current = calls.get(part.index) ?? { arguments: "" };
        calls.set(part.index, { ...current, arguments: `${current.arguments}${part.arguments}` });
      } else if (part.type === "error") {
        throw new Error(`${part.code}: ${part.message}`);
      }
    }
    const toolCalls: ModelToolCall[] = [];
    for (const [index, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
      if (call.name === undefined || call.name.trim() === "") throw new Error(`MALFORMED_TOOL_CALL: missing tool name at index ${index}`);
      toolCalls.push({ id: call.id ?? `call_${randomUUID()}`, name: call.name, arguments: call.arguments });
    }
    return { text: textParts.join(""), toolCalls };
  }

  private async executeModelToolCall(
    sessionId: SessionId,
    turnId: TurnId,
    controller: AbortController,
    toolCall: ModelToolCall,
  ): Promise<ExecuteToolOutput> {
    let input: unknown;
    try {
      input = toolCall.arguments.trim() === "" ? {} : JSON.parse(toolCall.arguments) as unknown;
    } catch (error) {
      return this.syntheticToolFailure(sessionId, turnId, toolCall, "MALFORMED_TOOL_ARGUMENTS", error instanceof Error ? error.message : String(error));
    }
    try {
      const output = await this.toolRuntime.execute({
        sessionId,
        turnId,
        workspaceRoot: (await this.options.store.project(sessionId))?.workspaceRoot ?? ".",
        name: toolCall.name,
        input,
        toolCallId: brand<string, "ToolCallId">(toolCall.id),
        signal: controller.signal,
        caller: "agent",
      });
      if (output.status !== "awaiting_permission" || output.permission === undefined) return output;
      return this.waitForPermission(output.permission, controller);
    } catch (error) {
      return this.syntheticToolFailure(sessionId, turnId, toolCall, "TOOL_CALL_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async syntheticToolFailure(sessionId: SessionId, turnId: TurnId, toolCall: ModelToolCall, code: string, message: string): Promise<ExecuteToolOutput> {
    const toolCallId = brand<string, "ToolCallId">(toolCall.id);
    const result: ToolResult = { ok: false, error: { code, message, remedy: "Check the tool name and JSON arguments, then retry." }, presentation: { kind: "tool", title: code, text: message } };
    await this.options.store.append({ sessionId, turnId, type: "tool/call", payload: { toolCallId, name: toolCall.name, input: toolCall.arguments, riskLevel: "read", approvalMode: "deny", caller: "agent" } });
    await this.options.store.append({ sessionId, turnId, type: "tool/result", payload: { toolCallId, status: "failed", result } });
    return { toolCallId, status: "failed", result };
  }

  private waitForPermission(permission: PermissionRequest, controller: AbortController): Promise<ExecuteToolOutput> {
    return new Promise<ExecuteToolOutput>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        void this.toolRuntime.resolvePermission(permission.id, "cancelled").then(finish, reject);
      }, Math.max(0, Date.parse(permission.expiresAt) - Date.now()));
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
      };
      const finish = (output: ExecuteToolOutput) => {
        if (settled) return;
        settled = true;
        this.permissionWaiters.delete(permission.id);
        cleanup();
        resolve(output);
      };
      const onAbort = () => {
        void this.toolRuntime.resolvePermission(permission.id, "cancelled").then(finish, reject);
      };
      this.permissionWaiters.set(permission.id, { resolve: finish, reject });
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private settlePermissionWaiter(permissionId: PermissionId, output: ExecuteToolOutput): void {
    this.permissionWaiters.get(permissionId)?.resolve(output);
  }
}

export { createInProcessSubagentProvider, type InProcessProviderOptions } from "./subagent-provider.js";

export function sessionId(value: string): SessionId {
  return brand<string, "SessionId">(value);
}

export function turnId(value: string): TurnId {
  return brand<string, "TurnId">(value);
}

function modelToolResult(output: ExecuteToolOutput): string {
  if (output.result === undefined) return JSON.stringify({ ok: false, error: { code: `TOOL_${output.status.toUpperCase()}`, message: `Tool ended with status ${output.status}` } });
  const view = output.result.modelView ?? output.result.output ?? output.result;
  return typeof view === "string" ? view : JSON.stringify(view);
}

function parseModelToolCalls(value: unknown): readonly ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ModelToolCall[] => {
    if (typeof item !== "object" || item === null) return [];
    const id = (item as { id?: unknown }).id;
    const name = (item as { name?: unknown }).name;
    const args = (item as { arguments?: unknown }).arguments;
    if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string") return [];
    return [{ id, name, arguments: args }];
  });
}

function sessionIdFrom(value: string): SessionId {
  return brand<string, "SessionId">(value);
}

function turnIdFrom(value: string): TurnId {
  return brand<string, "TurnId">(value);
}
