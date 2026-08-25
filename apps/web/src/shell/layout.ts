export type ShellViewport = "desktop" | "tablet" | "mobile";

export interface ShellLayoutState {
  readonly sidebar: "expanded" | "collapsed";
  readonly sidebarWidthPx: number;
  readonly details: "open" | "closed";
  readonly mobileSidebarOpen: boolean;
}

export type ShellLayoutAction =
  | { readonly type: "toggle-sidebar" }
  | { readonly type: "set-sidebar-width"; readonly widthPx: number }
  | { readonly type: "toggle-details" }
  | { readonly type: "close-details" }
  | { readonly type: "open-mobile-sidebar" }
  | { readonly type: "close-mobile-sidebar" }
  | { readonly type: "set-viewport"; readonly viewport: ShellViewport };

export interface ShellLayoutRenderIntent {
  readonly appClassName: string;
  readonly sidebarCollapsed: boolean;
  readonly sidebarWidthPx: number;
  readonly detailsOpen: boolean;
  readonly mobileSidebarOpen: boolean;
  readonly mobileMenuVisible: boolean;
  readonly detailsToggleVisible: boolean;
}

export function createShellLayoutState(): ShellLayoutState {
  return { sidebar: "expanded", sidebarWidthPx: 252, details: "closed", mobileSidebarOpen: false };
}

export function reduceShellLayout(state: ShellLayoutState, action: ShellLayoutAction): ShellLayoutState {
  switch (action.type) {
    case "toggle-sidebar":
      return { ...state, sidebar: state.sidebar === "collapsed" ? "expanded" : "collapsed", mobileSidebarOpen: false };
    case "set-sidebar-width":
      return { ...state, sidebarWidthPx: clampSidebarWidth(action.widthPx) };
    case "toggle-details":
      return { ...state, details: state.details === "open" ? "closed" : "open" };
    case "close-details":
      return { ...state, details: "closed" };
    case "open-mobile-sidebar":
      return { ...state, mobileSidebarOpen: true, sidebar: "expanded" };
    case "close-mobile-sidebar":
      return { ...state, mobileSidebarOpen: false };
    case "set-viewport":
      return action.viewport === "desktop" ? { ...state, mobileSidebarOpen: false } : state;
  }
}

export function presentShellLayout(state: ShellLayoutState, viewport: ShellViewport): ShellLayoutRenderIntent {
  const mobile = viewport !== "desktop";
  const classes = ["app-shell"];
  if (state.sidebar === "collapsed" && !state.mobileSidebarOpen) classes.push("sidebar-collapsed");
  if (state.details === "closed" || mobile) classes.push("details-collapsed");
  if (state.details === "open" && !mobile) classes.push("details-open");
  if (state.mobileSidebarOpen && mobile) classes.push("mobile-sidebar-open");
  return {
    appClassName: classes.join(" "),
    sidebarCollapsed: state.sidebar === "collapsed" && !state.mobileSidebarOpen,
    sidebarWidthPx: state.sidebarWidthPx,
    detailsOpen: state.details === "open" && !mobile,
    mobileSidebarOpen: state.mobileSidebarOpen && mobile,
    mobileMenuVisible: mobile,
    detailsToggleVisible: !mobile,
  };
}

export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 360;

export function clampSidebarWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return 252;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(widthPx)));
}

export function shellViewport(width: number): ShellViewport {
  if (width <= 600) return "mobile";
  if (width <= 900) return "tablet";
  return "desktop";
}
