import {
  brand,
  type ArtifactRef,
  type ChildReportInput,
  type PermissionPreset,
  type SessionEventStore,
  type SessionId,
  type SubagentDescriptor,
  type SubagentMode,
  type SubagentStatus,
  type TaskBudget,
  type TaskId,
  type TaskProjection,
  type TaskReport,
  type ReportDeliveryPolicy,
  type TaskStopReason,
  type ToolError,
} from "@code-review-agent/contracts";
import { randomUUID } from "node:crypto";
import { foldSubagentDescriptor, snapshotDescriptor } from "./descriptor.js";
import { TaskService, childMetadata } from "./task-service.js";

export interface ProviderCapabilities {
  readonly oneShot: boolean;
  readonly continuable: boolean;
  readonly outputSchema: boolean;
  readonly toolFilter: boolean;
  readonly maxDepth?: number;
}

export interface SpawnSubagentRequest {
  readonly parentSessionId: SessionId;
  readonly prompt: string;
  readonly mode?: SubagentMode;
  readonly background?: boolean;
  readonly label?: string;
  readonly parentTaskId?: TaskId;
  readonly provider?: string;
  readonly workspaceRoot: string;
  readonly permissionPreset: PermissionPreset;
  readonly toolAllowlist?: readonly string[];
  readonly mcpAllowlist?: readonly string[];
  readonly model?: string;
  readonly delegationDepth?: number;
  readonly budget?: TaskBudget;
  readonly outputSchema?: Record<string, unknown>;
  readonly taskId?: TaskId;
  readonly commandId?: string;
  readonly signal?: AbortSignal;
}

export interface ProviderRunContext {
  readonly taskId: TaskId;
  readonly childSessionId: SessionId;
  readonly descriptor: SubagentDescriptor;
  readonly signal: AbortSignal;
  readonly appendEvent: (type: "subagent/start" | "subagent/end" | "subagent/inbox" | "subagent/settlement", payload: Record<string, unknown>) => Promise<void>;
}

export interface ProviderRun {
  readonly result: () => Promise<TaskReport>;
  readonly dispose: () => Promise<void>;
  readonly interrupt?: () => Promise<void>;
  readonly sendMessage?: (prompt: string, signal: AbortSignal) => Promise<TaskReport>;
}

export interface AgentCatalogEntry {
  readonly task: TaskProjection;
  readonly status: SubagentStatus;
  readonly live: boolean;
  readonly resumable: boolean;
}

export interface SubagentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  start(request: { readonly prompt: string; readonly descriptor: SubagentDescriptor; readonly budget?: TaskBudget; readonly outputSchema?: Record<string, unknown> }, context: ProviderRunContext): Promise<ProviderRun>;
  resume?(descriptor: SubagentDescriptor, context: ProviderRunContext): Promise<ProviderRun>;
}

export interface SpawnReceipt {
  readonly taskId: TaskId;
  readonly childSessionId: SessionId;
  readonly status: SubagentStatus;
  readonly report?: TaskReport;
}

export interface TaskOutput {
  readonly task: TaskProjection;
  readonly report?: TaskReport;
  readonly events: readonly import("@code-review-agent/contracts").AgentEvent[];
}

interface LiveChild {
  readonly taskId: TaskId;
  readonly childSessionId: SessionId;
  readonly descriptor: SubagentDescriptor;
  readonly provider: SubagentProvider;
  readonly run: ProviderRun;
  readonly controller: AbortController;
  readonly mode: SubagentMode;
  readonly parentSessionId: SessionId;
  readonly providerRunAppend: (type: "subagent/start" | "subagent/end" | "subagent/inbox" | "subagent/settlement", payload: Record<string, unknown>) => Promise<void>;
  queue: Promise<void>;
}

function newChildSessionId(): SessionId { return brand<string, "SessionId">(`ses_${randomUUID()}`); }
function newTaskId(): TaskId { return brand<string, "TaskId">(`task_${randomUUID()}`); }
function error(code: string, message: string): ToolError { return { code, message }; }

/** Durable multi-agent lifecycle facade. Providers are adapters; the store remains the source of truth. */
export class SubagentRuntime {
  private readonly providers = new Map<string, SubagentProvider>();
  private readonly live = new Map<TaskId, LiveChild>();
  private readonly tasks: TaskService;

  constructor(private readonly options: { readonly store: SessionEventStore; readonly maxDepth?: number; readonly providers?: readonly SubagentProvider[] }) {
    this.tasks = new TaskService(options.store);
    for (const provider of options.providers ?? []) this.registerProvider(provider);
  }

  registerProvider(provider: SubagentProvider): void {
    if (this.providers.has(provider.name)) throw new Error(`SUBAGENT_PROVIDER_DUPLICATE: ${provider.name}`);
    this.providers.set(provider.name, provider);
  }

  providerCatalog(): readonly { readonly name: string; readonly capabilities: ProviderCapabilities }[] {
    return [...this.providers.values()].map((provider) => ({ name: provider.name, capabilities: provider.capabilities }));
  }

  async spawn(request: SpawnSubagentRequest): Promise<SpawnReceipt> {
    if (request.commandId !== undefined) {
      const existing = (await this.options.store.list(request.parentSessionId)).find((event) => event.correlationId === request.commandId && event.type === "task/created");
      const existingTaskId = existing?.payload["taskId"];
      if (typeof existingTaskId === "string") {
        const task = (await this.options.store.listTasks(request.parentSessionId)).find((candidate) => candidate.id === existingTaskId);
        if (task !== undefined && task.childSessionId !== undefined) return { taskId: task.id, childSessionId: task.childSessionId, status: task.report?.status === "completed" || task.status === "completed" ? "completed" : task.status === "cancelled" ? "cancelled" : task.status === "failed" ? "failed" : task.status === "waiting" ? "ready" : "queued", ...(task.report === undefined ? {} : { report: task.report }) };
      }
    }
    const mode = request.mode ?? "one-shot";
    const providerName = request.provider ?? "in-process";
    const provider = this.providers.get(providerName);
    if (provider === undefined) return this.reject(request, "SUBAGENT_PROVIDER_NOT_FOUND", `Unknown provider: ${providerName}`);
    const capability = provider.capabilities;
    if (mode === "one-shot" && !capability.oneShot) return this.reject(request, "SUBAGENT_CAPABILITY_UNSUPPORTED", `Provider ${providerName} does not support one-shot runs`);
    if (mode === "continuable" && !capability.continuable) return this.reject(request, "SUBAGENT_CAPABILITY_UNSUPPORTED", `Provider ${providerName} does not support continuable children`);
    if (request.outputSchema !== undefined && !capability.outputSchema) return this.reject(request, "SUBAGENT_CAPABILITY_UNSUPPORTED", `Provider ${providerName} does not support outputSchema`);
    if ((request.toolAllowlist !== undefined || request.mcpAllowlist !== undefined) && !capability.toolFilter) return this.reject(request, "SUBAGENT_CAPABILITY_UNSUPPORTED", `Provider ${providerName} does not support tool filtering`);
    const depth = request.delegationDepth ?? 0;
    if (!Number.isInteger(depth) || depth < 0 || depth > (this.options.maxDepth ?? 8) || (capability.maxDepth !== undefined && depth > capability.maxDepth)) return this.reject(request, "SUBAGENT_DEPTH_EXCEEDED", `Delegation depth ${depth} is not allowed`);
    if (request.prompt.trim().length === 0) return this.reject(request, "SUBAGENT_PROMPT_REQUIRED", "Subagent prompt must not be empty");

    const taskId = request.taskId ?? newTaskId();
    const childSessionId = newChildSessionId();
    const descriptor = snapshotDescriptor({
      mode,
      provider: providerName,
      ...(request.label === undefined ? {} : { label: request.label }),
      parentSessionId: request.parentSessionId,
      parentTaskId: taskId,
      childSessionId,
      workspaceRoot: request.workspaceRoot,
      permissionPreset: request.permissionPreset,
      ...(request.toolAllowlist === undefined ? {} : { toolAllowlist: request.toolAllowlist }),
      ...(request.mcpAllowlist === undefined ? {} : { mcpAllowlist: request.mcpAllowlist }),
      ...(request.model === undefined ? {} : { model: request.model }),
      delegationDepth: depth,
    });
    await this.tasks.create({
      parentSessionId: request.parentSessionId,
      taskId,
      ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
      childSessionId,
      ...(request.label === undefined ? {} : { title: request.label }),
      mode,
      provider: providerName,
      workspaceRoot: request.workspaceRoot,
      permissionPreset: request.permissionPreset,
      delegationDepth: depth,
      ...(request.budget === undefined ? {} : { budget: request.budget }),
    }, request.commandId);
    await this.options.store.createChildSession({
      id: childSessionId,
      workspaceRoot: request.workspaceRoot,
      permissionPreset: request.permissionPreset,
      metadata: childMetadata(descriptor),
    });
    await this.options.store.append({ sessionId: childSessionId, type: "subagent/descriptor", payload: { descriptor } });
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal?.reason ?? new Error("Subagent cancelled"));
    if (request.signal?.aborted) onAbort(); else request.signal?.addEventListener("abort", onAbort, { once: true });
    const context: ProviderRunContext = {
      taskId,
      childSessionId,
      descriptor,
      signal: controller.signal,
      appendEvent: async (type, payload) => { await this.options.store.append({ sessionId: childSessionId, type, payload }); },
    };
    let run: ProviderRun;
    try {
      run = await provider.start({ prompt: request.prompt, descriptor, ...(request.budget === undefined ? {} : { budget: request.budget }), ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }) }, context);
    } catch (cause) {
      await this.finishFailure(request.parentSessionId, childSessionId, taskId, providerName, cause);
      request.signal?.removeEventListener("abort", onAbort);
      return { taskId, childSessionId, status: "failed" };
    }
    const providerRunAppend = async (type: "subagent/start" | "subagent/end" | "subagent/inbox" | "subagent/settlement", payload: Record<string, unknown>) => { await this.options.store.append({ sessionId: childSessionId, type, payload }); };
    const live: LiveChild = { taskId, childSessionId, descriptor, provider, run, controller, mode, parentSessionId: request.parentSessionId, providerRunAppend, queue: Promise.resolve() };
    this.live.set(taskId, live);
    await this.options.store.append({ sessionId: childSessionId, type: "subagent/start", payload: { taskId, childSessionId, parentSessionId: request.parentSessionId, mode, provider: providerName } });
    const background = request.background ?? false;
    if (mode === "continuable") {
      void this.settleContinuable(live).catch(() => undefined);
      request.signal?.removeEventListener("abort", onAbort);
      return { taskId, childSessionId, status: "queued" };
    }
    if (background) {
      void this.settle(live, request.signal).catch(() => undefined);
      request.signal?.removeEventListener("abort", onAbort);
      return { taskId, childSessionId, status: "queued" };
    }
    const report = await this.settle(live, request.signal);
    request.signal?.removeEventListener("abort", onAbort);
    return { taskId, childSessionId, status: report.status === "completed" ? "completed" : report.status === "cancelled" ? "cancelled" : "failed", report };
  }

  async taskQuery(parentSessionId: SessionId, taskId: TaskId): Promise<TaskProjection | undefined> {
    return (await this.options.store.listTasks(parentSessionId)).find((task) => task.id === taskId);
  }

  async taskOutput(parentSessionId: SessionId, taskId: TaskId): Promise<TaskOutput | undefined> {
    const task = (await this.options.store.listTasks()).find((candidate) => candidate.id === taskId);
    if (task === undefined || task.childSessionId === undefined) return task === undefined ? undefined : { task, events: [] };
    return { task, ...(task.report === undefined ? {} : { report: task.report }), events: await this.options.store.list(task.childSessionId) };
  }

  async cancel(parentSessionId: SessionId, taskId: TaskId, commandId?: string): Promise<TaskProjection> {
    const task = (await this.options.store.listTasks()).find((candidate) => candidate.id === taskId);
    if (task === undefined || task.parentSessionId === undefined || !(await this.isAuthority(parentSessionId, task))) throw new Error("SUBAGENT_AUTHORITY_DENIED");
    const live = this.live.get(taskId);
    if (live !== undefined) {
      live.controller.abort(new Error("Cancelled by parent"));
      if (live.run.interrupt !== undefined) await live.run.interrupt().catch(() => undefined);
    }
    return this.tasks.cancel(task.parentSessionId, taskId, commandId);
  }

  async listAgents(parentSessionId: SessionId, scope: "children" | "descendants" = "children"): Promise<readonly TaskProjection[]> {
    const all = await this.options.store.listTasks();
    const children = all.filter((task) => task.parentSessionId === parentSessionId);
    if (scope === "children") return children;
    const result: TaskProjection[] = [...children];
    const queue = [...children];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.childSessionId === undefined) continue;
      const descendants = all.filter((task) => task.parentSessionId === current.childSessionId);
      result.push(...descendants);
      queue.push(...descendants);
    }
    return result;
  }

  async agentCatalog(parentSessionId: SessionId, scope: "children" | "descendants" = "children"): Promise<readonly AgentCatalogEntry[]> {
    const tasks = await this.listAgents(parentSessionId, scope);
    return tasks.map((task) => ({
      task,
      status: this.live.has(task.id) ? "running" : task.status === "waiting" ? "ready" : task.status === "queued" ? "ready" : task.status === "cancelled" ? "cancelled" : task.status === "failed" ? "failed" : "completed",
      live: this.live.has(task.id),
      resumable: task.mode === "continuable" && task.childSessionId !== undefined && task.status !== "completed" && task.status !== "cancelled" && task.status !== "failed",
    }));
  }

  async sendMessage(parentSessionId: SessionId, taskId: TaskId, prompt: string): Promise<{ readonly accepted: boolean; readonly taskId: TaskId }> {
    const live = await this.ensureContinuable(parentSessionId, taskId);
    if (live === undefined || live.mode !== "continuable" || live.run.sendMessage === undefined) throw new Error("SUBAGENT_NOT_CONTINUABLE");
    if (prompt.trim().length === 0) throw new Error("SUBAGENT_PROMPT_REQUIRED");
    const controller = new AbortController();
    const messageId = `msg_${randomUUID()}`;
    await live.providerRunAppend("subagent/inbox", { taskId, messageId, status: "queued", prompt, promptLength: prompt.length });
    live.queue = live.queue.catch(() => undefined).then(async () => {
      await live.providerRunAppend("subagent/inbox", { taskId, messageId, status: "started" });
      const report = await live.run.sendMessage!(prompt, controller.signal);
      await live.providerRunAppend("subagent/inbox", { taskId, messageId, status: "delivered" });
      await this.options.store.append({ sessionId: live.childSessionId, type: "subagent/end", payload: { taskId, activation: messageId, status: "ready", stopReason: report.stopReason } });
      await this.options.store.append({ sessionId: live.parentSessionId, type: "task/updated", payload: { taskId, status: "waiting", lastActivationReport: { summary: report.summary, status: report.status } } });
    });
    return { accepted: true, taskId };
  }

  async interrupt(parentSessionId: SessionId, taskId: TaskId): Promise<{ readonly accepted: boolean; readonly taskId: TaskId }> {
    const live = await this.ensureContinuable(parentSessionId, taskId);
    if (live === undefined) throw new Error("SUBAGENT_NOT_LIVE");
    live.controller.abort(new Error("Interrupted by parent"));
    if (live.run.interrupt !== undefined) await live.run.interrupt();
    return { accepted: true, taskId };
  }

  /** Child-scoped report. The recipient is always the descriptor's direct parent. */
  async report(childSessionId: SessionId, input: ChildReportInput): Promise<{ readonly accepted: boolean; readonly taskId: TaskId; readonly parentSessionId: SessionId; readonly delivery: ReportDeliveryPolicy }> {
    const events = await this.options.store.list(childSessionId);
    const descriptor = foldSubagentDescriptor(events);
    if (descriptor === undefined || descriptor.parentTaskId === undefined) throw new Error("SUBAGENT_REPORT_SCOPE_UNAVAILABLE");
    if (descriptor.mode !== "continuable") throw new Error("SUBAGENT_REPORT_CONTINUABLE_ONLY");
    const summary = input.summary.trim();
    if (summary.length === 0) throw new Error("SUBAGENT_REPORT_SUMMARY_REQUIRED");
    const delivery = input.delivery ?? "quiet";
    const artifacts = (input.artifacts ?? []).slice(0, 32).map((artifact) => ({
      ...artifact,
      label: artifact.label.slice(0, 256),
      ...(artifact.preview === undefined ? {} : { preview: artifact.preview.slice(0, 1024) }),
    }));
    const report: TaskReport = {
      taskId: descriptor.parentTaskId,
      childSessionId,
      status: "partial",
      summary: summary.slice(0, 4096),
      ...(input.output === undefined ? {} : { output: input.output }),
      artifacts,
    };
    await this.options.store.append({ sessionId: descriptor.parentSessionId, type: "task/report", payload: { taskId: descriptor.parentTaskId, report, delivery } });
    if (delivery === "wakeup") await this.options.store.append({ sessionId: descriptor.parentSessionId, type: "task/input-required", payload: { taskId: descriptor.parentTaskId, reason: "child_report", delivery } });
    await this.options.store.append({ sessionId: childSessionId, type: "subagent/settlement", payload: { taskId: descriptor.parentTaskId, childSessionId, status: "ready", report: { summary: report.summary, artifacts } } });
    return { accepted: true, taskId: descriptor.parentTaskId, parentSessionId: descriptor.parentSessionId, delivery };
  }

  /** Rehydrates a continuable child from its durable descriptor after a cold restart. */
  async resumeContinuable(parentSessionId: SessionId, taskId: TaskId): Promise<SpawnReceipt> {
    const task = (await this.options.store.listTasks()).find((candidate) => candidate.id === taskId);
    if (task === undefined || task.childSessionId === undefined || task.mode !== "continuable") throw new Error("SUBAGENT_NOT_RESUMABLE");
    const childEvents = await this.options.store.list(task.childSessionId);
    const descriptor = foldSubagentDescriptor(childEvents);
    if (descriptor === undefined) throw new Error("SUBAGENT_DESCRIPTOR_UNAVAILABLE");
    if (!(await this.isAuthority(parentSessionId, task))) throw new Error("SUBAGENT_AUTHORITY_DENIED");
    const provider = this.providers.get(descriptor.provider);
    if (provider?.resume === undefined) throw new Error("SUBAGENT_PROVIDER_COLD_RESUME_UNSUPPORTED");
    const controller = new AbortController();
    const providerRunAppend = async (type: "subagent/start" | "subagent/end" | "subagent/inbox" | "subagent/settlement", payload: Record<string, unknown>) => { await this.options.store.append({ sessionId: task.childSessionId!, type, payload }); };
    const live: LiveChild = {
      taskId,
      childSessionId: task.childSessionId,
      descriptor,
      provider,
      controller,
      mode: "continuable",
      parentSessionId: descriptor.parentSessionId,
      providerRunAppend,
      queue: Promise.resolve(),
      run: await provider.resume(descriptor, {
        taskId,
        childSessionId: task.childSessionId,
        descriptor,
        signal: controller.signal,
        appendEvent: providerRunAppend,
      }),
    };
    this.live.set(taskId, live);
    await this.options.store.append({ sessionId: task.childSessionId, type: "subagent/start", payload: { taskId, childSessionId: task.childSessionId, status: "ready", reason: "cold_resume" } });
    if (live.run.sendMessage !== undefined) {
      const delivered = new Set(childEvents.flatMap((event) => event.type === "subagent/inbox" && typeof event.payload["messageId"] === "string" && event.payload["status"] === "delivered" ? [event.payload["messageId"]] : []));
      const queued = childEvents.filter((event) => event.type === "subagent/inbox" && event.payload["status"] === "queued" && typeof event.payload["messageId"] === "string" && typeof event.payload["prompt"] === "string" && !delivered.has(event.payload["messageId"] as string));
      for (const event of queued) {
        const messageId = event.payload["messageId"] as string;
        const prompt = event.payload["prompt"] as string;
        live.queue = live.queue.then(async () => {
          await live.run.sendMessage!(prompt, controller.signal);
          await providerRunAppend("subagent/inbox", { taskId, messageId, status: "delivered", recovered: true });
        });
      }
    }
    return { taskId, childSessionId: task.childSessionId, status: "ready" };
  }

  private authorizedLive(parentSessionId: SessionId, taskId: TaskId): LiveChild | undefined {
    const live = this.live.get(taskId);
    return live?.parentSessionId === parentSessionId ? live : undefined;
  }

  private async ensureContinuable(parentSessionId: SessionId, taskId: TaskId): Promise<LiveChild | undefined> {
    const task = (await this.options.store.listTasks()).find((candidate) => candidate.id === taskId);
    if (task === undefined) throw new Error("SUBAGENT_AUTHORITY_DENIED");
    if (!(await this.isAuthority(parentSessionId, task))) throw new Error("SUBAGENT_AUTHORITY_DENIED");
    const live = this.live.get(taskId);
    if (live !== undefined) return live;
    if (task.mode === "continuable") return this.live.get(taskId) ?? await this.resumeContinuable(parentSessionId, taskId).then(() => this.live.get(taskId));
    return undefined;
  }

  private async isAuthority(requestingSessionId: SessionId, task: TaskProjection): Promise<boolean> {
    if (task.parentSessionId === requestingSessionId) return true;
    let current = task.parentSessionId;
    const visited = new Set<string>();
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      const projection = await this.options.store.project(current);
      current = projection?.parentSessionId;
      if (current === requestingSessionId) return true;
    }
    return false;
  }

  private async reject(request: SpawnSubagentRequest, code: string, message: string): Promise<SpawnReceipt> {
    const taskId = request.taskId ?? newTaskId();
    const childSessionId = newChildSessionId();
    await this.tasks.create({ parentSessionId: request.parentSessionId, taskId, childSessionId, ...(request.label === undefined ? {} : { title: request.label }), mode: request.mode ?? "one-shot", provider: request.provider ?? "unknown", workspaceRoot: request.workspaceRoot, permissionPreset: request.permissionPreset, delegationDepth: request.delegationDepth ?? 0 }, request.commandId);
    await this.options.store.append({ sessionId: request.parentSessionId, type: "task/ended", payload: { taskId, status: "failed", terminalReason: code, diagnostics: [error(code, message)] } });
    return { taskId, childSessionId, status: "rejected" };
  }

  private async finishFailure(parentSessionId: SessionId, childSessionId: SessionId, taskId: TaskId, provider: string, cause: unknown): Promise<void> {
    const diagnostic = error("SUBAGENT_START_FAILED", cause instanceof Error ? cause.message : String(cause));
    await this.options.store.append({ sessionId: parentSessionId, type: "task/ended", payload: { taskId, childSessionId, provider, status: "failed", terminalReason: "provider_start_failed", diagnostics: [diagnostic] } });
    await this.options.store.append({ sessionId: childSessionId, type: "subagent/end", payload: { taskId, status: "failed", diagnostics: [diagnostic] } }).catch(() => undefined);
  }

  private async settle(live: LiveChild, signal?: AbortSignal): Promise<TaskReport> {
    let result: TaskReport;
    try {
      result = await live.run.result();
    } catch (cause) {
      result = { taskId: live.taskId, childSessionId: live.childSessionId, status: signal?.aborted || live.controller.signal.aborted ? "cancelled" : "failed", stopReason: signal?.aborted || live.controller.signal.aborted ? "aborted" : "error", summary: cause instanceof Error ? cause.message : String(cause), artifacts: [], diagnostics: [error("SUBAGENT_RUN_FAILED", cause instanceof Error ? cause.message : String(cause))] };
    }
    try { await live.run.dispose(); } catch (cause) {
      result = { ...result, status: result.status === "completed" ? "partial" : result.status, diagnostics: [...(result.diagnostics ?? []), error("SUBAGENT_DISPOSE_FAILED", cause instanceof Error ? cause.message : String(cause))] };
    }
    await this.options.store.append({ sessionId: live.parentSessionId, type: "task/report", payload: { taskId: live.taskId, report: result } });
    await this.options.store.append({ sessionId: live.parentSessionId, type: "task/ended", payload: { taskId: live.taskId, childSessionId: live.childSessionId, status: result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed", terminalReason: result.stopReason, result: result.output, diagnostics: result.diagnostics } });
    await this.options.store.append({ sessionId: live.childSessionId, type: "subagent/settlement", payload: { taskId: live.taskId, childSessionId: live.childSessionId, status: result.status, stopReason: result.stopReason, summary: result.summary } }).catch(() => undefined);
    await this.options.store.append({ sessionId: live.childSessionId, type: "subagent/end", payload: { taskId: live.taskId, childSessionId: live.childSessionId, status: result.status, stopReason: result.stopReason } }).catch(() => undefined);
    this.live.delete(live.taskId);
    return result;
  }

  private async settleContinuable(live: LiveChild): Promise<void> {
    try {
      const report = await live.run.result();
      await this.options.store.append({ sessionId: live.childSessionId, type: "subagent/settlement", payload: { taskId: live.taskId, status: "ready", stopReason: report.stopReason, summary: report.summary } });
      await this.options.store.append({ sessionId: live.childSessionId, type: "subagent/end", payload: { taskId: live.taskId, status: "ready", stopReason: report.stopReason, summary: report.summary } });
      await this.options.store.append({ sessionId: live.parentSessionId, type: "task/updated", payload: { taskId: live.taskId, status: "waiting" } });
    } catch (cause) {
      await this.options.store.append({ sessionId: live.childSessionId, type: "subagent/end", payload: { taskId: live.taskId, status: "interrupted", diagnostics: [error("SUBAGENT_ACTIVATION_FAILED", cause instanceof Error ? cause.message : String(cause))] } });
      await this.options.store.append({ sessionId: live.parentSessionId, type: "task/updated", payload: { taskId: live.taskId, status: "waiting", terminalReason: "activation_failed" } });
    }
  }
}
