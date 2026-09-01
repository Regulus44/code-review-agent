import type { PermissionPreset, SessionProjection, MemoryCapability } from "@coding-agent/contracts";
import type { AttachmentCapability, CodeModeCapability, ContextCapability, LspCapability, ModelCatalogResponse, McpServerView, PluginsCapability, ProductizationCapabilityResponse, ToolCatalogEntry, PluginInventorySnapshot } from "../client/api.js";
import type { ProviderCatalogGroup } from "@coding-agent/contracts";

export interface SettingsCapability {
  readonly key: string;
  readonly label: string;
  readonly status: "available" | "configured" | "deferred" | "unavailable" | "disabled";
  readonly detail: string;
}

export interface SettingsRenderIntent {
  readonly workspaceRoot: string;
  readonly sessionStatus: string;
  readonly permissionPreset: PermissionPreset;
  readonly permissionLabel: string;
  readonly permissionDescription: string;
  readonly model: {
    readonly status: "loading" | "ready" | "error";
    readonly provider: string;
    readonly current: string;
    readonly configured: boolean;
    readonly available: readonly string[];
    readonly providers: readonly ProviderCatalogGroup[];
    readonly providerErrors: readonly { readonly provider: string; readonly error: string }[];
    readonly error?: string;
    readonly receipt?: string;
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
  /** Read-only plugin loader inventory; absent when the host has no plugin runtime. */
  readonly pluginsInventory?: PluginInventorySnapshot;
  readonly capabilities: readonly SettingsCapability[];
}

export interface SettingsPresenterOptions {
  readonly hasSubagentRuntime?: boolean;
  readonly a2aStatus?: "deferred" | "available" | "unavailable";
  readonly attachmentCapability?: AttachmentCapability;
  readonly contextCapability?: ContextCapability;
  readonly codeModeCapability?: CodeModeCapability;
  readonly lspCapability?: LspCapability;
  readonly pluginsCapability?: PluginsCapability;
  readonly productizationCapability?: ProductizationCapabilityResponse;
  readonly memoryCapability?: MemoryCapability;
  readonly modelState?: {
    readonly status: "loading" | "ready" | "error";
    readonly error?: string;
    readonly receipt?: string;
  };
}

const permissionDescriptions: Record<PermissionPreset, { readonly label: string; readonly description: string }> = {
  "read-only": { label: "只读", description: "仅查看文件和历史，不修改工作区。" },
  "workspace-write": { label: "工作区写入", description: "允许在选定工作区内写入，无需逐次批准。" },
  "ask-on-write": { label: "写入前询问", description: "读取自动执行；写入或执行操作前请求批准。" },
  "ask-on-execute": { label: "执行前询问", description: "允许文件修改；运行命令前请求批准。" },
  "workspace-full-access": { label: "工作区完全访问", description: "启用的工具无需批准即可运行，但权限严格限制在选定工作区内。" },
  "danger-full-access": { label: "完全访问", description: "启用的工具无需交互式批准即可运行。" },
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
  const context = options.contextCapability;
  const codeMode = options.codeModeCapability;
  const lsp = options.lspCapability;
  const plugins = options.pluginsCapability;
  const productization = options.productizationCapability;
  const memory = options.memoryCapability ?? context?.memory;
  const modelState = options.modelState ?? { status: models === undefined ? "loading" : "ready" };
  const codeModeNetworkDetail = codeMode?.limits?.networkEnforcement === "process-policy"
    ? `Network deny-by-default is enforced by the child process policy; OS isolation: ${codeMode.limits.osNetworkIsolation === true ? "enabled" : "unavailable"}.`
    : codeMode?.limits?.networkEnforcement === "os-required"
      ? "OS-level network isolation is required by policy."
      : "Network enforcement metadata is unavailable.";
  const capabilities: SettingsCapability[] = [
    { key: "coding-tools", label: "编码工具", status: tools.length > 0 ? "available" : "unavailable", detail: `当前目录中有 ${tools.length} 个经主机批准的工具。` },
    { key: "mcp", label: "MCP", status: mcpServers.length > 0 ? "configured" : "available", detail: mcpServers.length > 0 ? `${connected}/${mcpServers.length} 个已配置服务已连接。` : "尚未配置 MCP 服务。" },
    { key: "subagent", label: "内部子智能体", status: options.hasSubagentRuntime === false ? "unavailable" : "available", detail: options.hasSubagentRuntime === false ? "主机未提供内部子智能体服务。" : "父/子任务和会话控制可用。" },
    { key: "attachments", label: "附件", status: attachment === undefined ? "unavailable" : attachment.enabled ? "available" : "unavailable", detail: attachment === undefined ? "主机未提供附件能力元数据。" : attachment.enabled ? `文件上限 ${Math.floor(attachment.maxBytes / 1024)} KiB；图片${attachment.imagesEnabled ? "已启用" : "已禁用"}。` : attachment.reason ?? "附件已被主机策略禁用。" },
    { key: "context-compaction", label: "上下文压缩", status: context === undefined ? "unavailable" : context.enabled ? (context.configured ? "configured" : "available") : "unavailable", detail: context === undefined ? "主机未提供上下文预算元数据。" : !context.enabled ? "上下文压缩已被主机禁用。" : context.budget?.maxTokens === undefined ? "上下文压缩已启用，但提供方上下文预算未知。" : `压缩预算：${context.budget.maxTokens} tokens。` },
    { key: "context-collapse", label: "上下文折叠", status: context?.collapse?.status ?? "unavailable", detail: context?.collapse?.reason ?? "主机未提供上下文折叠能力元数据。" },
    { key: "session-memory", label: "会话记忆", status: memory?.session.status === "available" ? "available" : memory?.session.status === "disabled" ? "deferred" : "unavailable", detail: memory?.session.reason ?? (memory === undefined ? "主机未提供 Memory 能力元数据。" : "Session Memory 已连接。") },
    { key: "project-memory", label: "项目记忆", status: memory?.project.status === "available" ? "available" : memory?.project.status === "disabled" ? "deferred" : "unavailable", detail: memory?.project.reason ?? (memory === undefined ? "主机未提供 Memory 能力元数据。" : "Project Memory 已连接。") },
    { key: "code-mode", label: "代码模式", status: codeMode === undefined ? "unavailable" : codeMode.enabled ? "configured" : codeMode.configured ? "unavailable" : "unavailable", detail: codeMode === undefined ? "主机未提供代码模式策略元数据。" : codeMode.enabled ? `沙箱已启用；输出和运行时限制由主机控制。${codeModeNetworkDetail}` : codeMode.configured ? "代码模式已配置，但被策略禁用。" : "代码模式未配置。" },
    { key: "lsp", label: "语言服务器", status: lsp === undefined ? "unavailable" : lsp.configured ? "configured" : "available", detail: lsp === undefined ? "主机未提供语言服务器元数据。" : lsp.configured ? `${lsp.servers.length} 个已配置服务器：${lsp.servers.join("、")}。` : "尚未配置语言服务器。" },
    { key: "plugins", label: "插件", status: plugins?.status ?? "unavailable", detail: plugins === undefined ? "主机未提供插件运行时元数据。" : plugins.reason },
    { key: "productization", label: "产品化", status: productization?.status ?? "unavailable", detail: productization === undefined ? "主机未提供产品化就绪元数据。" : productization.reason },
    { key: "a2a", label: "A2A 互操作", status: a2aStatus, detail: a2aStatus === "deferred" ? "等待接受外部智能体互操作场景后再启用。" : a2aStatus === "available" ? "外部智能体适配器已启用。" : "外部智能体适配器不可用。" },
  ];
  return {
    workspaceRoot: session?.workspaceRoot ?? ".",
    sessionStatus: session?.status ?? "not-created",
    permissionPreset,
    permissionLabel: permission.label,
    permissionDescription: permission.description,
    model: {
      status: modelState.status,
      provider: models?.provider ?? "unknown",
      current: models?.current ?? "unknown",
      configured: models?.configured === true,
      available: (models?.models ?? []).slice(0, 32),
      providers: (models?.providers ?? []).slice(0, 32),
      providerErrors: (models?.providers ?? []).filter((group) => group.status === "failed" && group.error !== undefined).map((group) => ({ provider: group.provider, error: group.error! })).slice(0, 32),
      ...(modelState.error ? { error: modelState.error } : {}),
      ...(modelState.receipt ? { receipt: modelState.receipt } : {}),
    },
    tools: { total: tools.length, builtin, mcp, riskCounts },
    mcp: { configured: mcpServers.length, connected, attention },
    ...(plugins?.inventory === undefined ? {} : { pluginsInventory: plugins.inventory }),
    capabilities,
  };
}
