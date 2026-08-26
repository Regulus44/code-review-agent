import type { ModelRequest } from "@code-review-agent/contracts";
import { describe, expect, it } from "vitest";
import { classifyProviderContextError, ContextRecoveryGuard, fingerprintModelRequest, isReactiveContextError } from "./recovery.js";

describe("context recovery", () => {
  it("classifies prompt-too-long, media, pairing and schema failures", () => {
    expect(classifyProviderContextError(Object.assign(new Error("context_length_exceeded"), { status: 400, code: "context_length_exceeded" })).errorClass).toBe("prompt_too_long");
    expect(classifyProviderContextError(Object.assign(new Error("image payload too large"), { status: 413 })).errorClass).toBe("media_too_large");
    expect(classifyProviderContextError(new Error("tool_result is missing a matching tool_call")).errorClass).toBe("tool_pairing");
    expect(classifyProviderContextError(new Error("invalid request schema")).errorClass).toBe("schema");
    expect(isReactiveContextError(Object.assign(new Error("HTTP 413"), { status: 413 }))).toBe(true);
  });

  it("fingerprints equivalent requests deterministically without purpose drift", () => {
    const left: ModelRequest = { purpose: "agent", messages: [{ role: "user", content: "hello" }], tools: [{ name: "read", description: "Read", parameters: { type: "object" } }] };
    const right: ModelRequest = { tools: [{ parameters: { type: "object" }, description: "Read", name: "read" }], messages: [{ content: "hello", role: "user" }], purpose: "agent" };
    expect(fingerprintModelRequest(left)).toBe(fingerprintModelRequest(right));
    expect(fingerprintModelRequest(left)).toMatch(/^ctxreq_[0-9a-f]{16}$/u);
  });

  it("limits reactive attempts and opens a circuit after bounded failures", () => {
    const guard = new ContextRecoveryGuard(1, 3);
    expect(guard.beginReactive()).toBe(1);
    expect(guard.beginReactive()).toBeUndefined();
    expect(guard.recordCompactionFailure()).toBe(false);
    expect(guard.recordCompactionFailure()).toBe(false);
    expect(guard.recordCompactionFailure()).toBe(true);
    expect(guard.snapshot()).toMatchObject({ reactiveAttempts: 1, consecutiveCompactionFailures: 3, circuitOpen: true, attemptedModules: ["compact", "reactive_compact"] });
  });
});
