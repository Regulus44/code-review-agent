import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateTrace, type TraceEvent } from "./trace-gate.ts";

function event(sequence: number, type: string, payload: Record<string, unknown> = {}, turnId?: string): TraceEvent {
  return { sequence, type, payload, ...(turnId === undefined ? {} : { turnId }) };
}

describe("evaluation trace gate", () => {
  it("accepts a continuous, paired, clean terminal trace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-trace-gate-"));
    try {
      const events = [
        event(1, "session/created", { workspaceRoot: root }),
        event(2, "turn/started", {}, "turn_1"),
        event(3, "tool/call", { toolCallId: "tool_1", name: "run_tests", workspaceRoot: root, input: { command: "python", args: ["-m", "pytest", "tests/test_core.py"] } }, "turn_1"),
        event(4, "tool/result", { toolCallId: "tool_1", status: "completed", result: { ok: true } }, "turn_1"),
        event(5, "turn/ended", { status: "completed" }, "turn_1"),
      ];
      await expect(validateTrace({ events, workspaceRoot: root, turnId: "turn_1", turnStatus: "completed" })).resolves.toMatchObject({ status: "complete", boundaryStatus: "clean", sequenceContinuous: true, turnStarted: true, toolCallCount: 1, toolResultCount: 1, issues: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("marks a terminal trace without the target turn start as partial", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-trace-gate-"));
    try {
      const events = [
        event(1, "session/created", { workspaceRoot: root }),
        event(2, "turn/ended", { status: "failed" }, "turn_1"),
      ];
      const result = await validateTrace({ events, workspaceRoot: root, turnId: "turn_1", turnStatus: "failed" });
      expect(result).toMatchObject({ status: "partial", turnStarted: false });
      expect(result.issues).toContain("turn_started_missing");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("marks a failed target turn as started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-trace-gate-"));
    try {
      const events = [
        event(1, "session/created", { workspaceRoot: root }),
        event(2, "turn/started", {}, "turn_1"),
        event(3, "turn/ended", { status: "failed", error: "model unavailable" }, "turn_1"),
      ];
      const result = await validateTrace({ events, workspaceRoot: root, turnId: "turn_1", turnStatus: "failed" });
      expect(result).toMatchObject({ status: "complete", turnStarted: true });
      expect(result.issues).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records a blocked external command without contaminating the trace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-trace-gate-"));
    try {
      const external = "D:\\Develop\\coding-agent-test\\private\\task.json";
      const events = [
        event(1, "session/created", { workspaceRoot: root }),
        event(2, "tool/call", { toolCallId: "tool_1", name: "pwsh", workspaceRoot: root, input: { command: `Get-Content '${external}'` } }),
        event(3, "tool/result", { toolCallId: "tool_1", status: "failed", result: { ok: false, error: { code: "WORKSPACE_COMMAND_DENIED" }, output: { code: "WORKSPACE_COMMAND_DENIED", reason: "external_absolute_path" } } }),
      ];
      const result = await validateTrace({ events, workspaceRoot: root });
      expect(result).toMatchObject({ status: "complete", boundaryStatus: "blocked", guardDenials: [{ toolCallId: "tool_1", reason: "external_absolute_path" }] });
      expect(result.blockedBoundaryReferences).toHaveLength(1);
      expect(result.unblockedBoundaryReferences).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("marks an unblocked external command as contaminated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-trace-gate-"));
    try {
      const events = [
        event(1, "session/created", { workspaceRoot: root }),
        event(2, "tool/call", { toolCallId: "tool_1", name: "pwsh", workspaceRoot: root, input: { command: "Get-ChildItem 'C:\\Users\\example'" } }),
        event(3, "tool/result", { toolCallId: "tool_1", status: "completed", result: { ok: true } }),
      ];
      const result = await validateTrace({ events, workspaceRoot: root });
      expect(result).toMatchObject({ status: "complete", boundaryStatus: "contaminated" });
      expect(result.unblockedBoundaryReferences).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("marks gaps, unmatched calls, and a missing terminal event as partial", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-trace-gate-"));
    try {
      const events = [
        event(1, "session/created", { workspaceRoot: root }),
        event(3, "tool/call", { toolCallId: "tool_1", name: "run_command", workspaceRoot: root, input: { executable: "python", args: ["-m", "pytest"] } }, "turn_1"),
      ];
      const result = await validateTrace({ events, workspaceRoot: root, turnId: "turn_1", turnStatus: "completed" });
      expect(result.status).toBe("partial");
      expect(result.issues).toEqual(expect.arrayContaining(["event_sequence_not_continuous", "unmatched_tool_calls", "terminal_turn_event_missing"]));
      expect(result.unmatchedToolCallIds).toEqual(["tool_1"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("marks an empty export as missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-trace-gate-"));
    try {
      await expect(validateTrace({ events: [], workspaceRoot: root })).resolves.toMatchObject({ status: "missing", boundaryStatus: "unknown", issues: ["events_missing"] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects events imported from another session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-trace-gate-"));
    try {
      const events = [
        { ...event(1, "session/created", { workspaceRoot: root }), sessionId: "ses_other" },
        { ...event(2, "turn/ended", { status: "completed" }, "turn_1"), sessionId: "ses_other" },
      ];
      const result = await validateTrace({ events, workspaceRoot: root, sessionId: "ses_expected" });
      expect(result.status).toBe("partial");
      expect(result.issues).toContain("event_session_mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
