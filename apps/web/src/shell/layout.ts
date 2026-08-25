export type ShellViewport = "desktop" | "tablet" | "mobile";

import {
  clampWidth,
  computeShellColumns,
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "./columns.js";
import type { ShellColumns } from "./columns.js";

export interface ShellLayoutState {
  readonly sidebar: "expanded" | "collapsed";
  readonly sidebarWidthPx: number;
  readonly details: "open" | "closed";
  readonly detailsWidthPx: number;
  readonly narrow: boolean;
  readonly narrowExpanded: boolean;
  readonly mobileSidebarOpen: boolean;
}

export type ShellLayoutAction =
  | { readonly type: "toggle-sidebar" }
  | { readonly type: "set-sidebar-width"; readonly widthPx: number }
  | { readonly type: "set-details-width"; readonly widthPx: number }
  | { readonly type: "toggle-details" }
  | { readonly type: "close-details" }
  | { readonly type: "open-mobile-sidebar" }
  | { readonly type: "close-mobile-sidebar" }
  | { readonly type: "set-viewport"; readonly viewport: ShellViewport };

export interface ShellLayoutRenderIntent {
  readonly appClassName: string;
  readonly mobile: boolean;
  readonly sidebarCollapsed: boolean;
  readonly sidebarWidthPx: number;
  readonly detailsWidthPx: number;
  readonly renderedColumns: ShellColumns;
  readonly gridTemplateColumns: string;
  readonly detailsOpen: boolean;
  readonly mobileSidebarOpen: boolean;
  readonly mobileMenuVisible: boolean;
  readonly detailsToggleVisible: boolean;
}

export function createShellLayoutState(): ShellLayoutState {
  return {
    sidebar: "expanded",
    sidebarWidthPx: SIDEBAR_DEFAULT,
    details: "closed",
    detailsWidthPx: 0,
    narrow: false,
    narrowExpanded: false,
    mobileSidebarOpen: false,
  };
}

export function reduceShellLayout(state: ShellLayoutState, action: ShellLayoutAction): ShellLayoutState {
  switch (action.type) {
    case "toggle-sidebar":
      if (state.narrow) {
        return { ...state, narrowExpanded: !state.narrowExpanded, mobileSidebarOpen: false };
      }
      return { ...state, sidebar: state.sidebar === "collapsed" ? "expanded" : "collapsed", mobileSidebarOpen: false };
    case "set-sidebar-width":
      return { ...state, sidebarWidthPx: clampSidebarWidth(action.widthPx) };
    case "set-details-width":
      return { ...state, detailsWidthPx: clampDetailsWidth(action.widthPx), details: "open" };
    case "toggle-details":
      return state.details === "open"
        ? { ...state, details: "closed", detailsWidthPx: 0 }
        : { ...state, details: "open", detailsWidthPx: state.detailsWidthPx || DETAILS_DEFAULT };
    case "close-details":
      return { ...state, details: "closed", detailsWidthPx: 0 };
    case "open-mobile-sidebar":
      return { ...state, mobileSidebarOpen: true, sidebar: "expanded" };
    case "close-mobile-sidebar":
      return { ...state, mobileSidebarOpen: false };
    case "set-viewport":
      if (action.viewport === "desktop") {
        return { ...state, narrow: false, narrowExpanded: false, mobileSidebarOpen: false };
      }
      return state.narrow
        ? { ...state, mobileSidebarOpen: false }
        : { ...state, narrow: true, narrowExpanded: false, mobileSidebarOpen: false };
  }
}

export function presentShellLayout(
  state: ShellLayoutState,
  viewport: ShellViewport,
  frameWidthPx = viewport === "desktop" ? 1440 : viewport === "tablet" ? 900 : 600,
): ShellLayoutRenderIntent {
  const mobile = viewport !== "desktop";
  const narrow = viewport !== "desktop";
  const sidebarCollapsed = narrow ? !state.narrowExpanded : state.sidebar === "collapsed";
  const sidebarPreference = sidebarCollapsed
    ? 0
    : state.sidebar === "collapsed" ? SIDEBAR_DEFAULT : state.sidebarWidthPx;
  const detailsOpen = state.details === "open" && !mobile;
  const renderedColumns = computeShellColumns(frameWidthPx, sidebarPreference, detailsOpen ? state.detailsWidthPx : 0);
  const classes = ["app-shell"];
  if (sidebarCollapsed && !state.mobileSidebarOpen) classes.push("sidebar-collapsed");
  if (renderedColumns.details === 0) classes.push("details-collapsed");
  if (renderedColumns.details > 0) classes.push("details-open");
  if (state.mobileSidebarOpen && mobile) classes.push("mobile-sidebar-open");
  return {
    appClassName: classes.join(" "),
    mobile,
    sidebarCollapsed: sidebarCollapsed && !state.mobileSidebarOpen,
    sidebarWidthPx: state.sidebarWidthPx,
    detailsWidthPx: state.detailsWidthPx,
    renderedColumns,
    gridTemplateColumns: `${renderedColumns.sidebar}px minmax(0, 1fr) ${renderedColumns.details}px`,
    detailsOpen: renderedColumns.details > 0,
    mobileSidebarOpen: state.mobileSidebarOpen && mobile,
    mobileMenuVisible: mobile,
    detailsToggleVisible: !mobile,
  };
}

export const SIDEBAR_WIDTH_MIN = SIDEBAR_MIN;
export const SIDEBAR_WIDTH_MAX = SIDEBAR_MAX;

export function clampSidebarWidth(widthPx: number): number {
  return clampWidth(widthPx, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
}

export function clampDetailsWidth(widthPx: number): number {
  return clampWidth(widthPx, DETAILS_MIN, DETAILS_MAX);
}

export function shellViewport(width: number): ShellViewport {
  if (width <= 600) return "mobile";
  if (width < SIDEBAR_AUTO_COLLAPSE) return "tablet";
  return "desktop";
}
