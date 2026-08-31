import { describe, expect, it } from "vitest";
import { presentTodoPanel } from "./todo-presenter.js";

describe("presentTodoPanel", () => {
  it("summarizes durable todo statuses and uses bounded details", () => {
    const view = presentTodoPanel([
      { id: "one", content: "Read", status: "completed" },
      { id: "two", content: "Edit", activeForm: "Editing", status: "in_progress" },
      { id: "three", content: "Test", status: "pending" },
    ]);
    expect(view).toMatchObject({ visible: true, total: 3, completed: 1, inProgress: 1, pending: 1 });
    expect(view.summary).toContain("1/3 已完成");
    expect(view.items[1]).toMatchObject({ statusLabel: "进行中", detail: "Editing" });
  });

  it("preserves an explicit empty state", () => {
    expect(presentTodoPanel([])).toMatchObject({ visible: false, total: 0, summary: "没有待办事项" });
  });
});
