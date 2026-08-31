/**
 * Low-frequency sidebar attention projection.
 *
 * The sidebar only receives a compact signal. Full task/MCP/request details
 * remain in the Details panel, which is the browser projection for those
 * domains and not a second source of truth.
 */
export type SidebarAttentionGroup = "requests" | "planning" | "integrations";

export interface SidebarAttentionInput {
  readonly pendingInteractions?: number;
  readonly pendingPermissions?: number;
  readonly runningChildren?: number;
  readonly mcpFailures?: number;
}

export interface SidebarAttentionPresentation {
  readonly visible: boolean;
  readonly targetGroup?: SidebarAttentionGroup;
  readonly count: number;
  readonly label: string;
  readonly ariaLabel: string;
}

function count(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : 0;
}

/**
 * Pick one actionable target for the single sidebar attention indicator.
 * Requests take priority over running child tasks, followed by MCP failures,
 * so a user decision is never hidden behind a lower-severity notification.
 */
export function presentSidebarAttention(input: SidebarAttentionInput = {}): SidebarAttentionPresentation {
  const pending = count(input.pendingInteractions) + count(input.pendingPermissions);
  const runningChildren = count(input.runningChildren);
  const mcpFailures = count(input.mcpFailures);

  if (pending > 0) {
    return {
      visible: true,
      targetGroup: "requests",
      count: pending,
      label: "Needs attention",
      ariaLabel: `Open details: ${pending} pending request${pending === 1 ? "" : "s"}`,
    };
  }
  if (runningChildren > 0) {
    return {
      visible: true,
      targetGroup: "planning",
      count: runningChildren,
      label: "Child task running",
      ariaLabel: `Open details: ${runningChildren} child task${runningChildren === 1 ? "" : "s"} running`,
    };
  }
  if (mcpFailures > 0) {
    return {
      visible: true,
      targetGroup: "integrations",
      count: mcpFailures,
      label: "Integration attention",
      ariaLabel: `Open details: ${mcpFailures} MCP integration${mcpFailures === 1 ? "" : "s"} need attention`,
    };
  }
  return {
    visible: false,
    count: 0,
    label: "",
    ariaLabel: "No pending attention",
  };
}
