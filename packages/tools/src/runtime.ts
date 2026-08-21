import {
  brand,
  type AgentEvent,
  type EventStore,
  type PermissionId,
  type PermissionRequest,
  type PermissionStatus,
  type SessionId,
  type ToolCallId,
  type ToolDefinition,
  type ToolResult,
  type TurnId,
} from "@code-review-agent/contracts";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "./registry.js";
import { assertValidInput } from "./schema.js";
import { DefaultPermissionPolicy, type PermissionPolicy } from "./permissions.js";

export interface ToolRuntimeOptions {
  readonly store: EventStore;
  readonly registry: ToolRegistry;
  readonly policy?: PermissionPolicy;
  readonly defaultTimeoutMs?: number;
  readonly outputBudgetBytes?: number;
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
}

export interface ExecuteToolOutput {
  readonly toolCallId: ToolCallId;
  readonly status: "completed" | "failed" | "cancelled" | "denied" | "awaiting_permission";
  readonly result?: ToolResult;
  readonly permission?: PermissionRequest;
}

interface PendingExecution {
  readonly permission: PermissionRequest;
  readonly definition: ToolDefinition;
  readonly request: ExecuteToolInput;
  readonly controller: AbortController;
}

/** Durable tool execution pipeline: discover, validate, policy, approval, execute, result. */
export class ToolRuntime {
  private readonly policy: PermissionPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly outputBudgetBytes: number;
  private readonly pending = new Map<PermissionId, PendingExecution>();
  private readonly running = new Map<ToolCallId, AbortController>();
  private readonly activeExclusive = new Map<SessionId, Promise<unknown>>();

  constructor(private readonly options: ToolRuntimeOptions) {
    this.policy = options.policy ?? new DefaultPermissionPolicy();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.outputBudgetBytes = options.outputBudgetBytes ?? 64 * 1024;
  }

  listTools(): readonly ToolDefinition[] {
    return this.options.registry.list();
  }

  pendingPermissions(): readonly PermissionRequest[] {
    return [...this.pending.values()].map((item) => item.permission);
  }

  async restorePending(sessionId: SessionId, workspaceRoot: string, events: readonly AgentEvent[]): Promise<void> {
    const requests = new Map<string, PermissionRequest>();
    const resolved = new Set<string>();
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
          createdAt: typeof payload.createdAt === "string" ? payload.createdAt : event.createdAt,
        });
      }
      if (event.type === "permission/resolved" && typeof event.payload.permissionId === "string") resolved.add(event.payload.permissionId);
    }
    for (const permission of requests.values()) {
      if (resolved.has(permission.id) || this.pending.has(permission.id) || !this.options.registry.has(permission.toolName)) continue;
      const definition = this.options.registry.get(permission.toolName);
      this.pending.set(permission.id, {
        permission,
        definition,
        request: { sessionId, workspaceRoot, name: permission.toolName, input: permission.input, ...(permission.turnId === undefined ? {} : { turnId: permission.turnId }), toolCallId: permission.toolCallId },
        controller: new AbortController(),
      });
    }
  }

  async execute(input: ExecuteToolInput): Promise<ExecuteToolOutput> {
    const definition = this.options.registry.validate(input.name, input.input);
    const toolCallId = input.toolCallId ?? brand<string, "ToolCallId">(`tool_${randomUUID()}`);
    const evaluation = this.policy.evaluate(definition);
    await this.append(input, "tool/call", {
      toolCallId,
      name: definition.name,
      input: input.input,
      riskLevel: definition.riskLevel,
      approvalMode: evaluation.mode,
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
        createdAt: new Date().toISOString(),
      };
      this.pending.set(permissionId, { permission, definition, request: input, controller: new AbortController() });
      await this.append(input, "permission/requested", { permissionId: permission.id, ...permission });
      return { toolCallId, status: "awaiting_permission", permission };
    }
    return this.runApproved(toolCallId, definition, input);
  }

  async resolvePermission(permissionId: PermissionId, status: Exclude<PermissionStatus, "pending" | "cancelled"> | "cancelled"): Promise<ExecuteToolOutput> {
    const pending = this.pending.get(permissionId);
    if (pending === undefined) throw new Error(`Unknown or already resolved permission: ${permissionId}`);
    this.pending.delete(permissionId);
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
        status,
      },
    });
    if (status !== "approved") {
      const result = this.errorResult(status === "cancelled" ? "PERMISSION_CANCELLED" : "PERMISSION_DENIED", `Permission ${status}`);
      await this.options.store.append({
        sessionId: pending.permission.sessionId,
        ...(pending.permission.turnId === undefined ? {} : { turnId: pending.permission.turnId }),
        type: "tool/result",
        payload: { toolCallId: pending.permission.toolCallId, status: status === "cancelled" ? "cancelled" : "denied", result },
      });
      return { toolCallId: pending.permission.toolCallId, status: status === "cancelled" ? "cancelled" : "denied", result };
    }
    return this.runApproved(pending.permission.toolCallId, pending.definition, pending.request);
  }

  cancel(toolCallId: ToolCallId): boolean {
    const running = this.running.get(toolCallId);
    if (running !== undefined) {
      running.abort(new Error("Cancelled by user"));
      return true;
    }
    for (const [permissionId, pending] of this.pending) {
      if (pending.permission.toolCallId === toolCallId) {
        pending.controller.abort(new Error("Cancelled by user"));
        this.pending.delete(permissionId);
        return true;
      }
    }
    return false;
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
          signal: controller.signal,
          reportProgress: async (payload) => this.append(request, "tool/progress", { toolCallId, ...payload }),
        });
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
        const bounded = boundResult(result, this.outputBudgetBytes);
        await this.append(request, "tool/result", { toolCallId, status: bounded.ok ? "completed" : "failed", result: bounded });
        if (bounded.diff !== undefined) await this.append(request, "diff/preview", { toolCallId, diff: bounded.diff });
        return { toolCallId, status: bounded.ok ? "completed" : "failed", result: bounded };
      } catch (error) {
        const reason = controller.signal.reason;
        const timedOut = reason instanceof Error && reason.message === "Tool execution timed out";
        const cancelled = controller.signal.aborted && !timedOut;
        const result = this.errorResult(timedOut ? "TOOL_TIMEOUT" : cancelled ? "TOOL_CANCELLED" : "TOOL_EXECUTION_FAILED", error instanceof Error ? error.message : String(error));
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

  private errorResult(code: string, message: string): ToolResult {
    return { ok: false, error: { code, message }, presentation: { kind: "tool", title: code, text: message } };
  }
}

function boundResult(result: ToolResult, budget: number): ToolResult {
  const serialized = result.output === undefined ? "" : JSON.stringify(result.output);
  if (Buffer.byteLength(serialized, "utf8") <= budget) return result;
  const text = serialized.slice(0, Math.max(0, budget - 64));
  return { ...result, output: `${text}…`, usage: { bytes: Buffer.byteLength(serialized, "utf8"), truncated: true } };
}
