import { describe, expect, it } from "vitest";
import { brand, type AgentEvent } from "@code-review-agent/contracts";
import { presentRuntimeDiagnostics } from "./job-presenter.js";

const sessionId = brand<string, "SessionId">("ses_jobs");

function event(sequence: number, type: AgentEvent["type"], payload: Record<string, unknown>): AgentEvent {
  return {
    eventId: "evt_" + sequence,
    sequence,
    schemaVersion: 1,
    sessionId,
    type,
    createdAt: "2026-08-23T00:00:" + String(sequence).padStart(2, "0") + ".000Z",
    payload,
  };
}

describe("presentRuntimeDiagnostics", () => {
  it("folds bounded job output and terminal completion state", () => {
    const view = presentRuntimeDiagnostics([
      event(1, "job/started", { jobId: "job_1", command: "pnpm test", cwd: "D:/repo", workspaceRoot: "D:/repo", startedAt: "2026-08-23T00:00:01.000Z" }),
      event(2, "job/output", { jobId: "job_1", stream: "stdout", text: "token=secret all good", totalBytes: 21, truncated: false }),
      event(3, "job/ended", { jobId: "job_1", status: "completed", endedAt: "2026-08-23T00:00:03.000Z", exitCode: 0, totalBytes: 21 }),
      event(4, "terminal/session", { terminalId: "terminal_1", action: "exited", status: "exited", cwd: "D:/repo", workspaceRoot: "D:/repo", command: "node", exitCode: 0, bufferedBytes: 12 }),
    ]);
    expect(view).toMatchObject({ visible: true, runningJobs: 0, failedJobs: 0, interruptedTerminals: 0 });
    expect(view.jobs[0]).toMatchObject({ jobId: "job_1", status: "completed", exitCode: 0, recovery: "completed", output: "token=[redacted] all good" });
    expect(view.terminals[0]).toMatchObject({ terminalId: "terminal_1", status: "exited", recovery: "closed" });
  });

  it("marks a job orphaned after an interrupted host and preserves diagnostics", () => {
    const view = presentRuntimeDiagnostics([
      event(1, "job/started", { jobId: "job_2", command: "pnpm long:test", cwd: "D:/repo", workspaceRoot: "D:/repo" }),
      event(2, "job/output", { jobId: "job_2", text: "partial output", totalBytes: 14 }),
      event(3, "agent/status", { status: "interrupted", reason: "process_restart" }),
    ]);
    expect(view.orphanedJobs).toBe(1);
    expect(view.jobs[0]).toMatchObject({ status: "orphaned", recovery: "orphaned", diagnostics: "主机在作业发出终止事件前重启。" });
  });

  it("bounds output and exposes failed exit diagnostics", () => {
    const view = presentRuntimeDiagnostics([
      event(1, "job/started", { jobId: "job_3", command: "bad", cwd: ".", workspaceRoot: "." }),
      event(2, "job/output", { jobId: "job_3", text: "1234567890", totalBytes: 10, truncated: true }),
      event(3, "job/ended", { jobId: "job_3", status: "failed", exitCode: 2, error: { code: "COMMAND_FAILED", message: "provider token=hidden" } }),
    ], 5);
    expect(view.jobs[0]).toMatchObject({ status: "failed", exitCode: 2, truncated: true, diagnostics: "COMMAND_FAILED: provider token=[redacted]" });
    expect(view.jobs[0]?.output.length).toBe(5);
  });
});
