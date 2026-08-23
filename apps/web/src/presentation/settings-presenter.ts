import type { PermissionPreset, SessionProjection } from "@code-review-agent/contracts";
import type { AttachmentCapability, ModelCatalogResponse, McpServerView, ToolCatalogEntry } from "../client/api.js";

export interface SettingsCapability {
  readonly key: string;
  readonly label: string;
  readonly status: "available" | "configured" | "deferred" | "unavailable";
  readonly detail: string;
}

export interface SettingsRenderIntent {
  readonly workspaceRoot: string;
  readonly sessionStatus: string;
  readonly permissionPreset: PermissionPreset;
  readonly permissionLabel: string;
  readonly permissionDescription: string;
  readonly model: {
    readonly provider: string;
    readonly current: string;
    readonly configured: boolean;
    readonly available: readonly string[];
  };
  readonly tools: {
    readonly total: number;
    readonly builtin: number;
    readonly mcp: number;
    readonly riskCounts: Readonly<Record<"read" | "write" | "execute" | "network", number>>;
  };
  readonly mcp: {
    readonly configured: number;
    readonly connected: number;
    readonly attention: number;
  };
  readonly capabilities: readonly SettingsCapability[];
}

export interface SettingsPresenterOptions {
  readonly hasSubagentRuntime?: boolean;
  readonly a2aStatus?: "deferred" | "available" | "unavailable";
  readonly attachmentCapability?: AttachmentCapability;
}

const permissionDescriptions: Record<PermissionPreset, { readonly label: string; readonly description: string }> = {
  "read-only": { label: "Read only", description: "Inspect files and history without changing the workspace." },
  "workspace-write": { label: "Workspace write", description: "Write inside the selected workspace without per-call approval." },
  "ask-on-write": { label: "Ask on write", description: "Read automatically; request approval before writes or execution." },
  "ask-on-execute": { label: "Ask on execute", description: "Allow file changes and request approval before commands run." },
  "danger-full-access": { label: "Full access", description: "Run enabled tools without interactive approval." },
};

/**
 * Build a bounded, host-backed settings view. This presenter only summarizes
 * existing projections/catalogs; it never infers capability from UI state.
 */
export function presentSettings(
  session: SessionProjection | undefined,
  models: ModelCatalogResponse | undefined,
  tools: readonly ToolCatalogEntry[],
  mcpServers: readonly McpServerView[],
  options: SettingsPresenterOptions = {},
): SettingsRenderIntent {
  const permissionPreset = session?.permissionPreset ?? "ask-on-write";
  const permission = permissionDescriptions[permissionPreset];
  const riskCounts = { read: 0, write: 0, execute: 0, network: 0 };
  let builtin = 0;
  let mcp = 0;
  for (const tool of tools) {
    riskCounts[tool.riskLevel] += 1;
    if (tool.source.kind === "mcp") mcp += 1;
    else builtin += 1;
  }
  const connected = mcpServers.filter((server) => server.status === "connected").length;
  const attention = mcpServers.filter((server) => ["disabled", "failed", "needs_auth"].includes(String(server.status))).length;
  const a2aStatus = options.a2aStatus ?? "deferred";
  const attachment = options.attachmentCapability;
  const capabilities: SettingsCapability[] = [
    { key: "coding-tools", label: "Coding tools", status: tools.length > 0 ? "available" : "unavailable", detail: `${tools.length} host-approved tool${tools.length === 1 ? "" : "s"} in the current catalog.` },
    { key: "mcp", label: "MCP", status: mcpServers.length > 0 ? "configured" : "available", detail: mcpServers.length > 0 ? `${connected}/${mcpServers.length} configured server${mcpServers.length === 1 ? "" : "s"} connected.` : "No MCP server is configured." },
    { key: "subagent", label: "Internal subagents", status: options.hasSubagentRuntime === false ? "unavailable" : "available", detail: options.hasSubagentRuntime === false ? "The host did not expose the internal Subagent service." : "Parent/child Task and Session controls are available." },
    { key: "attachments", label: "Attachments", status: attachment === undefined ? "unavailable" : attachment.enabled ? "available" : "unavailable", detail: attachment === undefined ? "The host did not expose attachment capability metadata." : attachment.enabled ? `Files up to ${Math.floor(attachment.maxBytes / 1024)} KiB; images ${attachment.imagesEnabled ? "enabled" : "disabled"}.` : attachment.reason ?? "Attachments are disabled by the host policy." },
    { key: "a2a", label: "A2A interoperability", status: a2aStatus, detail: a2aStatus === "deferred" ? "Deferred until an external Agent interoperability scenario is accepted." : a2aStatus === "available" ? "External Agent adapter is enabled." : "External Agent adapter is unavailable." },
  ];
  return {
    workspaceRoot: session?.workspaceRoot ?? ".",
    sessionStatus: session?.status ?? "not-created",
    permissionPreset,
    permissionLabel: permission.label,
    permissionDescription: permission.description,
    model: {
      provider: models?.provider ?? "unknown",
      current: models?.current ?? "unknown",
      configured: models?.configured === true,
      available: (models?.models ?? []).slice(0, 32),
    },
    tools: { total: tools.length, builtin, mcp, riskCounts },
    mcp: { configured: mcpServers.length, connected, attention },
    capabilities,
  };
}
