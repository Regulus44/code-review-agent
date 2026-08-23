import { describe, expect, it } from "vitest";
import { createShellOverlayState, presentShellOverlay, reduceShellOverlay } from "./overlay.js";

describe("shell overlay state", () => {
  it("keeps modal and popover surfaces mutually exclusive", () => {
    let state = createShellOverlayState();
    state = reduceShellOverlay(state, { type: "open", overlay: "workspace" });
    state = reduceShellOverlay(state, { type: "open", overlay: "settings" });
    expect(presentShellOverlay(state)).toMatchObject({ workspaceOpen: false, settingsOpen: true });
    state = reduceShellOverlay(state, { type: "toggle", overlay: "settings" });
    expect(state).toEqual({ open: null });
    state = reduceShellOverlay(state, { type: "open", overlay: "rename-session" });
    expect(presentShellOverlay(state).renameSessionOpen).toBe(true);
  });

  it("closes only the requested overlay and supports escape", () => {
    let state = reduceShellOverlay(createShellOverlayState(), { type: "open", overlay: "session-menu" });
    expect(reduceShellOverlay(state, { type: "close", overlay: "settings" })).toEqual(state);
    state = reduceShellOverlay(state, { type: "escape" });
    expect(state).toEqual({ open: null });
  });
});
