import type { SessionId, SessionSummary } from "@coding-agent/contracts";
import { sessionLabel, sessionRelativeTime } from "../presentation/navigation-presenter.js";
import {
  presentSessionStatus,
  type SessionStatusPresentationOptions,
} from "./sidebar-presenter.js";

export interface SessionRowPresentationInput extends SessionStatusPresentationOptions {
  readonly session: SessionSummary;
  readonly selected?: boolean;
  readonly now?: number;
}

export interface SessionRowPresentation {
  readonly id: SessionId;
  readonly label: string;
  readonly relativeTime: string;
  readonly status: ReturnType<typeof presentSessionStatus>;
  readonly details: string;
  readonly title: string;
  readonly ariaLabel: string;
}

export interface SessionRowHandlers {
  readonly onSelect?: (id: SessionId) => void;
  readonly onMenu?: (session: SessionSummary, anchor: HTMLButtonElement) => void;
}

export function presentSessionRow(input: SessionRowPresentationInput): SessionRowPresentation {
  const session = input.session;
  const label = sessionLabel(session);
  const relativeTime = sessionRelativeTime(session.updatedAt, input.now) || "新建";
  const status = presentSessionStatus(session, input);
  const details = [
    session.workspaceRoot || ".",
    session.permissionPreset,
    session.childMode,
    session.childProvider,
  ].filter(Boolean).join(" · ");
  return {
    id: session.id,
    label,
    relativeTime,
    status,
    details,
    title: `${label} · ${details}`,
    ariaLabel: `${status.ariaLabel} · ${label} · 更新于 ${relativeTime}`,
  };
}

/**
 * Create a low-noise Session row. Permission/child/provider metadata remains
 * discoverable via title and an assistive-only detail span, while the visual
 * row keeps only status, title and relative time.
 */
export function createSessionRow(
  input: SessionRowPresentationInput,
  handlers: SessionRowHandlers = {},
  documentRef: Document = document,
): HTMLDivElement {
  const view = presentSessionRow(input);
  const row = documentRef.createElement("div");
  row.className = "tree-session";
  row.dataset.sessionId = String(view.id);

  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = `session${input.selected === true ? " active" : ""}`;
  button.title = view.title;
  button.setAttribute("aria-label", view.ariaLabel);
  if (input.selected === true) button.setAttribute("aria-current", "true");

  const statusDot = documentRef.createElement("span");
  statusDot.className = `session-status-dot ${view.status.cssClass}`;
  statusDot.setAttribute("aria-hidden", "true");

  const copy = documentRef.createElement("span");
  copy.className = "session-copy";
  const name = documentRef.createElement("span");
  name.className = "session-name";
  name.textContent = view.label;
  const meta = documentRef.createElement("span");
  meta.className = "session-path";
  meta.textContent = view.relativeTime;
  copy.append(name, meta);

  const detail = documentRef.createElement("span");
  detail.className = "session-row-detail sr-only";
  detail.textContent = view.details;
  copy.append(detail);
  button.append(statusDot, copy);
  if (handlers.onSelect) button.addEventListener("click", () => handlers.onSelect?.(view.id));
  row.append(button);

  if (handlers.onMenu) {
    const actions = documentRef.createElement("span");
    actions.className = "tree-session-actions";
    const menu = documentRef.createElement("button");
    menu.type = "button";
    menu.className = "tree-action";
    menu.textContent = "⋯";
    menu.title = "会话操作";
    menu.setAttribute("aria-label", `会话操作 · ${view.label}`);
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onMenu?.(input.session, menu);
    });
    actions.append(menu);
    row.append(actions);
  }
  return row;
}
