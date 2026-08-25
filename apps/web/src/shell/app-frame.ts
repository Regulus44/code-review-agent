import type { ShellLayoutRenderIntent } from "./layout.js";

/** The small DOM surface owned by the physical three-column Shell frame. */
export interface ShellFrameElements {
  readonly app: HTMLElement;
  readonly mobileMenu: HTMLButtonElement;
  readonly sidebarResizer?: HTMLElement;
}

/** Resolve the frame-owned elements without taking ownership of Conversation or Details content. */
export function mountShellFrame(root: ParentNode): ShellFrameElements | undefined {
  const app = root.querySelector<HTMLElement>("#app");
  const mobileMenu = root.querySelector<HTMLButtonElement>("#mobile-menu");
  if (app === null || mobileMenu === null) return undefined;
  const sidebarResizer = root.querySelector<HTMLElement>("#sidebar-resizer") ?? undefined;
  return { app, mobileMenu, ...(sidebarResizer === undefined ? {} : { sidebarResizer }) };
}

/** Apply the typed layout intent to the frame-owned DOM only. */
export function applyShellFrame(elements: ShellFrameElements, intent: ShellLayoutRenderIntent): void {
  elements.app.className = intent.appClassName;
  elements.app.style.setProperty("--sidebar-width", `${intent.sidebarWidthPx}px`);
  elements.mobileMenu.hidden = !intent.mobileMenuVisible;
  elements.mobileMenu.setAttribute("aria-expanded", String(intent.mobileSidebarOpen));
  elements.mobileMenu.setAttribute("aria-label", intent.mobileSidebarOpen ? "Close sidebar" : "Open sidebar");
}
