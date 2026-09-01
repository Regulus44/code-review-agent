import { brand, type ArtifactRef, type ChildSessionMetadata, type PermissionPreset, type SessionEventStore, type SessionId, type TaskBudget, type TaskId, type TaskProjection, type TaskReport } from "@coding-agent/contracts";
import { randomUUID } from "node:crypto";

export interface CreateTaskInput {
  readonly parentSessionId: SessionId;
  readonly taskId?: TaskId;
  readonly parentTaskId?: TaskId;
  readonly childSessionId?: SessionId;
  readonly title?: string;
  readonly mode?: "one-shot" | "continuable";
  readonly provider?: string;
  readonly workspaceRoot?: string;
  readonly permissionPreset?: PermissionPreset;
  readonly delegationDepth?: number;
  readonly budget?: TaskBudget;
}

function newTaskId(): TaskId { return brand<string, "TaskId">(`task_${randomUUID()}`); }

export class TaskService {
  constructor(private readonly store: SessionEventStore) {}

  async create(input: CreateTaskInput, commandId = `create_${randomUUID()}`): Promise<TaskProjection> {
    const taskId = input.taskId ?? newTaskId();
    const result = { taskId };
    const claim = await this.store.claimCommand({ sessionId: input.parentSessionId, commandId, kind: "task/create", request: input, result });
    if (!claim.created) return (await this.get(input.parentSessionId, taskId)) ?? { id: taskId, status: "queued", createdAt: claim.record.createdAt, updatedAt: claim.record.createdAt, artifacts: [], lastSequence: 0 };
    await this.store.append({
      sessionId: input.parentSessionId,
      correlationId: commandId,
      type: "task/created",
      payload: {
        taskId,
        parentSessionId: input.parentSessionId,
        ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
        ...(input.childSessionId === undefined ? {} : { childSessionId: input.childSessionId }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        ...(input.permissionPreset === undefined ? {} : { permissionPreset: input.permissionPreset }),
        ...(input.delegationDepth === undefined ? {} : { delegationDepth: input.delegationDepth }),
        ...(input.budget === undefined ? {} : { budget: input.budget }),
      },
    });
    const task = await this.get(input.parentSessionId, taskId);
    if (task === undefined) throw new Error(`Task projection was not created: ${taskId}`);
    return task;
  }

  async update(parentSessionId: SessionId, taskId: TaskId, payload: Record<string, unknown>): Promise<TaskProjection> {
    await this.store.append({ sessionId: parentSessionId, type: "task/updated", payload: { taskId, ...payload } });
    const task = await this.get(parentSessionId, taskId);
    if (task === undefined) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async report(parentSessionId: SessionId, report: TaskReport, commandId = `report_${randomUUID()}`): Promise<TaskProjection> {
    const claim = await this.store.claimCommand({ sessionId: parentSessionId, commandId, kind: "task/report", request: report, result: { taskId: report.taskId } });
    if (claim.created) await this.store.append({ sessionId: parentSessionId, type: "task/report", payload: { taskId: report.taskId, report } });
    const task = await this.get(parentSessionId, report.taskId);
    if (task === undefined) throw new Error(`Unknown task: ${report.taskId}`);
    return task;
  }

  async artifact(parentSessionId: SessionId, taskId: TaskId, artifact: ArtifactRef): Promise<TaskProjection> {
    await this.store.append({ sessionId: parentSessionId, type: "task/artifact", payload: { taskId, artifact } });
    const task = await this.get(parentSessionId, taskId);
    if (task === undefined) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async cancel(parentSessionId: SessionId, taskId: TaskId, commandId = `cancel_${randomUUID()}`): Promise<TaskProjection> {
    const claim = await this.store.claimCommand({ sessionId: parentSessionId, commandId, kind: "task/cancel", request: { taskId }, result: { taskId, status: "cancelled" } });
    if (claim.created) await this.store.append({ sessionId: parentSessionId, type: "task/ended", payload: { taskId, status: "cancelled", terminalReason: "cancelled_by_parent" } });
    const task = await this.get(parentSessionId, taskId);
    if (task === undefined) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async get(parentSessionId: SessionId, taskId: TaskId): Promise<TaskProjection | undefined> {
    return (await this.store.listTasks(parentSessionId)).find((task) => task.id === taskId);
  }
}

export function childMetadata(descriptor: import("@coding-agent/contracts").SubagentDescriptor): ChildSessionMetadata {
  return {
    parentSessionId: descriptor.parentSessionId,
    ...(descriptor.parentTaskId === undefined ? {} : { parentTaskId: descriptor.parentTaskId }),
    childMode: descriptor.mode,
    childProvider: descriptor.provider,
    delegationDepth: descriptor.delegationDepth,
    descriptor,
  };
}
