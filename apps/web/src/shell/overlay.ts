export type ShellOverlayId = "workspace" | "settings" | "rename-session" | "session-menu" | "model-popover" | "mode-popover" | "reasoning-popover";

export interface ShellOverlayState {
  readonly open: ShellOverlayId | null;
}

export type ShellOverlayAction =
  | { readonly type: "open"; readonly overlay: ShellOverlayId }
  | { readonly type: "close"; readonly overlay?: ShellOverlayId }
  | { readonly type: "toggle"; readonly overlay: ShellOverlayId }
  | { readonly type: "escape" };

export interface ShellOverlayRenderIntent {
  readonly workspaceOpen: boolean;
  readonly settingsOpen: boolean;
  readonly renameSessionOpen: boolean;
  readonly sessionMenuOpen: boolean;
  readonly modelPopoverOpen: boolean;
  readonly modePopoverOpen: boolean;
  readonly reasoningPopoverOpen: boolean;
}

export function createShellOverlayState(): ShellOverlayState {
  return { open: null };
}

export function reduceShellOverlay(state: ShellOverlayState, action: ShellOverlayAction): ShellOverlayState {
  switch (action.type) {
    case "open":
      return { open: action.overlay };
    case "close":
      return action.overlay === undefined || state.open === action.overlay ? { open: null } : state;
    case "toggle":
      return { open: state.open === action.overlay ? null : action.overlay };
    case "escape":
      return { open: null };
  }
}

export function presentShellOverlay(state: ShellOverlayState): ShellOverlayRenderIntent {
  return {
    workspaceOpen: state.open === "workspace",
    settingsOpen: state.open === "settings",
    renameSessionOpen: state.open === "rename-session",
    sessionMenuOpen: state.open === "session-menu",
    modelPopoverOpen: state.open === "model-popover",
    modePopoverOpen: state.open === "mode-popover",
    reasoningPopoverOpen: state.open === "reasoning-popover",
  };
}
