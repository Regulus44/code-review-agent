import { describe, expect, it } from "vitest";
import { CapabilityError, CapabilityRegistry } from "./capabilities.js";

describe("CapabilityRegistry", () => {
  it("keeps optional Phase 3B.5 capabilities disabled by default", () => {
    const registry = new CapabilityRegistry();
    expect(registry.snapshot().every((item) => item.enabled === false)).toBe(true);
    expect(() => registry.require("web")).toThrowError(CapabilityError);
  });

  it("enforces low-priority skills, subagent depth, and workflow stop limits", () => {
    const registry = new CapabilityRegistry({
      skill: { enabled: true, maxBytes: 20 },
      subagent: { enabled: true, maxDepth: 1, allowedTools: ["read_file"] },
      workflow: { enabled: true, maxIterations: 2 },
    });
    expect(registry.authorizeSkill("safe guidance")).toMatchObject({ priority: "low", mayOverrideSafety: false });
    expect(registry.authorizeSubagent(0, ["read_file", "write_file"])).toMatchObject({ depth: 1, tools: ["read_file"] });
    expect(() => registry.authorizeSubagent(1, ["read_file"])).toThrowError(expect.objectContaining({ code: "SUBAGENT_DEPTH_EXCEEDED" }));
    expect(registry.authorizeWorkflowStep(0)).toMatchObject({ iteration: 1, maxIterations: 2 });
    expect(() => registry.authorizeWorkflowStep(2)).toThrowError(expect.objectContaining({ code: "WORKFLOW_ITERATION_LIMIT" }));
  });

  it("requires explicit HTTP(S) host policy for web capability", () => {
    const registry = new CapabilityRegistry({ web: { enabled: true, allowedHosts: ["example.com"] } });
    expect(registry.authorizeWebUrl("https://sub.example.com/docs").hostname).toBe("sub.example.com");
    expect(() => registry.authorizeWebUrl("file:///secret")).toThrowError(expect.objectContaining({ code: "WEB_PROTOCOL_DENIED" }));
    expect(() => registry.authorizeWebUrl("https://evil.example.net")).toThrowError(expect.objectContaining({ code: "WEB_HOST_DENIED" }));
  });

  it("keeps SkillTool hidden in S0 and asks for unknown or untrusted declarations", () => {
    const disabled = new CapabilityRegistry();
    expect(disabled.skillCapability()).toMatchObject({ status: "deferred", modelToolExposed: false });
    expect(disabled.authorizeSkillInvocation({ trust: "local" })).toMatchObject({ decision: "deny", reason: "capability-disabled" });
    const enabled = new CapabilityRegistry({ skill: { enabled: true, allowedTools: ["read_file"] } });
    expect(enabled.skillCapability(2)).toMatchObject({ status: "available", enabled: true, providerCount: 2, modelToolExposed: false });
    expect(enabled.authorizeSkillInvocation({ trust: "local", unknownProperties: ["shell"] })).toMatchObject({ decision: "ask" });
    expect(enabled.authorizeSkillInvocation({ trust: "remote" })).toMatchObject({ decision: "ask", reason: "untrusted-source" });
    expect(enabled.authorizeSkillInvocation({ trust: "local", allowedTools: ["read_file", "write_file"] })).toMatchObject({ decision: "allow", effectiveAllowedTools: ["read_file"] });
  });
});
