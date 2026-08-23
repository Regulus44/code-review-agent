import type { TodoItem } from "@code-review-agent/contracts";

export interface TodoItemRenderIntent {
  readonly id: string;
  readonly content: string;
  readonly activeForm?: string;
  readonly status: TodoItem["status"];
  readonly statusLabel: string;
  readonly detail: string;
}

export interface TodoRenderIntent {
  readonly visible: boolean;
  readonly items: readonly TodoItemRenderIntent[];
  readonly total: number;
  readonly completed: number;
  readonly inProgress: number;
  readonly pending: number;
  readonly collapsedByDefault: boolean;
  readonly summary: string;
}

export function presentTodoPanel(todos: readonly TodoItem[] | undefined, maxItems = 64, maxChars = 240): TodoRenderIntent {
  const all = todos ?? [];
  const items = all.slice(0, Math.max(1, Math.floor(maxItems))).map((todo) => ({
    id: todo.id,
    content: bounded(todo.content, maxChars),
    ...(todo.activeForm === undefined ? {} : { activeForm: bounded(todo.activeForm, maxChars) }),
    status: todo.status,
    statusLabel: todo.status === "in_progress" ? "In progress" : todo.status === "completed" ? "Completed" : todo.status === "cancelled" ? "Cancelled" : "Pending",
    detail: todo.status === "in_progress" ? bounded(todo.activeForm ?? todo.content, maxChars) : bounded(todo.content, maxChars),
  }));
  const completed = all.filter((todo) => todo.status === "completed").length;
  const inProgress = all.filter((todo) => todo.status === "in_progress").length;
  const pending = all.filter((todo) => todo.status === "pending").length;
  return {
    visible: all.length > 0,
    items,
    total: all.length,
    completed,
    inProgress,
    pending,
    collapsedByDefault: all.length > 5,
    summary: all.length === 0 ? "No todo items" : `${completed}/${all.length} completed · ${inProgress} in progress · ${pending} pending`,
  };
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const limit = Math.max(24, Math.floor(maxChars));
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
