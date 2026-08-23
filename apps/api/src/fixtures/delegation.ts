import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  brand,
  type ArtifactRef,
  type AgentEventType,
  type SessionEventStore,
  type SessionId,
  type TaskReport,
  type TurnId,
} from "@code-review-agent/contracts";
import {
  SubagentRuntime,
  type ProviderRun,
  type ProviderRunContext,
  type SubagentProvider,
  type SpawnReceipt,
} from "@code-review-agent/subagent";

/**
 * Phase 7 browser/API fixture provider.
 *
 * It deliberately exercises the durable SubagentRuntime boundary instead of
 * adding a production-only endpoint or putting fixture state in the Web UI.
 * The completed child returns a bounded report/artifact; the cancellable child
 * remains live until its parent issues a cancel command. Both children append a
 * small child-session transcript so history/replay has non-empty evidence.
 */
export const DELEGATION_FIXTURE_PROVIDER = "phase-7-fixture";

export interface DelegationFixtureProviderOptions {
  readonly store: SessionEventStore;
}

export interface DelegationFixtureSeedOptions {
  readonly store: SessionEventStore;
  readonly runtime: SubagentRuntime;
  readonly parentSessionId: SessionId;
  readonly workspaceRoot: string;
  readonly completedWorkspaceRoot?: string;
  readonly cancellableWorkspaceRoot?: string;
  readonly commandPrefix?: string;
}

export interface DelegationFixtureSeed {
  readonly completed: SpawnReceipt;
  readonly cancellable: SpawnReceipt;
}

function turnId(): TurnId {
  return brand<string, "TurnId">(`turn_fixture_${randomUUID()}`);
}

function reportArtifact(context: ProviderRunContext): ArtifactRef {
  return {
    id: `artifact_${context.taskId}`,
    kind: "json",
    label: `${context.descriptor.label ?? "child"} delegation report`,
    path: join(context.descriptor.workspaceRoot, "delegation-report.json"),
    mediaType: "application/json",
    preview: JSON.stringify({ taskId: context.taskId, status: "completed" }),
  };
}

function fixtureReport(context: ProviderRunContext, status: TaskReport["status"], stopReason: TaskReport["stopReason"], summary: string): TaskReport {
  return {
    taskId: context.taskId,
    childSessionId: context.childSessionId,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    summary,
    output: { fixture: true, taskId: context.taskId, childSessionId: context.childSessionId },
    artifacts: status === "completed" ? [reportArtifact(context)] : [],
  };
}

/** Create a deterministic provider without changing the production provider catalog. */
export function createDelegationFixtureProvider(options: DelegationFixtureProviderOptions): SubagentProvider {
  return {
    name: DELEGATION_FIXTURE_PROVIDER,
    capabilities: { oneShot: true, continuable: true, outputSchema: false, toolFilter: true },
    async start(request, context): Promise<ProviderRun> {
      const childTurnId = turnId();
      let settled = false;
      let finishPending: ((report: TaskReport) => void) | undefined;

      const append = async (type: AgentEventType, payload: Record<string, unknown>): Promise<void> => {
        await options.store.append({ sessionId: context.childSessionId, turnId: childTurnId, type, payload });
      };

      const finish = async (report: TaskReport): Promise<void> => {
        if (settled) return;
        settled = true;
        await append("assistant/message", { content: report.summary });
        await append("turn/ended", { status: report.status === "cancelled" ? "interrupted" : "completed" });
        finishPending?.(report);
        finishPending = undefined;
      };

      const result = async (): Promise<TaskReport> => {
        await append("turn/queued", {});
        await append("turn/started", {});
        await append("user/message", { content: request.prompt });

        if (request.prompt.includes("[fixture:cancellable]")) {
          return await new Promise<TaskReport>((resolve) => {
            finishPending = resolve;
            const onAbort = (): void => {
              context.signal.removeEventListener("abort", onAbort);
              void finish(fixtureReport(context, "cancelled", "aborted", "Fixture child cancelled by parent."));
            };
            context.signal.addEventListener("abort", onAbort, { once: true });
            if (context.signal.aborted) onAbort();
          });
        }

        const report = fixtureReport(context, "completed", "completed", `Fixture completed: ${request.prompt}`);
        await finish(report);
        return report;
      };

      return {
        result,
        interrupt: async () => {
          if (!context.signal.aborted) return;
          await finish(fixtureReport(context, "cancelled", "aborted", "Fixture child interrupted."));
        },
        dispose: async () => {
          if (!settled && context.signal.aborted) await finish(fixtureReport(context, "cancelled", "aborted", "Fixture child disposed after cancellation."));
        },
      };
    },
  };
}

/**
 * Seed one completed child and one live child under a real parent Session.
 * Callers own the store/session cleanup; no Web state is mutated directly.
 */
export async function seedDelegationFixture(options: DelegationFixtureSeedOptions): Promise<DelegationFixtureSeed> {
  const prefix = options.commandPrefix ?? `phase7-fixture-${randomUUID()}`;
  const completed = await options.runtime.spawn({
    parentSessionId: options.parentSessionId,
    prompt: "[fixture:completed] produce a bounded delegation report",
    mode: "one-shot",
    background: false,
    provider: DELEGATION_FIXTURE_PROVIDER,
    workspaceRoot: options.completedWorkspaceRoot ?? options.workspaceRoot,
    permissionPreset: "read-only",
    toolAllowlist: ["read_file"],
    mcpAllowlist: [],
    label: "Completed review child",
    commandId: `${prefix}-completed`,
  });
  const cancellable = await options.runtime.spawn({
    parentSessionId: options.parentSessionId,
    prompt: "[fixture:cancellable] hold until the parent cancels this task",
    mode: "one-shot",
    background: true,
    provider: DELEGATION_FIXTURE_PROVIDER,
    workspaceRoot: options.cancellableWorkspaceRoot ?? options.workspaceRoot,
    permissionPreset: "read-only",
    toolAllowlist: ["read_file"],
    mcpAllowlist: [],
    label: "Cancellable review child",
    commandId: `${prefix}-cancellable`,
  });
  return { completed, cancellable };
}
