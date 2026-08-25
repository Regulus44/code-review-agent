import { describe, expect, it } from "vitest";
import { createShellLayoutState, presentShellLayout, reduceShellLayout, shellViewport } from "./layout.js";

describe("shell layout", () => {
  it("keeps desktop sidebar/details transitions independent", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "toggle-sidebar" });
    expect(presentShellLayout(state, "desktop").appClassName).toContain("sidebar-collapsed");
    state = reduceShellLayout(state, { type: "toggle-details" });
    const intent = presentShellLayout(state, "desktop");
    expect(intent.mobile).toBe(false);
    expect(intent.detailsOpen).toBe(true);
    expect(intent.appClassName).toContain("details-open");
  });

  it("clamps a resizable sidebar to the desktop bounds", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "set-sidebar-width", widthPx: 999 });
    expect(state.sidebarWidthPx).toBe(420);
    state = reduceShellLayout(state, { type: "set-sidebar-width", widthPx: 100 });
    expect(state.sidebarWidthPx).toBe(264);
    expect(presentShellLayout(state, "desktop").sidebarWidthPx).toBe(264);
  });

  it("keeps details width independent and clamps it to the DSH bounds", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "toggle-details" });
    expect(state.detailsWidthPx).toBe(360);
    state = reduceShellLayout(state, { type: "set-details-width", widthPx: 999 });
    expect(state.detailsWidthPx).toBe(520);
    state = reduceShellLayout(state, { type: "close-details" });
    expect(state.detailsWidthPx).toBe(0);
  });

  it("auto-collapses narrow sidebar without overwriting the width preference", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "set-sidebar-width", widthPx: 400 });
    state = reduceShellLayout(state, { type: "set-viewport", viewport: "tablet" });
    expect(state.narrow).toBe(true);
    expect(state.narrowExpanded).toBe(false);
    expect(presentShellLayout(state, "tablet", 980).renderedColumns.sidebar).toBe(56);
    state = reduceShellLayout(state, { type: "toggle-sidebar" });
    expect(state.narrowExpanded).toBe(true);
    expect(presentShellLayout(state, "tablet", 980).renderedColumns.sidebar).toBe(400);
    state = reduceShellLayout(state, { type: "set-viewport", viewport: "desktop" });
    expect(state.narrow).toBe(false);
    expect(state.sidebarWidthPx).toBe(400);
  });

  it("opens the sidebar as a mobile overlay and closes it on desktop", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "open-mobile-sidebar" });
    expect(presentShellLayout(state, "mobile")).toMatchObject({ mobile: true, mobileSidebarOpen: true, detailsOpen: false });
    expect(presentShellLayout(state, "mobile").appClassName).toContain("mobile-sidebar-open");
    state = reduceShellLayout(state, { type: "set-viewport", viewport: "desktop" });
    expect(state.mobileSidebarOpen).toBe(false);
  });

  it("maps the responsive breakpoints deterministically", () => {
    expect(shellViewport(1200)).toBe("desktop");
    expect(shellViewport(900)).toBe("tablet");
    expect(shellViewport(600)).toBe("mobile");
    expect(shellViewport(1024)).toBe("desktop");
  });

  it("applies the fixed DSH concession chain", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "toggle-details" });
    expect(presentShellLayout(state, "desktop", 1250).renderedColumns).toEqual({ sidebar: 280, center: 640, details: 330 });
    expect(presentShellLayout(state, "desktop", 1210).renderedColumns).toEqual({ sidebar: 280, center: 930, details: 0 });
  });
});
