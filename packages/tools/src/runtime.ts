import {
  brand,
  type AgentEvent,
  type EventStore,
  type InteractionId,
  type InteractionOption,
  type PermissionId,
  type PermissionRequest,
  type PermissionStatus,
  type SessionId,
  type ToolCallId,
  type ToolCaller,
  type ToolDefinition,
  type ToolResult,
  type TurnId,
  type UserInteractionAnswer,
  type UserInteractionInput,
  type UserInteractionRequest,
} from "@code-review-agent/contracts";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "./registry.js";
import { assertValidInput } from "./schema.js";
import { DefaultPermissionPolicy, type PermissionPolicy, type PermissionPreset } from "./permissions.js";
import { TerminalManager } from "./builtin.js";

export interface ToolRuntimeOptions {
  readonly store: EventStore;
  readonly registry: ToolRegistry;
  readonly policy?: PermissionPolicy;
  readonly defaultTimeoutMs?: number;
  readonly outputBudgetBytes?: number;
  readonly permissionTtlMs?: number;
  readonly terminalManager?: TerminalManager;
  /** Optional per-session override used by the Web work-mode selector. */
  readonly sessionPermissionPresets?: ReadonlyMap<SessionId, PermissionPreset>;
}

export interface ExecuteToolInput {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly input: unknown;
  readonly turnId?: TurnId;
  readonly commandId?: string;
  readonly signal?: AbortSignal;
  readonly toolCallId?: ToolCallId;
  readonly caller?: ToolCaller;
}

export interface ExecuteToolOutput {
  readonly toolCallId: ToolCallId;
  readonly status: "completed" | "failed" | "cancelled" | "denied" | "awaiting_permission" | "awaiting_interaction";
  readonly result?: ToolResult;
  readonly permission?: PermissionRequest;
  readonly interaction?: UserInteractionRequest;
}

export interface ExecuteToolBatchOptions {
  readonly cancelSiblingsOnFailure?: boolean;
}

interface PendingExecution {
  readonly permission: PermissionRequest;
  readonly definition: ToolDefinition;
  readonly request: ExecuteToolInput;
  readonly controller: AbortController;
}

interface PendingInteraction {
  readonly request: UserInteractionRequest;
  readonly controller: AbortController;
  readonly resolve: (answer: UserInteractionAnswer) => void;
  readonly reject: (error: unknown) => void;
  /** True when the request was reconstructed after a host restart. */
  readonly restored?: boolean;
}

/** Durable tool execution pipeline: discover, validate, policy, approval, execute, result. */
export class ToolRuntime {
  private readonly policy: PermissionPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly outputBudgetBytes: number;
  private readonly permissionTtlMs: number;
  private readonly pending = new Map<PermissionId, PendingExecution>();
  private readonly pendingInteractions = new Map<InteractionId, PendingInteraction>();
  private readonly resolvedInteractions = new Map<InteractionId, UserInteractionAnswer>();
  private readonly running = new Map<ToolCallId, AbortController>();
  private readonly resolved = new Map<PermissionId, ExecuteToolOutput>();
  private readonly expiryTimers = new Map<PermissionId, NodeJS.Timeout>();
  private readonly interactionExpiryTimers = new Map<InteractionId, NodeJS.Timeout>();
  private readonly activeExclusive = new Map<SessionId, Promise<unknown>>();
  private readonly sessionPermissionPresets = new Map<SessionId, PermissionPreset>();

  constructor(private readonly options: ToolRuntimeOptions) {
    this.policy = options.policy ?? new DefaultPermissionPolicy();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.outputBudgetBytes = options.outputBudgetBytes ?? 64 * 1024;
    this.permissionTtlMs = options.permissionTtlMs ?? 15 * 60_000;
    for (const [sessionId, preset] of options.sessionPermissionPresets ?? []) this.sessionPermissionPresets.set(sessionId, preset);
  }

  setSessionPermissionPreset(sessionId: SessionId, preset: PermissionPreset): void {
    this.sessionPermissionPresets.set(sessionId, preset);
  }

  permissionPresetFor(sessionId: SessionId): PermissionPreset {
    return this.sessionPermissionPresets.get(sessionId) ?? (this.policy instanceof DefaultPermissionPolicy ? this.policy.preset : "ask-on-write");
  }

  /** The registry is shared with optional adapters that register external tools. */
  get registry(): ToolRegistry {
    return this.options.registry;
  }

  listTools(sessionId?: SessionId): readonly ToolDefinition[] {
    const policy = sessionId === undefined ? this.policy : new DefaultPermissionPolicy({ preset: this.permissionPresetFor(sessionId) });
    return this.options.registry.list().filter((definition) => policy.isVisible?.(definition) ?? true);
  }

  pendingPermissions(): readonly PermissionRequest[] {
    return [...this.pending.values()].map((item) => item.permission);
  }

  pendingUserInteractions(): readonly UserInteractionRequest[] {
    return [...this.pendingInteractions.values()].map((item) => item.request);
  }

  async restorePending(sessionId: SessionId, workspaceRoot: string, events: readonly AgentEvent[]): Promise<void> {
    await this.options.terminalManager?.restore(sessionId, workspaceRoot, events, async (payload) => {
      await this.options.store.append({ sessionId, type: "terminal/session", payload });
    });
    const requests = new Map<string, PermissionRequest>();
    const resolved = new Set<string>();
    const interactions = new Map<string, UserInteractionRequest>();
    const resolvedInteractions = new Set<string>();
    for (const event of events) {
      if (event.type === "permission/requested") {
        const payload = event.payload;
        if (typeof payload.permissionId !== "string" || typeof payload.toolCallId !== "string" || typeof payload.toolName !== "string") continue;
        requests.set(payload.permissionId, {
          id: brand<string, "PermissionId">(payload.permissionId),
          sessionId,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          toolCallId: brand<string, "ToolCallId">(payload.toolCallId),
          toolName: payload.toolName,
          riskLevel: payload.riskLevel === "network" || payload.riskLevel === "execute" || payload.riskLevel === "write" ? payload.riskLevel : "read",
          reason: typeof payload.reason === "string" ? payload.reason : "Tool approval required",
          input: payload.input,
          caller: payload.caller === "user" || payload.caller === "system" ? payload.caller : "agent",
          workspaceRoot: typeof payload.workspaceRoot === "string" ? payload.workspaceRoot : workspaceRoot,
          createdAt: typeof payload.createdAt === "string" ? payload.createdAt : event.createdAt,
          expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : new Date(new Date(event.createdAt).getTime() + this.permissionTtlMs).toISOString(),
        });
      }
      if (event.type === "permission/resolved" && typeof event.payload.permissionId === "string") resolved.add(event.payload.permissionId);
      if (event.type === "interaction/requested") {
        const payload = event.payload;
        if (typeof payload.interactionId !== "string" || typeof payload.toolCallId !== "string" || typeof payload.question !== "string") continue;
        const options = interactionOptions(payload.options);
        interactions.set(payload.interactionId, {
          id: brand<string, "InteractionId">(payload.interactionId),
          sessionId,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          toolCallId: brand<string, "ToolCallId">(payload.toolCallId),
          question: payload.question,
          options,
          allowFreeform: payload.allowFreeform !== false,
          caller: payload.caller === "user" || payload.caller === "system" ? payload.caller : "agent",
          createdAt: typeof payload.createdAt === "string" ? payload.createdAt : event.createdAt,
          expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : new Date(Date.parse(event.createdAt) + this.permissionTtlMs).toISOString(),
        });
      }
      if (event.type === "interaction/resolved" && typeof event.payload.interactionId === "string") resolvedInteractions.add(event.payload.interactionId);
    }
    for (const permission of requests.values()) {
      if (resolved.has(permission.id) || this.pending.has(permission.id)) continue;
      if (!this.options.registry.isEnabled(permission.toolName)) {
        const result = this.errorResult(this.options.registry.has(permission.toolName) ? "TOOL_DISABLED" : "TOOL_NOT_FOUND", `Cannot restore unavailable tool: ${permission.toolName}`);
        await this.options.store.append({ sessionId, ...(permission.turnId === undefined ? {} : { turnId: permission.turnId }), type: "permission/resolved", payload: { permissionId: permission.id, toolCallId: permission.toolCallId, toolName: permission.toolName, riskLevel: permission.riskLevel, reason: permission.reason, caller: permission.caller, workspaceRoot: permission.workspaceRoot, expiresAt: permission.expiresAt, status: "denied" } });
        await this.options.store.append({ sessionId, ...(permission.turnId === undefined ? {} : { turnId: permission.turnId }), type: "tool/result", payload: { toolCallId: permission.toolCallId, status: "denied", result } });
        this.resolved.set(permission.id, { toolCallId: permission.toolCallId, status: "denied", result });
        continue;
      }
      const definition = this.options.registry.get(permission.toolName);
      this.pending.set(permission.id, {
        permission,
        definition,
        request: { sessionId, workspaceRoot, name: permission.toolName, input: permission.input, ...(permission.turnId === undefined ? {} : { turnId: permission.turnId }), toolCallId: permission.toolCallId },
        controller: new AbortController(),
      });
      if (Date.parse(permission.expiresAt) <= Date.now()) await this.resolvePermission(permission.id, "cancelled");
      else this.scheduleExpiry(permission.id, permission.expiresAt);
    }

    for (const interaction of interactions.values()) {
      if (resolvedInteractions.has(interaction.id) || this.pendingInteractions.has(interaction.id)) continue;
      if (Date.parse(interaction.expiresAt) <= Date.now()) {
        await this.resolveRestoredInteraction(interaction, "expired");
        continue;
      }
      this.pendingInteractions.set(interaction.id, {
        request: interaction,
        controller: new AbortController(),
        resolve: () => undefined,
        reject: () => undefined,
        restored: true,
      });
      this.scheduleInteractionExpiry(interaction.id, interaction.expiresAt);
    }
  }

  async execute(input: ExecuteToolInput): Promise<ExecuteToolOutput> {
    const definition = this.options.registry.validate(input.name, input.input);
    const toolCallId = input.toolCallId ?? brand<string, "ToolCallId">(`tool_${randomUUID()}`);
    const caller = input.caller ?? "agent";
    const policy = new DefaultPermissionPolicy({ preset: this.permissionPresetFor(input.sessionId) });
    const evaluation = policy.evaluate(definition);
    await this.append(input, "tool/call", {
      toolCallId,
      name: definition.name,
      input: input.input,
      riskLevel: definition.riskLevel,
      approvalMode: evaluation.mode,
      caller,
      workspaceRoot: input.workspaceRoot,
      presentation: definition.presentCall?.(input.input) ?? defaultCallPresentation(definition),
    });
    if (evaluation.mode === "deny") {
      const result = this.errorResult("PERMISSION_DENIED", evaluation.reason);
      await this.append(input, "tool/result", { toolCallId, status: "denied", result });
      return { toolCallId, status: "denied", result };
    }
    if (evaluation.mode === "ask") {
      const permissionId = brand<string, "PermissionId">(`perm_${randomUUID()}`);
      const permission: PermissionRequest = {
        id: permissionId,
        sessionId: input.sessionId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        toolCallId,
        toolName: definition.name,
        riskLevel: definition.riskLevel,
        reason: evaluation.reason,
        input: input.input,
        caller,
        workspaceRoot: input.workspaceRoot,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.permissionTtlMs).toISOString(),
      };
      this.pending.set(permissionId, { permission, definition, request: input, controller: new AbortController() });
      this.scheduleExpiry(permissionId, permission.expiresAt);
      await this.append(input, "permission/requested", { permissionId: permission.id, ...permission });
      return { toolCallId, status: "awaiting_permission", permission };
    }
    return this.runApproved(toolCallId, definition, input);
  }

  async executeMany(inputs: readonly ExecuteToolInput[], options: ExecuteToolBatchOptions = {}): Promise<readonly ExecuteToolOutput[]> {
    const cancelSiblings = options.cancelSiblingsOnFailure ?? true;
    const shared = new AbortController();
    return Promise.all(inputs.map(async (input) => {
      const controller = new AbortController();
      const abortFromShared = () => controller.abort(shared.signal.reason ?? new Error("Sibling tool failed"));
      const abortFromInput = () => controller.abort(input.signal?.reason ?? new Error("Cancelled"));
      if (shared.signal.aborted) abortFromShared(); else shared.signal.addEventListener("abort", abortFromShared, { once: true });
      if (input.signal?.aborted) abortFromInput(); else input.signal?.addEventListener("abort", abortFromInput, { once: true });
      try {
        const output = await this.execute({ ...input, signal: controller.signal });
        if (cancelSiblings && (output.status === "failed" || output.status === "denied" || output.status === "cancelled")) shared.abort(new Error(`Sibling tool ${output.toolCallId} ${output.status}`));
        return output;
      } finally {
        shared.signal.removeEventListener("abort", abortFromShared);
        input.signal?.removeEventListener("abort", abortFromInput);
      }
    }));
  }

  async resolvePermission(permissionId: PermissionId, status: "approved" | "denied" | "cancelled"): Promise<ExecuteToolOutput> {
    const pending = this.pending.get(permissionId);
    if (pending === undefined) {
      const previous = this.resolved.get(permissionId);
      if (previous !== undefined) return previous;
      throw new Error(`Unknown or already resolved permission: ${permissionId}`);
    }
    this.pending.delete(permissionId);
    const expiryTimer = this.expiryTimers.get(permissionId);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    this.expiryTimers.delete(permissionId);
    const currentPolicy = new DefaultPermissionPolicy({ preset: this.permissionPresetFor(pending.permission.sessionId) });
    const resolutionStatus: PermissionStatus = Date.parse(pending.permission.expiresAt) <= Date.now()
      ? "expired"
      : status === "approved" && currentPolicy.evaluate(pending.definition).mode === "deny" ? "denied" : status;
    await this.options.store.append({
      sessionId: pending.permission.sessionId,
      ...(pending.permission.turnId === undefined ? {} : { turnId: pending.permission.turnId }),
      type: "permission/resolved",
      payload: {
        permissionId,
        toolCallId: pending.permission.toolCallId,
        toolName: pending.permission.toolName,
        riskLevel: pending.permission.riskLevel,
        reason: pending.permission.reason,
        caller: pending.permission.caller,
        workspaceRoot: pending.permission.workspaceRoot,
        expiresAt: pending.permission.expiresAt,
        status: resolutionStatus,
      },
    });
    if (resolutionStatus !== "approved") {
      const result = this.errorResult(resolutionStatus === "expired" ? "PERMISSION_EXPIRED" : resolutionStatus === "cancelled" ? "PERMISSION_CANCELLED" : "PERMISSION_DENIED", `Permission ${resolutionStatus}`);
      await this.options.store.append({
        sessionId: pending.permission.sessionId,
        ...(pending.permission.turnId === undefined ? {} : { turnId: pending.permission.turnId }),
        type: "tool/result",
        payload: { toolCallId: pending.permission.toolCallId, status: resolutionStatus === "cancelled" ? "cancelled" : "denied", result },
      });
      const output = { toolCallId: pending.permission.toolCallId, status: resolutionStatus === "cancelled" ? "cancelled" : "denied", result } as const;
      this.resolved.set(permissionId, output);
      return output;
    }
    const output = await this.runApproved(pending.permission.toolCallId, pending.definition, pending.request);
    this.resolved.set(permissionId, output);
    return output;
  }

  async cancel(toolCallId: ToolCallId): Promise<boolean> {
    const running = this.running.get(toolCallId);
    if (running !== undefined) {
      running.abort(new Error("Cancelled by user"));
      return true;
    }
    for (const [permissionId, pending] of this.pending) {
      if (pending.permission.toolCallId === toolCallId) {
        pending.controller.abort(new Error("Cancelled by user"));
        await this.resolvePermission(permissionId, "cancelled");
        return true;
      }
    }
    return false;
  }

  async resolveInteraction(interactionId: InteractionId, status: "answered" | "cancelled" | "expired", answer?: string): Promise<UserInteractionAnswer> {
    const pending = this.pendingInteractions.get(interactionId);
    if (pending === undefined) {
      const previous = this.resolvedInteractions.get(interactionId);
      if (previous !== undefined) return previous;
      throw new Error(`Unknown or already resolved interaction: ${interactionId}`);
    }
    this.pendingInteractions.delete(interactionId);
    const expiryTimer = this.interactionExpiryTimers.get(interactionId);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    this.interactionExpiryTimers.delete(interactionId);
    const resolved: UserInteractionAnswer = status === "answered"
      ? { interactionId, status, ...(answer === undefined ? {} : { answer }) }
      : { interactionId, status };
    await this.options.store.append({
      sessionId: pending.request.sessionId,
      ...(pending.request.turnId === undefined ? {} : { turnId: pending.request.turnId }),
      type: "interaction/resolved",
      payload: {
        interactionId,
        toolCallId: pending.request.toolCallId,
        question: pending.request.question,
        options: pending.request.options,
        allowFreeform: pending.request.allowFreeform,
        status,
        ...(answer === undefined ? {} : { answer }),
      },
    });
    this.resolvedInteractions.set(interactionId, resolved);
    if (pending.restored === true) {
      const result = status === "answered"
        ? { ok: true, output: { interactionId, answer: answer ?? "" }, presentation: { kind: "tool", title: "Completed" } }
        : this.errorResult(status === "expired" ? "INTERACTION_EXPIRED" : "INTERACTION_CANCELLED", `User interaction ${status}`);
      await this.options.store.append({
        sessionId: pending.request.sessionId,
        ...(pending.request.turnId === undefined ? {} : { turnId: pending.request.turnId }),
        type: "tool/result",
        payload: { toolCallId: pending.request.toolCallId, status: status === "answered" ? "completed" : "cancelled", result },
      });
      return resolved;
    }
    if (status === "answered") {
      pending.resolve(resolved);
    } else {
      const error = new Error(`User interaction ${status}`);
      Object.assign(error, { code: status === "cancelled" ? "INTERACTION_CANCELLED" : "INTERACTION_EXPIRED" });
      pending.controller.abort(error);
      pending.reject(error);
    }
    return resolved;
  }

  private async runApproved(toolCallId: ToolCallId, definition: ToolDefinition, request: ExecuteToolInput): Promise<ExecuteToolOutput> {
    const controller = new AbortController();
    this.running.set(toolCallId, controller);
    const onAbort = () => controller.abort(request.signal?.reason ?? new Error("Cancelled"));
    if (request.signal?.aborted) controller.abort(request.signal.reason ?? new Error("Cancelled"));
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Tool execution timed out")), this.defaultTimeoutMs);
    const execute = async (): Promise<ExecuteToolOutput> => {
      if (controller.signal.aborted) {
        const result = this.errorResult("TOOL_CANCELLED", "Tool was cancelled before execution");
        await this.append(request, "tool/result", { toolCallId, status: "cancelled", result });
        return { toolCallId, status: "cancelled", result };
      }
      await this.append(request, "tool/progress", { toolCallId, status: "running", phase: "started" });
      try {
        const result = await definition.execute(request.input, {
          sessionId: request.sessionId,
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
          toolCallId,
          workspaceRoot: request.workspaceRoot,
          caller: request.caller ?? "agent",
          signal: controller.signal,
          reportProgress: async (payload) => this.append(request, "tool/progress", { toolCallId, ...payload }),
          appendEvent: async (type, payload) => this.append(request, type, payload),
          requestUserInput: async (input) => this.requestUserInput(request, toolCallId, input, controller),
        });
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
        const presented = result.presentation ?? definition.presentResult?.(result);
        const enriched = presented === undefined ? result : { ...result, presentation: presented };
        const bounded = boundResult(enriched, this.outputBudgetBytes);
        await this.append(request, "tool/result", { toolCallId, status: bounded.ok ? "completed" : "failed", result: bounded });
        if (bounded.diff !== undefined) await this.append(request, "diff/preview", { toolCallId, diff: bounded.diff });
        return { toolCallId, status: bounded.ok ? "completed" : "failed", result: bounded };
      } catch (error) {
        const reason = controller.signal.reason;
        const timedOut = reason instanceof Error && reason.message === "Tool execution timed out";
        const cancelled = controller.signal.aborted && !timedOut;
        const errorCode = timedOut ? "TOOL_TIMEOUT" : cancelled ? "TOOL_CANCELLED" : errorCodeOf(error) ?? "TOOL_EXECUTION_FAILED";
        const result = this.errorResult(errorCode, error instanceof Error ? error.message : String(error));
        await this.append(request, "tool/result", { toolCallId, status: cancelled ? "cancelled" : "failed", result });
        return { toolCallId, status: cancelled ? "cancelled" : "failed", result };
      } finally {
        clearTimeout(timeout);
        this.running.delete(toolCallId);
        request.signal?.removeEventListener("abort", onAbort);
      }
    };
    if (definition.executionMode !== "exclusive") return execute();
    const previous = this.activeExclusive.get(request.sessionId) ?? Promise.resolve();
    const current = previous.then(execute, execute);
    const tracked = current.then(() => undefined, () => undefined);
    this.activeExclusive.set(request.sessionId, tracked);
    try { return await current; } finally { if (this.activeExclusive.get(request.sessionId) === tracked) this.activeExclusive.delete(request.sessionId); }
  }

  private async append(input: ExecuteToolInput, type: AgentEvent["type"], payload: Record<string, unknown>): Promise<void> {
    await this.options.store.append({ sessionId: input.sessionId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }), ...(input.commandId === undefined ? {} : { correlationId: input.commandId }), type, payload });
  }

  private async requestUserInput(
    request: ExecuteToolInput,
    toolCallId: ToolCallId,
    input: UserInteractionInput,
    controller: AbortController,
  ): Promise<UserInteractionAnswer> {
    const question = input.question.trim();
    if (question.length === 0) throw new Error("INTERACTION_QUESTION_REQUIRED");
    const options: readonly InteractionOption[] = (input.options ?? []).map((option) => ({ label: option.label.trim(), value: option.value.trim() })).filter((option) => option.label.length > 0 && option.value.length > 0);
    const interactionId = brand<string, "InteractionId">(`interaction_${randomUUID()}`);
    const interaction: UserInteractionRequest = {
      id: interactionId,
      sessionId: request.sessionId,
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      toolCallId,
      question,
      options,
      allowFreeform: input.allowFreeform ?? true,
      caller: request.caller ?? "agent",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.permissionTtlMs).toISOString(),
    };
    const pendingAnswer = new Promise<UserInteractionAnswer>((resolve, reject) => {
      this.pendingInteractions.set(interactionId, { request: interaction, controller, resolve, reject });
      const onAbort = () => {
        controller.signal.removeEventListener("abort", onAbort);
        void this.resolveInteraction(interactionId, "cancelled").catch(() => undefined);
      };
      if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        void this.resolveInteraction(interactionId, "expired").catch(() => undefined);
      }, this.permissionTtlMs);
      timer.unref();
      this.interactionExpiryTimers.set(interactionId, timer);
    });
    await this.append(request, "interaction/requested", {
      interactionId,
      toolCallId,
      question,
      options,
      allowFreeform: interaction.allowFreeform,
      caller: interaction.caller,
      createdAt: interaction.createdAt,
      expiresAt: interaction.expiresAt,
    });
    return pendingAnswer;
  }

  private errorResult(code: string, message: string): ToolResult {
    return { ok: false, error: { code, message, remedy: remedyFor(code) }, presentation: { kind: "tool", title: code, text: message } };
  }

  private scheduleExpiry(permissionId: PermissionId, expiresAt: string): void {
    const schedule = (): void => {
      const remaining = Date.parse(expiresAt) - Date.now();
      if (remaining > 0) {
        const timer = setTimeout(schedule, Math.max(1, remaining));
        timer.unref();
        this.expiryTimers.set(permissionId, timer);
        return;
      }
      this.expiryTimers.delete(permissionId);
      void this.resolvePermission(permissionId, "cancelled").catch(() => undefined);
    };
    schedule();
  }

  private scheduleInteractionExpiry(interactionId: InteractionId, expiresAt: string): void {
    const schedule = (): void => {
      const remaining = Date.parse(expiresAt) - Date.now();
      if (remaining > 0) {
        const timer = setTimeout(schedule, Math.max(1, remaining));
        timer.unref();
        this.interactionExpiryTimers.set(interactionId, timer);
        return;
      }
      this.interactionExpiryTimers.delete(interactionId);
      void this.resolveInteraction(interactionId, "expired").catch(() => undefined);
    };
    schedule();
  }

  private async resolveRestoredInteraction(interaction: UserInteractionRequest, status: "expired" | "cancelled"): Promise<void> {
    await this.options.store.append({
      sessionId: interaction.sessionId,
      ...(interaction.turnId === undefined ? {} : { turnId: interaction.turnId }),
      type: "interaction/resolved",
      payload: {
        interactionId: interaction.id,
        toolCallId: interaction.toolCallId,
        question: interaction.question,
        options: interaction.options,
        allowFreeform: interaction.allowFreeform,
        status,
      },
    });
    const result = this.errorResult(status === "expired" ? "INTERACTION_EXPIRED" : "INTERACTION_CANCELLED", `User interaction ${status}`);
    await this.options.store.append({
      sessionId: interaction.sessionId,
      ...(interaction.turnId === undefined ? {} : { turnId: interaction.turnId }),
      type: "tool/result",
      payload: { toolCallId: interaction.toolCallId, status: "cancelled", result },
    });
    this.resolvedInteractions.set(interaction.id, { interactionId: interaction.id, status });
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? code : undefined;
}

function interactionOptions(value: unknown): readonly InteractionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): InteractionOption[] => {
    if (typeof item !== "object" || item === null) return [];
    const option = item as Record<string, unknown>;
    return typeof option.label === "string" && typeof option.value === "string"
      ? [{ label: option.label, value: option.value }]
      : [];
  });
}

function defaultCallPresentation(definition: ToolDefinition): { readonly kind: "tool" | "diff" | "terminal"; readonly title: string; readonly data: { readonly riskLevel: string; readonly executionMode: string } } {
  const kind = definition.riskLevel === "execute" ? "terminal" : definition.riskLevel === "write" ? "diff" : "tool";
  return { kind, title: definition.name, data: { riskLevel: definition.riskLevel, executionMode: definition.executionMode } };
}

function remedyFor(code: string): string {
  if (code === "TOOL_NOT_FOUND") return "Check the visible tool catalog and use a supported tool name.";
  if (code === "TOOL_DISABLED") return "Use a visible enabled tool or wait for the permission preset to change.";
  if (code === "PERMISSION_DENIED" || code === "PERMISSION_EXPIRED" || code === "PERMISSION_CANCELLED") return "Respect the permission result and choose a narrower safe alternative.";
  if (code === "TOOL_TIMEOUT") return "Reduce the scope or timeout-sensitive work and retry only when the operation is safe.";
  if (code === "TOOL_CANCELLED" || code === "COMMAND_CANCELLED") return "Inspect the partial result and continue only from the last confirmed state.";
  if (code === "INVALID_TOOL_INPUT" || code === "MALFORMED_TOOL_ARGUMENTS") return "Check the tool schema and send only valid arguments.";
  if (code === "WORKDIR_INVALID" || code === "TERMINAL_CWD_INVALID") return "Use an existing directory inside the active workspace.";
  if (code === "COMMAND_NOT_FOUND") return "Check the executable name and the configured allowlist.";
  if (code === "NON_ZERO_EXIT" || code === "COMMAND_EXITED") return "Inspect stdout/stderr and exit metadata before choosing the next command.";
  if (code === "OUTPUT_TRUNCATED") return "Narrow the command or search scope, or use the reported bounded output/spill path.";
  if (code === "TEXT_NOT_FOUND" || code === "TEXT_NOT_UNIQUE" || code === "EDIT_STALE") return "Reread the current file and use a unique current context before editing.";
  return "Inspect the structured error and adjust the next step; do not blindly repeat the same call.";
}

function boundResult(result: ToolResult, budget: number): ToolResult {
  const complete = result.audit ?? result.output;
  const serialized = result.output === undefined ? "" : JSON.stringify(result.output);
  const base: ToolResult = {
    ...result,
    ...(complete === undefined ? {} : { audit: complete }),
    ...(result.output === undefined ? {} : { modelView: result.modelView ?? result.output }),
  };
  if (Buffer.byteLength(serialized, "utf8") <= budget) return base;
  const text = serialized.slice(0, Math.max(0, budget - 64));
  return { ...base, modelView: `${text}…`, usage: { bytes: Buffer.byteLength(serialized, "utf8"), truncated: true } };
}
