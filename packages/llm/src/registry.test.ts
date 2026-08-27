import { describe, expect, it } from "vitest";
import { EchoChatModel } from "./index.js";
import { ModelProtocolRegistry, ModelProtocolRegistryError } from "./registry.js";

describe("ModelProtocolRegistry", () => {
  it("registers, creates, and releases an adapter", () => {
    const registry = new ModelProtocolRegistry();
    const registration = registry.register({ protocol: "fixture", createModel: () => new EchoChatModel() });

    expect(registry.protocols()).toEqual(["fixture"]);
    expect(registry.create("fixture", { model: "fixture-model" })).toBeInstanceOf(EchoChatModel);

    registration.dispose();
    registration.dispose();
    expect(registry.protocols()).toEqual([]);
    expect(errorCode(() => registry.get("fixture"))).toBe("MODEL_PROTOCOL_UNAVAILABLE");
  });

  it("rejects duplicate or non-canonical protocol registrations without replacing the active adapter", () => {
    const registry = new ModelProtocolRegistry();
    const original = { protocol: "fixture", createModel: () => new EchoChatModel() };
    registry.register(original);

    expect(errorCode(() => registry.register({ protocol: "fixture", createModel: () => new EchoChatModel() }))).toBe("MODEL_PROTOCOL_DUPLICATE");
    expect(errorCode(() => registry.register({ protocol: "Fixture", createModel: () => new EchoChatModel() }))).toBe("MODEL_PROTOCOL_INVALID");
    expect(registry.get("fixture")).toBe(original);
  });
});

function errorCode(action: () => unknown): ModelProtocolRegistryError["code"] {
  try {
    action();
  } catch (error) {
    if (error instanceof ModelProtocolRegistryError) return error.code;
    throw error;
  }
  throw new Error("Expected ModelProtocolRegistryError");
}
