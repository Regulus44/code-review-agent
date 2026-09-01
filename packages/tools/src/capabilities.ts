export type CapabilityName = "web" | "skill" | "subagent" | "workflow";

export interface CapabilityPolicy {
  readonly enabled: boolean;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxIterations?: number;
  readonly allowedTools?: readonly string[];
  readonly allowedHosts?: readonly string[];
}

export interface CapabilitySnapshot {
  readonly name: CapabilityName;
  readonly enabled: boolean;
  readonly limits: Readonly<Record<string, unknown>>;
}

export class CapabilityError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Feature gates and safety limits for Phase 3B.5 extensions. Disabled is the default for every extension. */
export class CapabilityRegistry {
  private readonly policies = new Map<CapabilityName, CapabilityPolicy>();

  constructor(initial: Partial<Record<CapabilityName, CapabilityPolicy>> = {}) {
    for (const name of ["web", "skill", "subagent", "workflow"] as const) this.policies.set(name, initial[name] ?? { enabled: false });
  }

  configure(name: CapabilityName, policy: CapabilityPolicy): void {
    this.policies.set(name, normalizePolicy(policy));
  }

  isEnabled(name: CapabilityName): boolean { return this.policies.get(name)?.enabled === true; }

  require(name: CapabilityName): CapabilityPolicy {
    const policy = this.policies.get(name) ?? { enabled: false };
    if (!policy.enabled) throw new CapabilityError("CAPABILITY_DISABLED", `Capability '${name}' is disabled.`);
    return policy;
  }

  snapshot(): readonly CapabilitySnapshot[] {
    return [...this.policies.entries()].map(([name, policy]) => ({ name, enabled: policy.enabled, limits: { ...(policy.maxBytes === undefined ? {} : { maxBytes: policy.maxBytes }), ...(policy.maxDepth === undefined ? {} : { maxDepth: policy.maxDepth }), ...(policy.maxIterations === undefined ? {} : { maxIterations: policy.maxIterations }), ...(policy.allowedTools === undefined ? {} : { allowedTools: [...policy.allowedTools] }), ...(policy.allowedHosts === undefined ? {} : { allowedHosts: [...policy.allowedHosts] }) } }));
  }

  authorizeSkill(text: string): { readonly text: string; readonly priority: "low"; readonly mayOverrideSafety: false } {
    const policy = this.require("skill");
    const maxBytes = policy.maxBytes ?? 32 * 1024;
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new CapabilityError("SKILL_TOO_LARGE", `Skill content exceeds ${maxBytes} bytes.`);
    return { text, priority: "low", mayOverrideSafety: false };
  }

  /** S0 trust/permission gate. Skill declarations can only reduce the host allowlist. */
  authorizeSkillInvocation(input: {
    readonly trust: SkillSourceTrust;
    readonly allowedTools?: readonly string[];
    readonly unknownProperties?: readonly string[];
  }): SkillPermissionAssessment {
    const policy = this.policies.get("skill") ?? { enabled: false };
    if (!policy.enabled) return { decision: "deny", effectiveAllowedTools: [], reason: "capability-disabled" };
    const unknown = [...new Set(input.unknownProperties ?? [])].sort();
    if (unknown.length > 0) return { decision: "ask", effectiveAllowedTools: [], reason: "unknown-properties", unknownProperties: unknown };
    if (input.trust === "remote" || input.trust === "unknown") return { decision: "ask", effectiveAllowedTools: [], reason: "untrusted-source" };
    const requested = [...new Set(input.allowedTools ?? [])];
    const effectiveAllowedTools = policy.allowedTools === undefined ? requested : requested.filter((tool) => policy.allowedTools!.includes(tool));
    return { decision: "allow", effectiveAllowedTools, reason: "allowlisted" };
  }

  /** Capability metadata for the S0 contract; model-facing SkillTool remains gated until S2. */
  skillCapability(providerCount = 0): SkillCapability {
    const policy = this.policies.get("skill") ?? { enabled: false };
    if (!policy.enabled) return { version: 1, configured: false, enabled: false, status: "deferred", reason: "Skill registry is available as an opt-in contract; model-facing SkillTool is deferred until S2.", modelToolExposed: false, providerCount };
    return { version: 1, configured: true, enabled: true, status: "available", reason: "Skill contract and registry are configured; model-facing SkillTool remains disabled until S2.", modelToolExposed: false, providerCount };
  }

  authorizeSubagent(parentDepth: number, requestedTools: readonly string[], requestedBudget = 0): { readonly depth: number; readonly tools: readonly string[]; readonly budget: number } {
    const policy = this.require("subagent");
    const maxDepth = policy.maxDepth ?? 1;
    if (!Number.isInteger(parentDepth) || parentDepth < 0 || parentDepth >= maxDepth) throw new CapabilityError("SUBAGENT_DEPTH_EXCEEDED", `Subagent depth ${parentDepth + 1} exceeds the configured limit ${maxDepth}.`);
    const allowed = policy.allowedTools === undefined ? requestedTools : requestedTools.filter((tool) => policy.allowedTools!.includes(tool));
    const budget = Math.max(0, requestedBudget);
    if (requestedBudget > 0 && policy.maxBytes !== undefined && requestedBudget > policy.maxBytes) throw new CapabilityError("SUBAGENT_BUDGET_EXCEEDED", "Requested subagent budget exceeds the configured limit.");
    return { depth: parentDepth + 1, tools: allowed, budget };
  }

  authorizeWorkflowStep(iteration: number): { readonly iteration: number; readonly maxIterations: number } {
    const policy = this.require("workflow");
    const maxIterations = policy.maxIterations ?? 10;
    if (!Number.isInteger(iteration) || iteration < 0 || iteration >= maxIterations) throw new CapabilityError("WORKFLOW_ITERATION_LIMIT", `Workflow iteration ${iteration + 1} exceeds the configured limit ${maxIterations}.`);
    return { iteration: iteration + 1, maxIterations };
  }

  authorizeWebUrl(rawUrl: string): URL {
    const policy = this.require("web");
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new CapabilityError("WEB_URL_INVALID", "Web URL is invalid."); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new CapabilityError("WEB_PROTOCOL_DENIED", "Only HTTP(S) URLs are allowed.");
    if (policy.allowedHosts !== undefined && !policy.allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new CapabilityError("WEB_HOST_DENIED", `Host is not in the configured allowlist: ${url.hostname}`);
    return url;
  }
}

function normalizePolicy(policy: CapabilityPolicy): CapabilityPolicy {
  return { enabled: policy.enabled === true, ...(policy.maxBytes === undefined ? {} : { maxBytes: Math.max(1, Math.floor(policy.maxBytes)) }), ...(policy.maxDepth === undefined ? {} : { maxDepth: Math.max(1, Math.floor(policy.maxDepth)) }), ...(policy.maxIterations === undefined ? {} : { maxIterations: Math.max(1, Math.floor(policy.maxIterations)) }), ...(policy.allowedTools === undefined ? {} : { allowedTools: [...new Set(policy.allowedTools)] }), ...(policy.allowedHosts === undefined ? {} : { allowedHosts: [...new Set(policy.allowedHosts.map((host) => host.toLowerCase().trim()).filter(Boolean))] }) };
}
import type { SkillCapability, SkillPermissionAssessment, SkillSourceTrust } from "@coding-agent/contracts";
