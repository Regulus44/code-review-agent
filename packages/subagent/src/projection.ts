import { brand, type AgentEvent, type TaskId, type TaskProjection, type TaskStatus, type ArtifactRef, type TaskReport, type TaskStopReason, type ToolError } from "@coding-agent/contracts";

function status(value: unknown, fallback: TaskStatus): TaskStatus {
  return value === "queued" || value === "running" || value === "waiting" || value === "completed" || value === "failed" || value === "cancelled" || value === "blocked" ? value : fallback;
}

function terminal(value: TaskStatus): boolean {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "blocked";
}

function artifact(value: unknown): ArtifactRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Record<string, unknown>;
  const kind = input["kind"];
  if (typeof input["id"] !== "string" || typeof input["label"] !== "string" || (kind !== "file" && kind !== "diff" && kind !== "log" && kind !== "url" && kind !== "json" && kind !== "other")) return undefined;
  return { id: input["id"], kind, label: input["label"], ...(typeof input["path"] === "string" ? { path: input["path"] } : {}) };
}

function report(value: unknown): TaskReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Record<string, unknown>;
  const taskId = input["taskId"];
  const childSessionId = input["childSessionId"];
  const result = input["status"];
  if (typeof taskId !== "string" || typeof childSessionId !== "string" || typeof input["summary"] !== "string" || (result !== "completed" && result !== "failed" && result !== "cancelled" && result !== "rejected" && result !== "partial")) return undefined;
  const stopReason = input["stopReason"];
  const validStopReason = stopReason === "completed" || stopReason === "aborted" || stopReason === "error" || stopReason === "max-tokens" || stopReason === "refusal" ? stopReason as TaskStopReason : undefined;
  return {
    taskId: brand<string, "TaskId">(taskId),
    childSessionId: brand<string, "SessionId">(childSessionId),
    status: result,
    summary: input["summary"],
    artifacts: Array.isArray(input["artifacts"])
      ? input["artifacts"].map(artifact).filter((item): item is ArtifactRef => item !== undefined)
      : [],
    ...(input["output"] === undefined ? {} : { output: input["output"] }),
    ...(validStopReason === undefined ? {} : { stopReason: validStopReason }),
    ...(Array.isArray(input["diagnostics"] ? input["diagnostics"] as readonly ToolError[] : undefined) ? { diagnostics: input["diagnostics"] as readonly ToolError[] } : {}),
  };
}

export function projectTask(events: readonly AgentEvent[], taskId: TaskId): TaskProjection | undefined {
  let current: TaskProjection | undefined;
  for (const event of events) {
    if (event.type !== "task/created" && event.type !== "task/updated" && event.type !== "task/input-required" && event.type !== "task/report" && event.type !== "task/artifact" && event.type !== "task/ended") continue;
    if (event.payload["taskId"] !== taskId) continue;
    const taskReport = event.type === "task/report" ? report(event.payload["report"] ?? event.payload) : undefined;
    const nextStatus = event.type === "task/input-required"
      ? "waiting"
      : event.type === "task/report"
        ? taskReport?.status === "completed" ? "completed" : taskReport?.status === "cancelled" ? "cancelled" : taskReport?.status === "rejected" ? "failed" : "waiting"
        : event.type === "task/ended" ? status(event.payload["status"], "completed")
          : event.type === "task/updated" ? status(event.payload["status"], current?.status ?? "queued") : "queued";
    if (current !== undefined && terminal(current.status) && (event.type === "task/created" || event.type === "task/updated")) continue;
    const next: TaskProjection = {
      ...(current ?? { id: taskId, status: "queued", createdAt: event.createdAt, updatedAt: event.createdAt, artifacts: [], lastSequence: event.sequence }),
      status: nextStatus,
      updatedAt: event.createdAt,
      lastSequence: event.sequence,
      ...(typeof event.payload["title"] === "string" ? { title: event.payload["title"] } : {}),
      ...(typeof event.payload["parentSessionId"] === "string" ? { parentSessionId: brand<string, "SessionId">(event.payload["parentSessionId"]) } : {}),
      ...(typeof event.payload["parentTaskId"] === "string" ? { parentTaskId: brand<string, "TaskId">(event.payload["parentTaskId"]) } : {}),
      ...(typeof event.payload["childSessionId"] === "string" ? { childSessionId: brand<string, "SessionId">(event.payload["childSessionId"]) } : {}),
      ...(event.payload["mode"] === "one-shot" || event.payload["mode"] === "continuable" ? { mode: event.payload["mode"] } : {}),
      ...(typeof event.payload["provider"] === "string" ? { provider: event.payload["provider"] } : {}),
      ...(typeof event.payload["workspaceRoot"] === "string" ? { workspaceRoot: event.payload["workspaceRoot"] } : {}),
      ...(typeof event.payload["delegationDepth"] === "number" ? { delegationDepth: event.payload["delegationDepth"] } : {}),
      ...(taskReport === undefined ? {} : { report: taskReport, result: taskReport.output }),
      ...(event.type === "task/artifact" ? (() => { const item = artifact(event.payload["artifact"] ?? event.payload); return item === undefined ? {} : { artifacts: [...(current?.artifacts ?? []), item] }; })() : {}),
    };
    current = next;
  }
  return current;
}

export function assertContiguousSequence(events: readonly AgentEvent[]): void {
  let expected = events.length === 0 ? 0 : 1;
  for (const event of events) {
    if (event.sequence !== expected) throw new Error(`EVENT_SEQUENCE_GAP: expected ${expected}, received ${event.sequence}`);
    expected += 1;
  }
}
