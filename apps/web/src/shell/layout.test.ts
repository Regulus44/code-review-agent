import { describe, expect, it } from "vitest";
import { createShellLayoutState, presentShellLayout, reduceShellLayout, shellViewport } from "./layout.js";

describe("shell layout", () => {
  it("keeps desktop sidebar/details transitions independent", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "toggle-sidebar" });
    expect(presentShellLayout(state, "desktop").appClassName).toContain("sidebar-collapsed");
    state = reduceShellLayout(state, { type: "toggle-details" });
    const intent = presentShellLayout(state, "desktop");
    expect(intent.detailsOpen).toBe(true);
    expect(intent.appClassName).toContain("details-open");
  });

  it("clamps a resizable sidebar to the desktop bounds", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "set-sidebar-width", widthPx: 999 });
    expect(state.sidebarWidthPx).toBe(360);
    state = reduceShellLayout(state, { type: "set-sidebar-width", widthPx: 100 });
    expect(state.sidebarWidthPx).toBe(220);
    expect(presentShellLayout(state, "desktop").sidebarWidthPx).toBe(220);
  });

  it("opens the sidebar as a mobile overlay and closes it on desktop", () => {
    let state = createShellLayoutState();
    state = reduceShellLayout(state, { type: "open-mobile-sidebar" });
    expect(presentShellLayout(state, "mobile")).toMatchObject({ mobileSidebarOpen: true, detailsOpen: false });
    expect(presentShellLayout(state, "mobile").appClassName).toContain("mobile-sidebar-open");
    state = reduceShellLayout(state, { type: "set-viewport", viewport: "desktop" });
    expect(state.mobileSidebarOpen).toBe(false);
  });

  it("maps the responsive breakpoints deterministically", () => {
    expect(shellViewport(1200)).toBe("desktop");
    expect(shellViewport(900)).toBe("tablet");
    expect(shellViewport(600)).toBe("mobile");
  });
});
