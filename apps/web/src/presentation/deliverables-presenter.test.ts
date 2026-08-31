import { describe, expect, it } from "vitest";
import type { TaskProjection } from "@code-review-agent/contracts";
import { presentDeliverables } from "./deliverables-presenter.js";

const task = (id: string, artifacts: TaskProjection["artifacts"]): TaskProjection => ({
  id: id as TaskProjection["id"],
  status: "completed",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  artifacts,
  lastSequence: 3,
});

describe("presentDeliverables", () => {
  it("deduplicates artifacts and classifies workspace, unsafe and external paths", () => {
    const view = presentDeliverables([
      task("task_one", [
        { id: "file-1", kind: "file", label: "notes.txt", path: "notes.txt", sizeBytes: 12, preview: "after" },
        { id: "unsafe", kind: "file", label: "secret", path: "../secret.txt" },
        { id: "absolute-unsafe", kind: "file", label: "outside", path: "D:/other/secret.txt" },
        { id: "url", kind: "url", label: "Docs", path: "https://example.test/docs" },
      ]),
      task("task_two", [{ id: "file-1", kind: "file", label: "duplicate", path: "notes.txt" }]),
    ], "D:/workspace");

    expect(view.items).toHaveLength(4);
    expect(view.items[0]).toMatchObject({ id: "file-1", scope: "workspace", scopeLabel: "工作区内", action: "open" });
    expect(view.items[0]?.actionReason).toContain("预览");
    expect(view.items[1]).toMatchObject({ scope: "unsafe", scopeLabel: "已阻止" });
    expect(view.items[2]).toMatchObject({ scope: "unsafe", scopeLabel: "已阻止" });
    expect(view.items[3]).toMatchObject({ scope: "external", scopeLabel: "外部" });
  });

  it("bounds the manifest and preserves an explicit empty state", () => {
    const view = presentDeliverables([task("task", [{ id: "a", kind: "json", label: "a", preview: "x" }])], ".", 1);
    expect(view.items).toHaveLength(1);
    expect(view.truncated).toBe(false);
    expect(presentDeliverables([], ".")).toEqual({ items: [], truncated: false });
  });
});
