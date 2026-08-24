import {
  brand,
  type AgentEvent,
  type AgentEventType,
  type AppendEventInput,
  type ClaimCommandInput,
  type CommandClaim,
  type CommandRecord,
  type EventListener,
  type EventListOptions,
  type EventPage,
  type GoalProjection,
  type GoalStatus,
  type InteractionProjection,
  type InteractionStatus,
  type InteractionOption,
  type PermissionId,
  type PermissionProjection,
  type PermissionStatus,
  type SessionEventStore,
  type SessionId,
  type SessionProjection,
  type SessionStatus,
  type SessionSummary,
  type PermissionPreset,
  type ChildSessionMetadata,
  type ArtifactRef,
  type TaskReport,
  type TaskBudget,
  type ToolError,
  type SubagentMode,
  type PlanStatus,
  type TaskProjection,
  type TaskStatus,
  type ToolApprovalMode,
  type ToolCallId,
  type ToolCallProjection,
  type ToolCallStatus,
  type ToolResult,
  type ToolRiskLevel,
  type TodoItem,
  type TodoStatus,
  type TurnProjection,
  type TurnStatus,
  type McpConfigBackend,
  type McpConfigRecord,
  type McpCredentialReference,
  type ContextCompactionProjection,
  type WorktreeProjection,
  type WorktreeStatus,
  type SessionOwnership,
} from "@code-review-agent/contracts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = 4 as const;

function isPermissionPreset(value: unknown): value is PermissionPreset {
  return value === "read-only" || value === "workspace-write" || value === "ask-on-write" || value === "ask-on-execute" || value === "danger-full-access";
}

function now(): string {
  return new Date().toISOString();
}

function eventId(): string {
  return `evt_${randomUUID()}`;
}

function boundedPageLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.min(1_000, Math.max(1, Math.floor(value)));
}

function finiteSequence(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function pageEvents(events: readonly AgentEvent[], options: EventListOptions): EventPage {
  const after = finiteSequence(options.afterSequence, 0);
  const before = options.beforeSequence === undefined ? undefined : finiteSequence(options.beforeSequence, Number.MAX_SAFE_INTEGER);
  const limit = boundedPageLimit(options.limit);
  const candidates = events.filter((event) => event.sequence > after && (before === undefined || event.sequence < before));
  const latest = before === undefined && limit !== undefined && after === 0;
  const selected = limit === undefined
    ? [...candidates]
    : latest || before !== undefined
      ? candidates.slice(-limit)
      : candidates.slice(0, limit);
  const first = selected[0]?.sequence;
  const last = selected[selected.length - 1]?.sequence;
  return {
    events: selected,
    hasMoreBefore: first === undefined ? false : candidates.some((event) => event.sequence < first),
    hasMoreAfter: last === undefined ? false : candidates.some((event) => event.sequence > last),
    ...(first === undefined ? {} : { oldestSequence: first }),
    ...(last === undefined ? {} : { newestSequence: last }),
  };
}

function newSessionId(): SessionId {
  return brand<string, "SessionId">(`ses_${randomUUID()}`);
}

function isSubagentMode(value: unknown): value is SubagentMode {
  return value === "one-shot" || value === "continuable";
}

function baseProjection(id: SessionId, workspaceRoot: string, permissionPreset: PermissionPreset = "ask-on-write", timestamp = now(), metadata?: ChildSessionMetadata, ownership?: SessionOwnership): SessionProjection {
  return {
    id,
    workspaceRoot,
    permissionPreset,
    archived: false,
    deleted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    lastSequence: 0,
    messages: [],
    turns: [],
    tasks: [],
    goals: [],
    plan: { content: "", status: "cleared", updatedAt: timestamp, lastSequence: 0 },
    todos: [],
    interactions: [],
    toolCalls: [],
    permissions: [],
    ...(metadata === undefined ? {} : {
      parentSessionId: metadata.parentSessionId,
      ...(metadata.parentTaskId === undefined ? {} : { parentTaskId: metadata.parentTaskId }),
      childMode: metadata.childMode,
      childProvider: metadata.childProvider,
      delegationDepth: metadata.delegationDepth,
      ...(metadata.ownership === undefined ? {} : { ownership: metadata.ownership }),
    }),
    ...(ownership === undefined ? {} : { ownership }),
  };
}

function statusFromTurn(status: unknown): SessionStatus | undefined {
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  if (status === "interrupted") return "interrupted";
  if (status === "completed") return "idle";
  return undefined;
}

function turnStatus(value: unknown, fallback: TurnStatus): TurnStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "stopped" || value === "failed" || value === "interrupted"
    ? value
    : fallback;
}

function taskStatus(value: unknown, fallback: TaskStatus): TaskStatus {
  return value === "queued" || value === "running" || value === "waiting" || value === "completed" || value === "failed" || value === "cancelled" || value === "blocked"
    ? value
    : fallback;
}

function isTerminalTaskStatus(value: TaskStatus | undefined): boolean {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "blocked";
}

function artifactRefs(value: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ArtifactRef[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof record["kind"] !== "string" || typeof record["label"] !== "string") return [];
    const kind = record["kind"];
    if (kind !== "file" && kind !== "diff" && kind !== "log" && kind !== "url" && kind !== "json" && kind !== "other") return [];
    return [{
      id: record["id"], kind, label: record["label"],
      ...(typeof record["path"] === "string" ? { path: record["path"] } : {}),
      ...(typeof record["mediaType"] === "string" ? { mediaType: record["mediaType"] } : {}),
      ...(typeof record["sizeBytes"] === "number" ? { sizeBytes: record["sizeBytes"] } : {}),
      ...(typeof record["digest"] === "string" ? { digest: record["digest"] } : {}),
      ...(typeof record["preview"] === "string" ? { preview: record["preview"] } : {}),
    }];
  });
}

function mergeArtifactRefs(existing: readonly ArtifactRef[], incoming: readonly ArtifactRef[]): readonly ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const artifact of [...existing, ...incoming]) byId.set(artifact.id, artifact);
  return [...byId.values()];
}

function normalizeReport(value: unknown): TaskReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const report = value as Record<string, unknown>;
  if (typeof report["taskId"] !== "string" || typeof report["childSessionId"] !== "string" || typeof report["summary"] !== "string") return undefined;
  const status = report["status"];
  if (status !== "completed" && status !== "failed" && status !== "cancelled" && status !== "rejected" && status !== "partial") return undefined;
  const stopReason = report["stopReason"];
  const diagnostics = Array.isArray(report["diagnostics"]) ? report["diagnostics"] as TaskReport["diagnostics"] : undefined;
  return {
    taskId: brand<string, "TaskId">(report["taskId"]),
    childSessionId: brand<string, "SessionId">(report["childSessionId"]),
    status,
    ...(stopReason === "completed" || stopReason === "aborted" || stopReason === "error" || stopReason === "max-tokens" || stopReason === "refusal" ? { stopReason } : {}),
    summary: report["summary"],
    ...(Object.hasOwn(report, "output") ? { output: report["output"] } : {}),
    artifacts: artifactRefs(report["artifacts"]),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function goalStatus(value: unknown, fallback: GoalStatus): GoalStatus {
  return value === "active" || value === "paused" || value === "completed" || value === "blocked" || value === "cancelled" ? value : fallback;
}

function planStatus(value: unknown, fallback: PlanStatus): PlanStatus {
  return value === "draft" || value === "active" || value === "approved" || value === "rejected" || value === "cleared" ? value : fallback;
}

function todoStatus(value: unknown, fallback: TodoStatus): TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled" ? value : fallback;
}

function interactionStatus(value: unknown, fallback: InteractionStatus): InteractionStatus {
  return value === "pending" || value === "answered" || value === "cancelled" || value === "expired" ? value : fallback;
}

function worktreeStatus(value: unknown, fallback: WorktreeStatus): WorktreeStatus {
  return value === "clean" || value === "dirty" || value === "conflicted" || value === "attached" || value === "removed" || value === "failed" ? value : fallback;
}

function interactionOptions(value: unknown): readonly InteractionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): InteractionOption[] => {
    if (typeof item !== "object" || item === null) return [];
    const option = item as Record<string, unknown>;
    return typeof option["label"] === "string" && typeof option["value"] === "string" ? [{ label: option["label"], value: option["value"] }] : [];
  });
}

function toolCallStatus(value: unknown, fallback: ToolCallStatus): ToolCallStatus {
  return value === "pending" || value === "awaiting_permission" || value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "denied"
    ? value
    : fallback;
}

function permissionStatus(value: unknown, fallback: PermissionStatus): PermissionStatus {
  return value === "pending" || value === "approved" || value === "denied" || value === "cancelled" || value === "expired" ? value : fallback;
}

function deriveActiveStatus(projection: SessionProjection): SessionStatus {
  if (projection.turns.some((turn) => turn.status === "running")) return "running";
  if (projection.turns.some((turn) => turn.status === "queued")) return "queued";
  return "idle";
}

function applyEvent(projection: SessionProjection, event: AgentEvent): SessionProjection {
  let next: SessionProjection = {
    ...projection,
    plan: projection.plan ?? { content: "", status: "cleared", updatedAt: event.createdAt, lastSequence: 0 },
    todos: projection.todos ?? [],
    goals: projection.goals ?? [],
    interactions: projection.interactions ?? [],
    updatedAt: event.createdAt,
    lastSequence: event.sequence,
  };

  if (event.type === "session/created" || event.type === "session/updated" || event.type === "session/deleted") {
    const workspaceRoot = event.payload["workspaceRoot"];
    if (typeof workspaceRoot === "string") next = { ...next, workspaceRoot };
    if (typeof event.payload["activeWorkspaceRoot"] === "string") next = { ...next, activeWorkspaceRoot: event.payload["activeWorkspaceRoot"] };
    if (event.payload["activeWorkspaceRoot"] === null) {
      const { activeWorkspaceRoot: _activeWorkspaceRoot, activeWorktreeId: _activeWorktreeId, ...withoutActiveWorktree } = next;
      next = withoutActiveWorktree;
    }
    if (typeof event.payload["title"] === "string") next = { ...next, title: event.payload["title"] as string };
    const permissionPreset = event.payload["permissionPreset"];
    if (isPermissionPreset(permissionPreset)) next = { ...next, permissionPreset };
    const parentSessionId = event.payload["parentSessionId"];
    if (typeof parentSessionId === "string") next = { ...next, parentSessionId: brand<string, "SessionId">(parentSessionId) };
    const parentTaskId = event.payload["parentTaskId"];
    if (typeof parentTaskId === "string") next = { ...next, parentTaskId: brand<string, "TaskId">(parentTaskId) };
    if (isSubagentMode(event.payload["childMode"])) next = { ...next, childMode: event.payload["childMode"] };
    if (typeof event.payload["childProvider"] === "string") next = { ...next, childProvider: event.payload["childProvider"] };
    if (typeof event.payload["delegationDepth"] === "number") next = { ...next, delegationDepth: event.payload["delegationDepth"] };
    const principalId = event.payload["principalId"];
    const tenantId = event.payload["tenantId"];
    if (typeof principalId === "string" && typeof tenantId === "string") {
      next = { ...next, ownership: { principalId: brand<string, "PrincipalId">(principalId), tenantId: brand<string, "TenantId">(tenantId) } };
    }
    if (typeof event.payload["archived"] === "boolean") next = { ...next, archived: event.payload["archived"] };
    if (event.type === "session/deleted" || event.payload["deleted"] === true) next = { ...next, deleted: true };
  }

  const turnId = event.turnId;
  if (turnId !== undefined) {
    const current = next.turns.find((turn) => turn.id === turnId);
    const timestamp = event.createdAt;
    const initial: TurnProjection = current ?? {
      id: turnId,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSequence: event.sequence,
    };
    let updated: TurnProjection = { ...initial, updatedAt: timestamp, lastSequence: event.sequence };

    if (event.type === "user/message") {
      const content = event.payload["content"];
      if (typeof content === "string") updated = { ...updated, userMessage: content };
    }
    if (event.type === "turn/queued") updated = { ...updated, status: "queued" };
    if (event.type === "turn/started") {
      const { queuePosition: _queuePosition, ...withoutQueuePosition } = updated;
      updated = { ...withoutQueuePosition, status: "running", startedAt: timestamp };
    }
    if (event.type === "assistant/chunk") {
      const text = event.payload["text"];
      if (typeof text === "string") updated = { ...updated, assistantMessage: `${updated.assistantMessage ?? ""}${text}` };
    }
    if (event.type === "assistant/message") {
      const content = event.payload["content"];
      if (typeof content === "string") updated = { ...updated, assistantMessage: content };
    }
    if (event.type === "turn/ended") {
      const { queuePosition: _queuePosition, ...withoutQueuePosition } = updated;
      updated = {
        ...withoutQueuePosition,
        status: turnStatus(event.payload["status"], "completed"),
        endedAt: timestamp,
      };
    }
    if (event.type === "agent/status") {
      const status = turnStatus(event.payload["status"], updated.status);
      if (status === "stopped" || status === "interrupted") updated = { ...updated, status, endedAt: timestamp };
    }

    const turns = current === undefined ? [...next.turns, updated] : next.turns.map((turn) => (turn.id === turnId ? updated : turn));
    next = { ...next, turns };
  }

  if (event.type === "queue/changed") {
    const rawTurnIds = event.payload["queuedTurnIds"];
    const queuedTurnIds = Array.isArray(rawTurnIds) ? rawTurnIds.filter((value): value is string => typeof value === "string") : [];
    const positions = new Map(queuedTurnIds.map((id, index) => [id, index + 1] as const));
    next = {
      ...next,
      turns: next.turns.map((turn) => {
        const position = positions.get(turn.id);
        if (position === undefined) {
          const { queuePosition: _queuePosition, ...withoutQueuePosition } = turn;
          return withoutQueuePosition;
        }
        return { ...turn, status: "queued", queuePosition: position };
      }),
    };
  }

  if (event.type === "user/message" || event.type === "turn/steered") {
    const content = event.payload["content"];
    if (typeof content === "string") {
      next = {
        ...next,
        messages: [
          ...next.messages,
          {
            role: "user",
            content,
            ...(turnId === undefined ? {} : { turnId }),
          },
        ],
      };
    }
  }
  if (event.type === "assistant/message") {
    const content = event.payload["content"];
    if (typeof content === "string" && content.length > 0) {
      next = {
        ...next,
        messages: [
          ...next.messages,
          {
            role: "assistant",
            content,
            ...(turnId === undefined ? {} : { turnId }),
          },
        ],
      };
    }
  }

  if (event.type === "task/created" || event.type === "task/updated" || event.type === "task/input-required" || event.type === "task/report" || event.type === "task/artifact" || event.type === "task/ended") {
    const rawTaskId = event.payload["taskId"];
    if (typeof rawTaskId === "string") {
      const id = brand<string, "TaskId">(rawTaskId);
      const current = next.tasks.find((task) => task.id === id);
      const report = event.type === "task/report" ? normalizeReport(event.payload["report"] ?? event.payload) : undefined;
      const currentStatus = current?.status;
      const requestedStatus = event.type === "task/input-required"
        ? "waiting"
        : event.type === "task/report"
          ? report?.status === "completed" ? "completed" : report?.status === "cancelled" ? "cancelled" : report?.status === "rejected" ? "failed" : report?.status === "partial" ? "waiting" : "failed"
          : event.type === "task/ended"
            ? taskStatus(event.payload["status"], "completed")
            : event.type === "task/updated" ? taskStatus(event.payload["status"], currentStatus ?? "queued") : "queued";
      const nextStatus = currentStatus !== undefined && isTerminalTaskStatus(currentStatus) && (event.type === "task/created" || event.type === "task/updated")
        ? currentStatus
        : requestedStatus;
      const task: TaskProjection = {
        ...(current ?? {
          id,
          status: "queued" as const,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          artifacts: [],
          lastSequence: event.sequence,
        }),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
        status: nextStatus,
        ...(typeof event.payload["title"] === "string" ? { title: event.payload["title"] as string } : {}),
        ...(Object.prototype.hasOwnProperty.call(event.payload, "result") ? { result: event.payload["result"] } : {}),
        ...(typeof event.payload["parentSessionId"] === "string" ? { parentSessionId: brand<string, "SessionId">(event.payload["parentSessionId"]) } : {}),
        ...(typeof event.payload["parentTaskId"] === "string" ? { parentTaskId: brand<string, "TaskId">(event.payload["parentTaskId"]) } : {}),
        ...(typeof event.payload["childSessionId"] === "string" ? { childSessionId: brand<string, "SessionId">(event.payload["childSessionId"]) } : {}),
        ...(isSubagentMode(event.payload["mode"]) ? { mode: event.payload["mode"] } : {}),
        ...(typeof event.payload["provider"] === "string" ? { provider: event.payload["provider"] } : {}),
        ...(typeof event.payload["workspaceRoot"] === "string" ? { workspaceRoot: event.payload["workspaceRoot"] } : {}),
        ...(isPermissionPreset(event.payload["permissionPreset"]) ? { permissionPreset: event.payload["permissionPreset"] } : {}),
        ...(typeof event.payload["delegationDepth"] === "number" ? { delegationDepth: event.payload["delegationDepth"] } : {}),
        ...(typeof event.payload["budget"] === "object" && event.payload["budget"] !== null ? { budget: event.payload["budget"] as TaskBudget } : {}),
        ...(report === undefined ? {} : { report, result: report.output, artifacts: mergeArtifactRefs(current?.artifacts ?? [], report.artifacts) }),
        ...(typeof event.payload["terminalReason"] === "string" ? { terminalReason: event.payload["terminalReason"] } : {}),
        ...(Array.isArray(event.payload["diagnostics"]) ? { diagnostics: event.payload["diagnostics"] as readonly ToolError[] } : {}),
        ...(event.type === "task/artifact" ? { artifacts: mergeArtifactRefs(current?.artifacts ?? [], artifactRefs([event.payload["artifact"] ?? event.payload])) } : {}),
      };
      next = {
        ...next,
        tasks: current === undefined ? [...next.tasks, task] : next.tasks.map((item) => (item.id === id ? task : item)),
      };
    }
  }

  if (event.type === "goal/created" || event.type === "goal/updated" || event.type === "goal/ended") {
    const rawGoalId = event.payload["goalId"];
    if (typeof rawGoalId === "string") {
      const id = brand<string, "GoalId">(rawGoalId);
      const current = next.goals.find((goal) => goal.id === id);
      const rawCriteria = event.payload["successCriteria"];
      const successCriteria = Array.isArray(rawCriteria)
        ? rawCriteria.filter((item): item is string => typeof item === "string")
        : current?.successCriteria ?? [];
      const goal: GoalProjection = {
        ...(current ?? {
          id,
          title: typeof event.payload["title"] === "string" ? event.payload["title"] : "",
          status: "active" as const,
          successCriteria,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          lastSequence: event.sequence,
        }),
        ...(typeof event.payload["title"] === "string" ? { title: event.payload["title"] } : {}),
        status: goalStatus(event.payload["status"], current?.status ?? "active"),
        successCriteria,
        ...(event.payload["budget"] !== undefined ? { budget: event.payload["budget"] as Readonly<Record<string, unknown>> } : {}),
        ...(Object.prototype.hasOwnProperty.call(event.payload, "result") ? { result: event.payload["result"] } : {}),
        ...(typeof event.payload["reason"] === "string" ? { reason: event.payload["reason"] } : {}),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
      next = { ...next, goals: current === undefined ? [...next.goals, goal] : next.goals.map((item) => item.id === id ? goal : item) };
    }
  }

  if (event.type === "plan/updated") {
    const content = typeof event.payload["content"] === "string" ? event.payload["content"] : next.plan.content;
    const status = planStatus(event.payload["status"], next.plan.status);
    next = { ...next, plan: { content, status, updatedAt: event.createdAt, lastSequence: event.sequence } };
  }

  if (event.type === "todo/updated") {
    const rawTodos = event.payload["todos"];
    if (Array.isArray(rawTodos)) {
      const todos: TodoItem[] = rawTodos.flatMap((item): TodoItem[] => {
        if (typeof item !== "object" || item === null) return [];
        const value = item as Record<string, unknown>;
        if (typeof value["id"] !== "string" || typeof value["content"] !== "string") return [];
        const status = todoStatus(value["status"], "pending");
        return [{ id: value["id"], content: value["content"], status, ...(typeof value["activeForm"] === "string" ? { activeForm: value["activeForm"] } : {}) }];
      });
      next = { ...next, todos };
    }
  }

  if (event.type === "context/compacted" || event.type === "context/compaction_failed") {
    const payload = event.payload;
    const summary = typeof payload["summary"] === "string" ? payload["summary"] : "";
    const projection: ContextCompactionProjection = {
      status: event.type === "context/compacted" ? "completed" : "failed",
      sourceSequence: typeof payload["sourceSequence"] === "number" ? payload["sourceSequence"] : Math.max(0, event.sequence - 1),
      summary,
      originalMessageCount: typeof payload["originalMessageCount"] === "number" ? payload["originalMessageCount"] : 0,
      compactedMessageCount: typeof payload["compactedMessageCount"] === "number" ? payload["compactedMessageCount"] : 0,
      estimatedTokens: typeof payload["estimatedTokens"] === "number" ? payload["estimatedTokens"] : 0,
      droppedMessages: typeof payload["droppedMessages"] === "number" ? payload["droppedMessages"] : 0,
      ...(typeof payload["protectedMessageCount"] === "number" ? { protectedMessageCount: payload["protectedMessageCount"] } : {}),
      ...(typeof payload["truncatedToolResults"] === "number" ? { truncatedToolResults: payload["truncatedToolResults"] } : {}),
      updatedAt: event.createdAt,
      lastSequence: event.sequence,
      ...(typeof payload["error"] === "string" ? { error: payload["error"] } : {}),
    };
    next = { ...next, contextCompaction: projection };
  }

  if (event.type === "worktree/created" || event.type === "worktree/attached" || event.type === "worktree/switched" || event.type === "worktree/cleaned" || event.type === "worktree/failed") {
    const rawId = event.payload["id"];
    const rawPath = event.payload["path"];
    const rawRepoRoot = event.payload["repoRoot"];
    if (typeof rawId === "string" && typeof rawPath === "string" && typeof rawRepoRoot === "string") {
      const current = (next.worktrees ?? []).find((item) => item.id === rawId);
      const worktree: WorktreeProjection = {
        ...(current ?? { id: rawId, repoRoot: rawRepoRoot, path: rawPath, status: "clean" as const, createdAt: event.createdAt, updatedAt: event.createdAt, lastSequence: event.sequence }),
        repoRoot: rawRepoRoot,
        path: rawPath,
        status: worktreeStatus(event.payload["status"], event.type === "worktree/cleaned" ? "removed" : current?.status ?? "clean"),
        ...(typeof event.payload["branch"] === "string" ? { branch: event.payload["branch"] } : {}),
        ...(typeof event.payload["commit"] === "string" ? { commit: event.payload["commit"] } : {}),
        ...(typeof event.payload["sessionId"] === "string" ? { sessionId: brand<string, "SessionId">(event.payload["sessionId"]) } : {}),
        ...(typeof event.payload["taskId"] === "string" ? { taskId: brand<string, "TaskId">(event.payload["taskId"]) } : {}),
        ...(typeof event.payload["error"] === "string" ? { error: event.payload["error"] } : {}),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
      next = { ...next, worktrees: current === undefined ? [...(next.worktrees ?? []), worktree] : (next.worktrees ?? []).map((item) => item.id === rawId ? worktree : item) };
      if (event.type === "worktree/switched") next = { ...next, activeWorktreeId: rawId, activeWorkspaceRoot: rawPath };
      if (event.type === "worktree/cleaned" && next.activeWorktreeId === rawId) {
        const { activeWorktreeId: _activeWorktreeId, activeWorkspaceRoot: _activeWorkspaceRoot, ...withoutActiveWorktree } = next;
        next = withoutActiveWorktree;
      }
    }
  }

  if (event.type === "tool/call" || event.type === "tool/progress" || event.type === "tool/result") {
    const rawToolCallId = event.payload["toolCallId"];
    if (typeof rawToolCallId === "string") {
      const id = brand<string, "ToolCallId">(rawToolCallId);
      const current = next.toolCalls.find((toolCall) => toolCall.id === id);
      const input = event.payload["input"];
      const initial: ToolCallProjection = current ?? {
        id,
        name: typeof event.payload["name"] === "string" ? event.payload["name"] : "unknown",
        status: "pending",
        riskLevel: (event.payload["riskLevel"] as ToolRiskLevel | undefined) ?? "read",
        approvalMode: (event.payload["approvalMode"] as ToolApprovalMode | undefined) ?? "auto",
        ...(event.payload["caller"] === "agent" || event.payload["caller"] === "user" || event.payload["caller"] === "system" ? { caller: event.payload["caller"] } : {}),
        ...(typeof event.payload["workspaceRoot"] === "string" ? { workspaceRoot: event.payload["workspaceRoot"] } : {}),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(input === undefined ? {} : { input }),
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
      const rawResult = event.payload["result"];
      const result = rawResult !== undefined ? rawResult as ToolResult : undefined;
      const status = event.type === "tool/call"
        ? "pending"
        : event.type === "tool/progress"
          ? "running"
          : toolCallStatus(event.payload["status"], result?.ok === true ? "completed" : "failed");
      const updated: ToolCallProjection = {
        ...initial,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
        status,
        ...(result === undefined ? {} : { result }),
        ...(event.turnId === undefined || initial.turnId !== undefined ? {} : { turnId: event.turnId }),
      };
      next = {
        ...next,
        toolCalls: current === undefined ? [...next.toolCalls, updated] : next.toolCalls.map((item) => (item.id === id ? updated : item)),
      };
    }
  }

  if (event.type === "permission/requested" || event.type === "permission/resolved") {
    const rawPermissionId = event.payload["permissionId"];
    const rawToolCallId = event.payload["toolCallId"];
    if (typeof rawPermissionId === "string" && typeof rawToolCallId === "string") {
      const id = brand<string, "PermissionId">(rawPermissionId);
      const current = next.permissions.find((permission) => permission.id === id);
      const initial: PermissionProjection = current ?? {
        id,
        toolCallId: brand<string, "ToolCallId">(rawToolCallId),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        toolName: typeof event.payload["toolName"] === "string" ? event.payload["toolName"] : "unknown",
        status: "pending",
        riskLevel: (event.payload["riskLevel"] as ToolRiskLevel | undefined) ?? "write",
        reason: typeof event.payload["reason"] === "string" ? event.payload["reason"] : "Tool approval required",
        ...(event.payload["caller"] === "agent" || event.payload["caller"] === "user" || event.payload["caller"] === "system" ? { caller: event.payload["caller"] } : {}),
        ...(typeof event.payload["workspaceRoot"] === "string" ? { workspaceRoot: event.payload["workspaceRoot"] } : {}),
        ...(typeof event.payload["expiresAt"] === "string" ? { expiresAt: event.payload["expiresAt"] } : {}),
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
      const updated: PermissionProjection = {
        ...initial,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
        status: event.type === "permission/requested" ? "pending" : permissionStatus(event.payload["status"], "cancelled"),
      };
      next = {
        ...next,
        permissions: current === undefined ? [...next.permissions, updated] : next.permissions.map((item) => (item.id === id ? updated : item)),
      };
      const toolCall = next.toolCalls.find((item) => item.id === updated.toolCallId);
      if (toolCall !== undefined && event.type === "permission/requested") {
        next = { ...next, toolCalls: next.toolCalls.map((item) => (item.id === toolCall.id ? { ...item, status: "awaiting_permission", updatedAt: event.createdAt, lastSequence: event.sequence } : item)) };
      }
    }
  }

  if (event.type === "interaction/requested" || event.type === "interaction/resolved") {
    const rawInteractionId = event.payload["interactionId"];
    const rawToolCallId = event.payload["toolCallId"];
    const question = event.payload["question"];
    if (typeof rawInteractionId === "string" && typeof rawToolCallId === "string" && typeof question === "string") {
      const options = interactionOptions(event.payload["options"]);
      const current = next.interactions.find((interaction) => interaction.id === rawInteractionId);
      const initial: InteractionProjection = current ?? {
        id: brand<string, "InteractionId">(rawInteractionId),
        toolCallId: brand<string, "ToolCallId">(rawToolCallId),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        question,
        options,
        allowFreeform: event.payload["allowFreeform"] !== false,
        status: "pending",
        createdAt: typeof event.payload["createdAt"] === "string" ? event.payload["createdAt"] : event.createdAt,
        updatedAt: event.createdAt,
        expiresAt: typeof event.payload["expiresAt"] === "string" ? event.payload["expiresAt"] : new Date(Date.parse(event.createdAt) + 15 * 60_000).toISOString(),
        lastSequence: event.sequence,
      };
      const status = event.type === "interaction/requested" ? "pending" : interactionStatus(event.payload["status"], "cancelled");
      const updated: InteractionProjection = {
        ...initial,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
        status,
        ...(typeof event.payload["answer"] === "string" ? { answer: event.payload["answer"] } : {}),
      };
      next = { ...next, interactions: current === undefined ? [...next.interactions, updated] : next.interactions.map((item) => (item.id === updated.id ? updated : item)) };
    }
  }

  if (event.type === "turn/started") {
    next = { ...next, status: "running" };
  } else if (event.type === "turn/queued") {
    next = { ...next, status: next.status === "running" ? "running" : "queued" };
  } else if (event.type === "turn/ended") {
    const terminal = statusFromTurn(event.payload["status"]);
    next = { ...next, status: terminal === "idle" ? deriveActiveStatus(next) : terminal ?? deriveActiveStatus(next) };
  } else if (event.type === "agent/error") {
    next = { ...next, status: "failed" };
  } else if (event.type === "agent/status") {
    const status = event.payload["status"];
    if (status === "stopped" || status === "interrupted" || status === "failed" || status === "idle" || status === "running" || status === "queued") {
      next = { ...next, status };
    }
    if (status === "interrupted" || status === "stopped") {
      next = {
        ...next,
        turns: next.turns.map((turn) => (turn.status === "running" ? { ...turn, status, endedAt: event.createdAt, updatedAt: event.createdAt, lastSequence: event.sequence } : turn)),
      };
    }
  }

  return next;
}

/** Rebuilds the read model from an ordered event fixture. */
export function replayProjection(initial: SessionProjection, events: readonly AgentEvent[]): SessionProjection {
  return events.reduce(applyEvent, initial);
}

interface MemorySession {
  events: AgentEvent[];
  listeners: Set<EventListener>;
  projection: SessionProjection;
  commands: Map<string, CommandRecord>;
}

interface CreateSessionArgs {
  readonly id: SessionId;
  readonly metadata?: ChildSessionMetadata;
}

function resolveCreateSessionArgs(idOrMetadata?: SessionId | ChildSessionMetadata, metadata?: ChildSessionMetadata): CreateSessionArgs {
  if (typeof idOrMetadata === "string") return { id: idOrMetadata as SessionId, ...(metadata === undefined ? {} : { metadata }) };
  return { id: newSessionId(), ...(idOrMetadata === undefined ? {} : { metadata: idOrMetadata }) };
}

function metadataPayload(metadata: ChildSessionMetadata): Record<string, unknown> {
  return {
    parentSessionId: metadata.parentSessionId,
    ...(metadata.parentTaskId === undefined ? {} : { parentTaskId: metadata.parentTaskId }),
    childMode: metadata.childMode,
    childProvider: metadata.childProvider,
    delegationDepth: metadata.delegationDepth,
    ...(metadata.descriptor === undefined ? {} : { descriptor: metadata.descriptor }),
    ...(metadata.ownership === undefined ? {} : { principalId: metadata.ownership.principalId, tenantId: metadata.ownership.tenantId }),
  };
}

function readChildMetadata(row: SqliteRow): ChildSessionMetadata | undefined {
  const parentSessionId = row["parent_session_id"];
  const childMode = row["child_mode"];
  const childProvider = row["child_provider"];
  const delegationDepth = row["delegation_depth"];
  if (typeof parentSessionId !== "string" || !isSubagentMode(childMode) || typeof childProvider !== "string" || typeof delegationDepth !== "number") return undefined;
  const rawParentTaskId = row["parent_task_id"];
  const rawDescriptor = row["descriptor_json"];
  let descriptor: ChildSessionMetadata["descriptor"];
  if (typeof rawDescriptor === "string") {
    try { descriptor = JSON.parse(rawDescriptor) as ChildSessionMetadata["descriptor"]; } catch { descriptor = undefined; }
  }
  return {
    parentSessionId: brand<string, "SessionId">(parentSessionId),
    ...(typeof rawParentTaskId === "string" ? { parentTaskId: brand<string, "TaskId">(rawParentTaskId) } : {}),
    childMode,
    childProvider,
    delegationDepth,
    ...(descriptor === undefined ? {} : { descriptor }),
  };
}

/** Deterministic in-memory store retained for unit tests and local fixtures. */
export class InMemoryEventStore implements SessionEventStore {
  private readonly sessions = new Map<SessionId, MemorySession>();

  async createSession(workspaceRoot: string, permissionPreset: PermissionPreset = "ask-on-write", idOrMetadata?: SessionId | ChildSessionMetadata, metadata?: ChildSessionMetadata, ownership?: SessionOwnership): Promise<SessionId> {
    const args = resolveCreateSessionArgs(idOrMetadata, metadata);
    const id = args.id;
    if (this.sessions.has(id)) throw new Error(`Session already exists: ${id}`);
    const effectiveOwnership = ownership ?? args.metadata?.ownership;
    const projection = baseProjection(id, workspaceRoot, permissionPreset, now(), args.metadata, effectiveOwnership);
    this.sessions.set(id, { events: [], listeners: new Set(), projection, commands: new Map() });
    await this.append({ sessionId: id, type: "session/created", payload: { workspaceRoot, permissionPreset, ...(args.metadata === undefined ? {} : metadataPayload(args.metadata)), ...(effectiveOwnership === undefined ? {} : { principalId: effectiveOwnership.principalId, tenantId: effectiveOwnership.tenantId }) } });
    return id;
  }

  async createChildSession(input: { readonly id?: SessionId; readonly workspaceRoot: string; readonly permissionPreset: PermissionPreset; readonly metadata: ChildSessionMetadata; readonly ownership?: SessionOwnership }): Promise<SessionId> {
    return this.createSession(input.workspaceRoot, input.permissionPreset, input.id ?? input.metadata, input.id === undefined ? undefined : input.metadata, input.ownership ?? input.metadata.ownership);
  }

  async append(input: AppendEventInput): Promise<AgentEvent> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
    const event: AgentEvent = {
      eventId: eventId(),
      sequence: session.events.length + 1,
      schemaVersion: 1,
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      type: input.type,
      createdAt: now(),
      payload: input.payload,
    };
    session.events.push(event);
    session.projection = applyEvent(session.projection, event);
    for (const listener of session.listeners) listener(event);
    return event;
  }

  async list(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    return this.sessions.get(sessionId)?.events.filter((event) => event.sequence > afterSequence) ?? [];
  }

  async listPage(sessionId: SessionId, options: EventListOptions = {}): Promise<EventPage> {
    const events = this.sessions.get(sessionId)?.events ?? [];
    return pageEvents(events, options);
  }

  async listSessions(includeArchived = false): Promise<readonly SessionSummary[]> {
    return [...this.sessions.values()]
      .map((session) => toSummary(session.projection))
      .filter((session) => !session.deleted && (includeArchived || !session.archived));
  }

  async listTasks(sessionId?: SessionId): Promise<readonly TaskProjection[]> {
    const sessions = sessionId === undefined ? [...this.sessions.values()] : [this.sessions.get(sessionId)].filter((value): value is MemorySession => value !== undefined);
    return sessions.flatMap((session) => session.projection.tasks);
  }

  async listChildSessions(parentSessionId: SessionId): Promise<readonly SessionSummary[]> {
    return [...this.sessions.values()]
      .map((session) => toSummary(session.projection))
      .filter((summary) => summary.parentSessionId === parentSessionId && !summary.deleted);
  }

  async project(sessionId: SessionId): Promise<SessionProjection | undefined> {
    return this.sessions.get(sessionId)?.projection;
  }

  subscribe(sessionId: SessionId, listener: EventListener): () => void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return () => undefined;
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  async claimCommand(input: ClaimCommandInput): Promise<CommandClaim> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
    const existing = session.commands.get(input.commandId);
    if (existing !== undefined) {
      assertSameCommand(existing, input);
      return { created: false, record: existing };
    }
    const record: CommandRecord = {
      sessionId: input.sessionId,
      commandId: input.commandId,
      kind: input.kind,
      request: input.request,
      result: input.result,
      createdAt: now(),
    };
    session.commands.set(input.commandId, record);
    return { created: true, record };
  }

  async getCommand(sessionId: SessionId, commandId: string): Promise<CommandRecord | undefined> {
    return this.sessions.get(sessionId)?.commands.get(commandId);
  }

  async forkSession(sessionId: SessionId, workspaceRoot?: string, id?: SessionId, permissionPreset?: PermissionPreset): Promise<SessionId> {
    const source = await this.project(sessionId);
    if (source === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const forked = await this.createSession(workspaceRoot ?? source.workspaceRoot, permissionPreset ?? source.permissionPreset, id, undefined, source.ownership);
    for (const message of source.messages) {
      await this.append({
        sessionId: forked,
        ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        type: message.role === "user" ? "user/message" : "assistant/message",
        payload: { content: message.content, forkedFrom: sessionId },
      });
    }
    for (const turn of source.turns.filter((item) => item.status === "completed")) {
      await this.append({ sessionId: forked, turnId: turn.id, type: "turn/ended", payload: { status: "completed", forkedFrom: sessionId } });
    }
    return forked;
  }
}

interface SqliteRow {
  [key: string]: unknown;
}

export interface SqliteEventStoreOptions {
  readonly databasePath?: string;
}

/** Durable EventStore using the Node.js built-in SQLite driver. */
export class SqliteEventStore implements SessionEventStore, McpConfigBackend {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly listeners = new Map<SessionId, Set<EventListener>>();

  constructor(options: SqliteEventStoreOptions | string = {}) {
    const configured = typeof options === "string" ? options : options.databasePath;
    this.databasePath = configured ?? defaultDatabasePath();
    if (this.databasePath !== ":memory:" && !this.databasePath.startsWith("file:")) {
      mkdirSync(dirname(resolve(this.databasePath)), { recursive: true });
    }
    this.db = new DatabaseSync(this.databasePath);
    this.migrate();
    this.rebuildProjections();
    this.recoverInterruptedSessions();
  }

  close(): void {
    this.db.close();
  }

  async createSession(workspaceRoot: string, permissionPreset: PermissionPreset = "ask-on-write", idOrMetadata?: SessionId | ChildSessionMetadata, metadata?: ChildSessionMetadata, ownership?: SessionOwnership): Promise<SessionId> {
    const args = resolveCreateSessionArgs(idOrMetadata, metadata);
    const id = args.id;
    const effectiveOwnership = ownership ?? args.metadata?.ownership;
    const projection = baseProjection(id, workspaceRoot, permissionPreset, now(), args.metadata, effectiveOwnership);
    this.withTransaction(() => {
      const child = args.metadata;
      this.db.prepare("INSERT INTO sessions (id, workspace_root, parent_session_id, parent_task_id, child_mode, child_provider, delegation_depth, descriptor_json, created_at, updated_at, status, last_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, workspaceRoot, child?.parentSessionId ?? null, child?.parentTaskId ?? null, child?.childMode ?? null, child?.childProvider ?? null, child?.delegationDepth ?? null, child?.descriptor === undefined ? null : JSON.stringify(child.descriptor), projection.createdAt, projection.updatedAt, projection.status, 0);
      this.db.prepare("INSERT INTO projections (session_id, schema_version, projection_json) VALUES (?, ?, ?)").run(id, SCHEMA_VERSION, JSON.stringify(projection));
      this.appendSync({ sessionId: id, type: "session/created", payload: { workspaceRoot, permissionPreset, ...(child === undefined ? {} : metadataPayload(child)), ...(effectiveOwnership === undefined ? {} : { principalId: effectiveOwnership.principalId, tenantId: effectiveOwnership.tenantId }) } });
    });
    return id;
  }

  async createChildSession(input: { readonly id?: SessionId; readonly workspaceRoot: string; readonly permissionPreset: PermissionPreset; readonly metadata: ChildSessionMetadata; readonly ownership?: SessionOwnership }): Promise<SessionId> {
    return this.createSession(input.workspaceRoot, input.permissionPreset, input.id ?? input.metadata, input.id === undefined ? undefined : input.metadata, input.ownership ?? input.metadata.ownership);
  }

  async append(input: AppendEventInput): Promise<AgentEvent> {
    const event = this.withTransaction(() => this.appendSync(input));
    for (const listener of this.listeners.get(input.sessionId) ?? []) listener(event);
    return event;
  }

  async list(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    const rows = this.db.prepare("SELECT event_id, sequence, session_id, turn_id, correlation_id, type, created_at, payload_json, schema_version FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC").all(sessionId, afterSequence) as SqliteRow[];
    return rows.map(readEvent);
  }

  async listPage(sessionId: SessionId, options: EventListOptions = {}): Promise<EventPage> {
    const after = finiteSequence(options.afterSequence, 0);
    const before = options.beforeSequence === undefined ? undefined : finiteSequence(options.beforeSequence, Number.MAX_SAFE_INTEGER);
    const limit = boundedPageLimit(options.limit);
    const latest = before === undefined && limit !== undefined && after === 0;
    const order = latest || before !== undefined ? "DESC" : "ASC";
    const upperClause = before === undefined ? "" : " AND sequence < ?";
    const params: (string | number)[] = [sessionId, after];
    if (before !== undefined) params.push(before);
    const rows = this.db.prepare(`SELECT event_id, sequence, session_id, turn_id, correlation_id, type, created_at, payload_json, schema_version FROM events WHERE session_id = ? AND sequence > ?${upperClause} ORDER BY sequence ${order}${limit === undefined ? "" : " LIMIT ?"}`).all(...params, ...(limit === undefined ? [] : [limit + 1])) as SqliteRow[];
    const overflow = limit !== undefined && rows.length > limit;
    const selected = (overflow ? rows.slice(0, limit) : rows).map(readEvent);
    if (order === "DESC") selected.reverse();
    const first = selected[0]?.sequence;
    const last = selected[selected.length - 1]?.sequence;
    const hasMoreBefore = first === undefined ? false : (this.db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND sequence > ?${before === undefined ? "" : " AND sequence < ?"} AND sequence < ? LIMIT 1`).get(...params.slice(0, before === undefined ? 2 : 3), first) as SqliteRow | undefined) !== undefined;
    const hasMoreAfter = last === undefined ? false : order === "ASC" && overflow
      ? true
      : (this.db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND sequence > ?${before === undefined ? "" : " AND sequence < ?"} AND sequence > ? LIMIT 1`).get(...params.slice(0, before === undefined ? 2 : 3), last) as SqliteRow | undefined) !== undefined;
    return {
      events: selected,
      hasMoreBefore,
      hasMoreAfter,
      ...(first === undefined ? {} : { oldestSequence: first }),
      ...(last === undefined ? {} : { newestSequence: last }),
    };
  }

  async listSessions(includeArchived = false): Promise<readonly SessionSummary[]> {
    const rows = this.db.prepare("SELECT s.id, s.workspace_root, s.created_at, s.updated_at, s.status, s.last_sequence, p.projection_json FROM sessions s JOIN projections p ON p.session_id = s.id ORDER BY s.updated_at DESC").all() as SqliteRow[];
    return rows.map(readSummary).filter((session) => !session.deleted && (includeArchived || !session.archived));
  }

  async listTasks(sessionId?: SessionId): Promise<readonly TaskProjection[]> {
    const rows = sessionId === undefined
      ? this.db.prepare("SELECT projection_json FROM projections ORDER BY session_id ASC").all()
      : this.db.prepare("SELECT projection_json FROM projections WHERE session_id = ?").all(sessionId);
    return (rows as SqliteRow[]).flatMap((row) => {
      const projection = JSON.parse(String(row["projection_json"])) as SessionProjection;
      return projection.tasks ?? [];
    });
  }

  async listChildSessions(parentSessionId: SessionId): Promise<readonly SessionSummary[]> {
    const rows = this.db.prepare("SELECT s.id, s.workspace_root, s.created_at, s.updated_at, s.status, s.last_sequence, p.projection_json FROM sessions s JOIN projections p ON p.session_id = s.id WHERE s.parent_session_id = ? ORDER BY s.created_at ASC").all(parentSessionId) as SqliteRow[];
    return rows.map(readSummary).filter((session) => !session.deleted);
  }

  async project(sessionId: SessionId): Promise<SessionProjection | undefined> {
    const row = this.db.prepare("SELECT projection_json FROM projections WHERE session_id = ?").get(sessionId) as SqliteRow | undefined;
    return row === undefined ? undefined : JSON.parse(String(row["projection_json"])) as SessionProjection;
  }

  subscribe(sessionId: SessionId, listener: EventListener): () => void {
    let listeners = this.listeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  async claimCommand(input: ClaimCommandInput): Promise<CommandClaim> {
    return this.withTransaction(() => {
      const session = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(input.sessionId) as SqliteRow | undefined;
      if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
      const existing = this.db.prepare("SELECT session_id, command_id, kind, request_json, result_json, created_at FROM commands WHERE session_id = ? AND command_id = ?").get(input.sessionId, input.commandId) as SqliteRow | undefined;
      if (existing !== undefined) {
        const record = readCommand(existing);
        assertSameCommand(record, input);
        return { created: false, record };
      }
      const record: CommandRecord = {
        sessionId: input.sessionId,
        commandId: input.commandId,
        kind: input.kind,
        request: input.request,
        result: input.result,
        createdAt: now(),
      };
      this.db.prepare("INSERT INTO commands (session_id, command_id, kind, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(input.sessionId, input.commandId, input.kind, JSON.stringify(input.request), JSON.stringify(input.result), record.createdAt);
      return { created: true, record };
    });
  }

  async getCommand(sessionId: SessionId, commandId: string): Promise<CommandRecord | undefined> {
    const row = this.db.prepare("SELECT session_id, command_id, kind, request_json, result_json, created_at FROM commands WHERE session_id = ? AND command_id = ?").get(sessionId, commandId) as SqliteRow | undefined;
    return row === undefined ? undefined : readCommand(row);
  }

  async forkSession(sessionId: SessionId, workspaceRoot?: string, id?: SessionId, permissionPreset?: PermissionPreset): Promise<SessionId> {
    const source = await this.project(sessionId);
    if (source === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const forked = await this.createSession(workspaceRoot ?? source.workspaceRoot, permissionPreset ?? source.permissionPreset, id, undefined, source.ownership);
    for (const message of source.messages) {
      await this.append({
        sessionId: forked,
        ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        type: message.role === "user" ? "user/message" : "assistant/message",
        payload: { content: message.content, forkedFrom: sessionId },
      });
    }
    for (const turn of source.turns.filter((item) => item.status === "completed")) {
      await this.append({ sessionId: forked, turnId: turn.id, type: "turn/ended", payload: { status: "completed", forkedFrom: sessionId } });
    }
    return forked;
  }

  listMcpConfigs(): readonly McpConfigRecord[] {
    const rows = this.db.prepare("SELECT name, scope, tenant_id, owner_id, workspace_root, session_id, enabled, revision, credential_ref_json, config_json, created_at, updated_at FROM mcp_server_configs ORDER BY name ASC").all() as SqliteRow[];
    return rows.map(readMcpConfig);
  }

  upsertMcpConfig(record: McpConfigRecord): McpConfigRecord {
    this.withTransaction(() => {
      this.db.prepare(`
        INSERT INTO mcp_server_configs (name, scope, tenant_id, owner_id, workspace_root, session_id, enabled, revision, credential_ref_json, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          scope = excluded.scope,
          tenant_id = excluded.tenant_id,
          owner_id = excluded.owner_id,
          workspace_root = excluded.workspace_root,
          session_id = excluded.session_id,
          enabled = excluded.enabled,
          revision = excluded.revision,
          credential_ref_json = excluded.credential_ref_json,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `).run(
        record.name,
        record.scope,
        record.tenantId ?? null,
        record.ownerId ?? null,
        record.workspaceRoot ?? null,
        record.sessionId ?? null,
        record.enabled ? 1 : 0,
        record.revision,
        record.credentialRef === undefined ? null : JSON.stringify(record.credentialRef),
        JSON.stringify(record.config),
        record.createdAt,
        record.updatedAt,
      );
    });
    return record;
  }

  deleteMcpConfig(name: string): boolean {
    const result = this.db.prepare("DELETE FROM mcp_server_configs WHERE name = ?").run(name) as { changes?: number };
    return Number(result.changes ?? 0) > 0;
  }

  private appendSync(input: AppendEventInput): AgentEvent {
    const session = this.db.prepare("SELECT id, workspace_root, created_at, updated_at, status, last_sequence FROM sessions WHERE id = ?").get(input.sessionId) as SqliteRow | undefined;
    if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
    const currentProjection = this.db.prepare("SELECT projection_json FROM projections WHERE session_id = ?").get(input.sessionId) as SqliteRow | undefined;
    if (currentProjection === undefined) throw new Error(`Projection missing for session: ${input.sessionId}`);
    const sequence = Number(session["last_sequence"]) + 1;
    const event: AgentEvent = {
      eventId: eventId(),
      sequence,
      schemaVersion: 1,
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      type: input.type,
      createdAt: now(),
      payload: input.payload,
    };
    const projection = applyEvent(JSON.parse(String(currentProjection["projection_json"])) as SessionProjection, event);
    this.db.prepare("INSERT INTO events (event_id, session_id, sequence, turn_id, correlation_id, type, created_at, payload_json, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(event.eventId, event.sessionId, event.sequence, event.turnId ?? null, event.correlationId ?? null, event.type, event.createdAt, JSON.stringify(event.payload), event.schemaVersion);
    this.db.prepare("UPDATE sessions SET updated_at = ?, status = ?, last_sequence = ? WHERE id = ?").run(projection.updatedAt, projection.status, projection.lastSequence, input.sessionId);
    this.db.prepare("UPDATE projections SET schema_version = ?, projection_json = ? WHERE session_id = ?").run(SCHEMA_VERSION, JSON.stringify(projection), input.sessionId);
    return event;
  }

  private withTransaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    const current = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as SqliteRow;
    const currentVersion = Number(current["version"]);
    if (currentVersion >= SCHEMA_VERSION) return;
    this.withTransaction(() => {
      if (currentVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          status TEXT NOT NULL,
          last_sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          turn_id TEXT,
          correlation_id TEXT,
          type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          UNIQUE(session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS events_session_sequence_idx ON events(session_id, sequence);
        CREATE TABLE IF NOT EXISTS projections (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          schema_version INTEGER NOT NULL,
          projection_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS commands (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          command_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          request_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(session_id, command_id)
        );
      `);
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, now());
      }
      if (currentVersion < 2) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mcp_server_configs (
            name TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            owner_id TEXT,
            workspace_root TEXT,
            session_id TEXT,
            enabled INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            credential_ref_json TEXT,
            config_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS mcp_server_configs_scope_idx ON mcp_server_configs(scope, owner_id, workspace_root, session_id);
        `);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, now());
      }
      if (currentVersion < 3) {
        this.db.exec(`
          ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
          ALTER TABLE sessions ADD COLUMN parent_task_id TEXT;
          ALTER TABLE sessions ADD COLUMN child_mode TEXT;
          ALTER TABLE sessions ADD COLUMN child_provider TEXT;
          ALTER TABLE sessions ADD COLUMN delegation_depth INTEGER;
          ALTER TABLE sessions ADD COLUMN descriptor_json TEXT;
          CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions(parent_session_id, created_at);
        `);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, now());
      }
      if (currentVersion < 4) {
        this.db.exec("ALTER TABLE mcp_server_configs ADD COLUMN tenant_id TEXT; CREATE INDEX IF NOT EXISTS mcp_server_configs_tenant_idx ON mcp_server_configs(tenant_id, name);");
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, now());
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private recoverInterruptedSessions(): void {
    const rows = this.db.prepare("SELECT id FROM sessions WHERE status = 'running'").all() as SqliteRow[];
    for (const row of rows) {
      const id = brand<string, "SessionId">(String(row["id"]));
      this.withTransaction(() => {
        this.appendSync({
          sessionId: id,
          type: "agent/status",
          payload: { status: "interrupted", reason: "process_restart" },
        });
      });
    }
  }

  private rebuildProjections(): void {
    const rows = this.db.prepare("SELECT id, workspace_root, parent_session_id, parent_task_id, child_mode, child_provider, delegation_depth, descriptor_json, created_at FROM sessions ORDER BY created_at ASC").all() as SqliteRow[];
    this.withTransaction(() => {
      for (const row of rows) {
        const id = brand<string, "SessionId">(String(row["id"]));
        const metadata = readChildMetadata(row);
        const initial = baseProjection(id, String(row["workspace_root"]), "ask-on-write", String(row["created_at"]), metadata);
        const events = (this.db.prepare("SELECT event_id, sequence, session_id, turn_id, correlation_id, type, created_at, payload_json, schema_version FROM events WHERE session_id = ? ORDER BY sequence ASC").all(id) as SqliteRow[]).map(readEvent);
        const projection = replayProjection(initial, events);
        this.db.prepare("INSERT INTO projections (session_id, schema_version, projection_json) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET schema_version = excluded.schema_version, projection_json = excluded.projection_json").run(id, SCHEMA_VERSION, JSON.stringify(projection));
        this.db.prepare("UPDATE sessions SET updated_at = ?, status = ?, last_sequence = ? WHERE id = ?").run(projection.updatedAt, projection.status, projection.lastSequence, id);
      }
    });
  }
}

function toSummary(projection: SessionProjection): SessionSummary {
  const { id, workspaceRoot, permissionPreset, archived, deleted, createdAt, updatedAt, status, lastSequence } = projection;
  const firstUserMessage = projection.messages.find((message) => message.role === "user")?.content.trim();
  const derivedTitle = firstUserMessage === undefined || firstUserMessage.length === 0
    ? undefined
    : firstUserMessage.length > 58 ? `${firstUserMessage.slice(0, 55)}…` : firstUserMessage;
  const title = projection.title?.trim() || derivedTitle;
  return { id, ...(title === undefined ? {} : { title }), workspaceRoot, permissionPreset, archived: archived ?? false, deleted: deleted ?? false, createdAt, updatedAt, status, lastSequence,
    ...(projection.parentSessionId === undefined ? {} : { parentSessionId: projection.parentSessionId }),
    ...(projection.parentTaskId === undefined ? {} : { parentTaskId: projection.parentTaskId }),
    ...(projection.childMode === undefined ? {} : { childMode: projection.childMode }),
    ...(projection.childProvider === undefined ? {} : { childProvider: projection.childProvider }),
    ...(projection.delegationDepth === undefined ? {} : { delegationDepth: projection.delegationDepth }),
    ...(projection.activeWorktreeId === undefined ? {} : { activeWorktreeId: projection.activeWorktreeId }),
    ...(projection.activeWorkspaceRoot === undefined ? {} : { activeWorkspaceRoot: projection.activeWorkspaceRoot }),
    ...(projection.ownership === undefined ? {} : { ownership: projection.ownership }),
  };
}

function readSummary(row: SqliteRow): SessionSummary {
  const projection = typeof row["projection_json"] === "string" ? JSON.parse(row["projection_json"] as string) as Partial<SessionProjection> : undefined;
  const firstUserMessage = projection?.messages?.find((message) => message.role === "user")?.content.trim();
  const derivedTitle = firstUserMessage === undefined || firstUserMessage.length === 0
    ? undefined
    : firstUserMessage.length > 58 ? `${firstUserMessage.slice(0, 55)}…` : firstUserMessage;
  const title = projection?.title?.trim() || derivedTitle;
  return {
    id: brand<string, "SessionId">(String(row["id"])),
    ...(title === undefined ? {} : { title }),
    workspaceRoot: String(row["workspace_root"]),
    permissionPreset: isPermissionPreset(projection?.permissionPreset) ? projection.permissionPreset : "ask-on-write",
    archived: projection?.archived === true,
    deleted: projection?.deleted === true,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    status: String(row["status"]) as SessionStatus,
    lastSequence: Number(row["last_sequence"]),
    ...(projection?.parentSessionId === undefined ? {} : { parentSessionId: projection.parentSessionId }),
    ...(projection?.parentTaskId === undefined ? {} : { parentTaskId: projection.parentTaskId }),
    ...(projection?.childMode === undefined ? {} : { childMode: projection.childMode }),
    ...(projection?.childProvider === undefined ? {} : { childProvider: projection.childProvider }),
    ...(projection?.delegationDepth === undefined ? {} : { delegationDepth: projection.delegationDepth }),
    ...(projection?.activeWorktreeId === undefined ? {} : { activeWorktreeId: projection.activeWorktreeId }),
    ...(projection?.activeWorkspaceRoot === undefined ? {} : { activeWorkspaceRoot: projection.activeWorkspaceRoot }),
    ...(projection?.ownership === undefined ? {} : { ownership: projection.ownership }),
  };
}

function readEvent(row: SqliteRow): AgentEvent {
  const turnId = row["turn_id"];
  const correlationId = row["correlation_id"];
  return {
    eventId: String(row["event_id"]),
    sequence: Number(row["sequence"]),
    schemaVersion: Number(row["schema_version"]) as 1,
    sessionId: brand<string, "SessionId">(String(row["session_id"])),
    ...(turnId === null || turnId === undefined ? {} : { turnId: brand<string, "TurnId">(String(turnId)) }),
    ...(correlationId === null || correlationId === undefined ? {} : { correlationId: String(correlationId) }),
    type: String(row["type"]) as AgentEventType,
    createdAt: String(row["created_at"]),
    payload: JSON.parse(String(row["payload_json"])) as Record<string, unknown>,
  };
}

function readMcpConfig(row: SqliteRow): McpConfigRecord {
  const tenantId = row["tenant_id"];
  const ownerId = row["owner_id"];
  const workspaceRoot = row["workspace_root"];
  const sessionId = row["session_id"];
  const credentialRef = row["credential_ref_json"];
  return {
    name: String(row["name"]),
    scope: String(row["scope"]) as McpConfigRecord["scope"],
    ...(tenantId === null || tenantId === undefined ? {} : { tenantId: String(tenantId) }),
    ...(ownerId === null || ownerId === undefined ? {} : { ownerId: String(ownerId) }),
    ...(workspaceRoot === null || workspaceRoot === undefined ? {} : { workspaceRoot: String(workspaceRoot) }),
    ...(sessionId === null || sessionId === undefined ? {} : { sessionId: String(sessionId) }),
    enabled: Number(row["enabled"]) === 1,
    revision: Number(row["revision"]),
    ...(credentialRef === null || credentialRef === undefined ? {} : { credentialRef: JSON.parse(String(credentialRef)) as McpCredentialReference }),
    config: JSON.parse(String(row["config_json"])) as Record<string, unknown>,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function readCommand(row: SqliteRow): CommandRecord {
  return {
    sessionId: brand<string, "SessionId">(String(row["session_id"])),
    commandId: String(row["command_id"]),
    kind: String(row["kind"]),
    request: JSON.parse(String(row["request_json"])),
    result: JSON.parse(String(row["result_json"])),
    createdAt: String(row["created_at"]),
  };
}

function assertSameCommand(existing: CommandRecord, input: ClaimCommandInput): void {
  if (existing.kind !== input.kind || JSON.stringify(existing.request) !== JSON.stringify(input.request)) {
    throw new Error(`Command id ${input.commandId} was already used for a different request`);
  }
}

function defaultDatabasePath(): string {
  const configured = process.env["CODE_REVIEW_AGENT_DB_PATH"];
  if (configured !== undefined && configured.length > 0) return configured;
  return isAbsolute(process.cwd()) ? resolve(process.cwd(), ".data", "code-review-agent.sqlite") : ".data/code-review-agent.sqlite";
}
