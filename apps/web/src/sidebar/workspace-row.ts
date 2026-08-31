import type { WorkspaceNavigationGroup } from "../presentation/navigation-presenter.js";

export interface WorkspaceRowPresentationInput {
  readonly group: Pick<WorkspaceNavigationGroup, "key" | "root" | "label">;
  readonly expanded?: boolean;
  readonly active?: boolean;
  readonly sessionCount?: number;
}

export interface WorkspaceRowPresentation {
  readonly key: string;
  readonly label: string;
  readonly root: string;
  readonly expanded: boolean;
  readonly active: boolean;
  /** Full path/count stay available to hover/assistive details, not the row's visual label. */
  readonly title: string;
  readonly ariaLabel: string;
}

export interface WorkspaceRowHandlers {
  readonly onToggle?: (event: MouseEvent | KeyboardEvent) => void;
  readonly onMenu?: (anchor: HTMLButtonElement) => void;
}

export function presentWorkspaceRow(input: WorkspaceRowPresentationInput): WorkspaceRowPresentation {
  const root = String(input.group.root || ".");
  const label = String(input.group.label || workspaceLabel(root));
  const expanded = input.expanded === true;
  const active = input.active === true;
  const sessionCount = Number.isFinite(input.sessionCount) && (input.sessionCount ?? 0) >= 0 ? Math.floor(input.sessionCount ?? 0) : undefined;
  const details = [root, sessionCount === undefined ? undefined : `${sessionCount} 个会话`].filter(Boolean).join(" · ");
  return {
    key: input.group.key,
    label,
    root,
    expanded,
    active,
    title: details || root,
    ariaLabel: `工作区 ${label}${details ? ` · ${details}` : ""}`,
  };
}

/**
 * Create the compact Workspace header used by both Tree and Flat adapters.
 * The caller owns the surrounding section and expansion state; this function
 * only owns row semantics and the hover-only menu affordance.
 */
export function createWorkspaceRow(
  input: WorkspaceRowPresentationInput,
  handlers: WorkspaceRowHandlers = {},
  documentRef: Document = document,
): HTMLDivElement {
  const view = presentWorkspaceRow(input);
  const header = documentRef.createElement("div");
  header.className = `workspace-group-header${view.active ? " active" : ""}`;
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", String(view.expanded));
  header.setAttribute("aria-label", view.ariaLabel);
  header.title = view.title;
  header.dataset.workspaceKey = view.key;

  const caret = documentRef.createElement("span");
  caret.className = "workspace-caret";
  caret.textContent = "⌄";
  caret.setAttribute("aria-hidden", "true");

  const folder = documentRef.createElement("span");
  folder.className = "workspace-folder";
  folder.textContent = "⌂";
  folder.setAttribute("aria-hidden", "true");

  const copy = documentRef.createElement("span");
  copy.className = "workspace-group-copy";
  const name = documentRef.createElement("span");
  name.className = "workspace-group-name";
  name.textContent = view.label;
  copy.append(name);

  header.append(caret, folder, copy);
  if (handlers.onMenu) {
    const menu = documentRef.createElement("button");
    menu.type = "button";
    menu.className = "workspace-menu-trigger";
    menu.textContent = "⋯";
    menu.title = `工作区操作 · ${view.label}`;
    menu.setAttribute("aria-label", `工作区操作 · ${view.label}`);
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onMenu?.(menu);
    });
    header.append(menu);
  }
  if (handlers.onToggle) {
    header.addEventListener("click", (event) => handlers.onToggle?.(event));
    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      handlers.onToggle?.(event);
    });
  }
  return header;
}

function workspaceLabel(root: string): string {
  const value = root.replace(/[\\/]+$/u, "");
  const segments = value.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) || value || "工作区";
}
