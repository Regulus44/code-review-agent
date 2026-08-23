import { describe, expect, it } from "vitest";
import { brand } from "@code-review-agent/contracts";
import type { TaskProjection } from "@code-review-agent/contracts";
import { presentTask } from "./task-presenter.js";

const taskId = brand<string, "TaskId">("task_presenter");
const sessionId = brand<string, "SessionId">("ses_child_presenter");

function task(overrides: Partial<TaskProjection> = {}): TaskProjection {
  return {
    id: taskId,
    status: "completed",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:02.000Z",
    title: "Inspect repository",
    childSessionId: sessionId,
    mode: "one-shot",
    provider: "in-process",
    workspaceRoot: "D:/workspace",
    delegationDepth: 1,
    artifacts: [{ id: "artifact_1", kind: "file", label: "report.md", path: "D:/workspace/report.md" }],
    report: { taskId, childSessionId: sessionId, status: "completed", summary: "Found the entry points", artifacts: [] },
    lastSequence: 4,
    ...overrides,
  };
}

describe("task presenter", () => {
  it("preserves task lineage and bounded report details", () => {
    const view = presentTask(task(), { maxDetailChars: 512 });
    expect(view.title).toBe("Inspect repository");
    expect(view.mode).toBe("one-shot");
    expect(view.lineage).toContain("child ses_child_presenter");
    expect(view.artifacts).toEqual(["report.md"]);
    expect(view.details.untrusted).toBe(true);
    expect(view.summary).toBe("Found the entry points");
  });

  it("only marks live tasks cancellable and exposes resumable catalog state", () => {
    expect(presentTask(task({ status: "running" }), { live: true }).cancellable).toBe(true);
    expect(presentTask(task({ status: "running" }), { live: false }).cancellable).toBe(false);
    expect(presentTask(task({ status: "completed" }), { live: true, resumable: true }).resumable).toBe(true);
  });

  it("does not expose credential values in report details", () => {
    const view = presentTask(task({ result: { token: "secret", ok: true } }));
    expect(view.details.text).toContain("[redacted]");
    expect(view.details.text).not.toContain("secret");
  });
});
