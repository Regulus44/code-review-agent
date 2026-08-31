import type { ShellLayoutRenderIntent } from "./layout.js";

/** The small DOM surface owned by the physical three-column Shell frame. */
export interface ShellFrameElements {
  readonly app: HTMLElement;
  readonly mobileMenu: HTMLButtonElement;
  readonly sidebarResizer?: HTMLElement;
  readonly detailsResizer?: HTMLElement;
}

/** Resolve the frame-owned elements without taking ownership of Conversation or Details content. */
export function mountShellFrame(root: ParentNode): ShellFrameElements | undefined {
  const app = root.querySelector<HTMLElement>("#app");
  const mobileMenu = root.querySelector<HTMLButtonElement>("#mobile-menu");
  if (app === null || mobileMenu === null) return undefined;
  const sidebarResizer = root.querySelector<HTMLElement>("#sidebar-resizer") ?? undefined;
  const detailsResizer = root.querySelector<HTMLElement>("#details-resizer") ?? undefined;
  return {
    app,
    mobileMenu,
    ...(sidebarResizer === undefined ? {} : { sidebarResizer }),
    ...(detailsResizer === undefined ? {} : { detailsResizer }),
  };
}

/** Apply the typed layout intent to the frame-owned DOM only. */
export function applyShellFrame(elements: ShellFrameElements, intent: ShellLayoutRenderIntent): void {
  elements.app.className = intent.appClassName;
  elements.app.style.setProperty("--sidebar-width", `${intent.renderedColumns.sidebar}px`);
  elements.app.style.setProperty("--details-width", `${intent.renderedColumns.details}px`);
  elements.app.style.gridTemplateColumns = intent.mobile
    ? intent.mobileSidebarOpen ? "minmax(250px, 86vw) 4px minmax(0, 1fr)" : "1fr 0 0"
    : intent.gridTemplateColumns;
  elements.app.dataset.sidebarCollapsed = String(intent.sidebarCollapsed);
  elements.app.dataset.detailsCollapsed = String(!intent.detailsOpen);
  elements.app.dataset.mobileSidebarOpen = String(intent.mobileSidebarOpen);
  elements.mobileMenu.hidden = !intent.mobileMenuVisible;
  elements.mobileMenu.setAttribute("aria-expanded", String(intent.mobileSidebarOpen));
  elements.mobileMenu.setAttribute("aria-label", intent.mobileSidebarOpen ? "关闭侧栏" : "打开侧栏");
}
