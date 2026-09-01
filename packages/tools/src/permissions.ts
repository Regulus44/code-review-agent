import type { ToolApprovalMode, ToolDefinition, ToolRiskLevel } from "@coding-agent/contracts";

export interface PermissionEvaluation {
  readonly mode: ToolApprovalMode;
  readonly reason: string;
}

export interface PermissionPolicy {
  evaluate(definition: ToolDefinition): PermissionEvaluation;
  isVisible?(definition: ToolDefinition): boolean;
}

export type PermissionPreset = "read-only" | "workspace-write" | "ask-on-write" | "ask-on-execute" | "workspace-full-access" | "danger-full-access";

export interface DefaultPermissionPolicyOptions {
  readonly preset?: PermissionPreset;
  readonly networkMode?: ToolApprovalMode;
  readonly writeMode?: ToolApprovalMode;
  readonly executeMode?: ToolApprovalMode;
}

/** Default local policy: reads are automatic, writes/commands ask, network is denied. */
export class DefaultPermissionPolicy implements PermissionPolicy {
  private readonly options: Required<DefaultPermissionPolicyOptions>;
  readonly preset: PermissionPreset;

  constructor(options: DefaultPermissionPolicyOptions = {}) {
    this.preset = options.preset ?? "ask-on-write";
    const defaults = presetModes(this.preset);
    this.options = {
      preset: this.preset,
      networkMode: options.networkMode ?? defaults.networkMode,
      writeMode: options.writeMode ?? defaults.writeMode,
      executeMode: options.executeMode ?? defaults.executeMode,
    };
  }

  evaluate(definition: ToolDefinition): PermissionEvaluation {
    if (definition.approvalMode === "deny") return { mode: "deny", reason: "Tool definition denies execution" };
    if (definition.approvalMode === "auto" && definition.riskLevel === "read") return { mode: "auto", reason: "Read-only tool is automatically approved" };
    const mode = this.modeFor(definition.riskLevel);
    return { mode, reason: mode === "ask" ? `${definition.riskLevel} tool requires approval` : `${definition.riskLevel} tools are disabled by policy` };
  }

  isVisible(definition: ToolDefinition): boolean {
    return this.evaluate(definition).mode !== "deny";
  }

  private modeFor(risk: ToolRiskLevel): ToolApprovalMode {
    if (risk === "read") return "auto";
    if (risk === "write") return this.options.writeMode;
    if (risk === "execute") return this.options.executeMode;
    return this.options.networkMode;
  }
}

function presetModes(preset: PermissionPreset): { readonly networkMode: ToolApprovalMode; readonly writeMode: ToolApprovalMode; readonly executeMode: ToolApprovalMode } {
  if (preset === "read-only") return { networkMode: "deny", writeMode: "deny", executeMode: "deny" };
  if (preset === "workspace-write") return { networkMode: "deny", writeMode: "auto", executeMode: "ask" };
  if (preset === "ask-on-execute") return { networkMode: "ask", writeMode: "auto", executeMode: "ask" };
  if (preset === "workspace-full-access" || preset === "danger-full-access") return { networkMode: "auto", writeMode: "auto", executeMode: "auto" };
  return { networkMode: "deny", writeMode: "ask", executeMode: "ask" };
}
