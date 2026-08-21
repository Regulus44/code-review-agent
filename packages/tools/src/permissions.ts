import type { ToolApprovalMode, ToolDefinition, ToolRiskLevel } from "@code-review-agent/contracts";

export interface PermissionEvaluation {
  readonly mode: ToolApprovalMode;
  readonly reason: string;
}

export interface PermissionPolicy {
  evaluate(definition: ToolDefinition): PermissionEvaluation;
}

export interface DefaultPermissionPolicyOptions {
  readonly networkMode?: ToolApprovalMode;
  readonly writeMode?: ToolApprovalMode;
  readonly executeMode?: ToolApprovalMode;
}

/** Default local policy: reads are automatic, writes/commands ask, network is denied. */
export class DefaultPermissionPolicy implements PermissionPolicy {
  private readonly options: Required<DefaultPermissionPolicyOptions>;

  constructor(options: DefaultPermissionPolicyOptions = {}) {
    this.options = {
      networkMode: options.networkMode ?? "deny",
      writeMode: options.writeMode ?? "ask",
      executeMode: options.executeMode ?? "ask",
    };
  }

  evaluate(definition: ToolDefinition): PermissionEvaluation {
    if (definition.approvalMode === "deny") return { mode: "deny", reason: "Tool definition denies execution" };
    if (definition.approvalMode === "auto" && definition.riskLevel === "read") return { mode: "auto", reason: "Read-only tool is automatically approved" };
    const mode = this.modeFor(definition.riskLevel);
    return { mode, reason: mode === "ask" ? `${definition.riskLevel} tool requires approval` : `${definition.riskLevel} tools are disabled by policy` };
  }

  private modeFor(risk: ToolRiskLevel): ToolApprovalMode {
    if (risk === "read") return "auto";
    if (risk === "write") return this.options.writeMode;
    if (risk === "execute") return this.options.executeMode;
    return this.options.networkMode;
  }
}
