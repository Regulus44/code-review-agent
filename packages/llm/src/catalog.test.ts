import { describe, expect, it } from "vitest";
import type { ProviderProfileRecord } from "@coding-agent/contracts";
import { ModelCatalog, createModelFromProviderProfile } from "./catalog.js";
import { EchoChatModel, ModelProtocolRegistry, createBuiltInModelProtocolRegistry } from "./index.js";

function profile(id: string, models: string[] = ["listed"]): ProviderProfileRecord {
  const now = new Date().toISOString();
  return { id, displayName: id.toUpperCase(), protocol: "echo", models: models.map((model) => ({ provider: id, model })), enabled: true, revision: 1, source: "custom", createdAt: now, updatedAt: now };
}

describe("ModelCatalog", () => {
  it("keeps provider groups visible when one discovery fails", async () => {
    const next = new ModelCatalog([profile("good"), profile("bad")]);
    next.register(profile("good"), { listModels: async (entry) => [{ provider: entry.id, model: "discovered" }] });
    next.register(profile("bad"), { listModels: async () => { throw new Error("gateway offline"); } });
    const discovered = await next.refresh();
    expect(discovered.groups.find((group) => group.provider === "good")).toMatchObject({ status: "ready", models: [{ model: "discovered" }] });
    expect(discovered.groups.find((group) => group.provider === "bad")).toMatchObject({ status: "failed", error: "gateway offline" });
  });
  it("resolves an unlisted model while keeping catalog advisory", () => {
    const catalog = new ModelCatalog([profile("custom")]);
    expect(catalog.resolve("custom", "unlisted").profile.id).toBe("custom");
    expect(createModelFromProviderProfile(profile("custom"), "unlisted").config).toMatchObject({ provider: "custom", model: "unlisted" });
  });
});

describe("Yayi context capability defaults", () => {
  it("advertises 1M for DeepSeek models and 200K for other models", async () => {
    const catalog = new ModelCatalog([profile("yayi-deepreasoning-ds-v4pro", ["deepreasoning-ds-v4pro"]), profile("yayi-deepreasoning-gl-5-2", ["deepreasoning-gl-5.2"])]);
    const snapshot = await catalog.refresh("local");
    expect(snapshot.groups.find((group) => group.provider.endsWith("ds-v4pro"))?.models[0]?.contextCapability?.maxInputTokens).toBe(1_000_000);
    expect(snapshot.groups.find((group) => group.provider.endsWith("ds-v4pro"))?.models[0]?.contextCapability).toMatchObject({ maxOutputTokens: 64_000, defaultMaxOutputTokens: 32_000 });
    expect(snapshot.groups.find((group) => group.provider.endsWith("gl-5-2"))?.models[0]?.contextCapability?.maxInputTokens).toBe(200_000);
  });
  it("applies the estimate when creating a model from a custom profile", () => {
    const yayi = profile("yayi-deepreasoning-qw-3-8-max", ["deepreasoning-qw-3.8-max"]);
    expect(createModelFromProviderProfile(yayi, "deepreasoning-qw-3.8-max", undefined, createBuiltInModelProtocolRegistry()).capability?.maxInputTokens).toBe(200_000);
    expect(createModelFromProviderProfile(yayi, "deepreasoning-qw-3.8-max", undefined, createBuiltInModelProtocolRegistry()).capability).toMatchObject({ maxOutputTokens: 64_000, defaultMaxOutputTokens: 32_000 });
  });

  it("passes the inferred 32000 request default and 64000 model upper to an Anthropic adapter", () => {
    const yayi = { ...profile("yayi-deepreasoning-ds-v4pro", ["deepreasoning-ds-v4pro"]), protocol: "anthropic-messages", baseUrl: "https://provider.example.test/v1" } satisfies ProviderProfileRecord;
    const registry = new ModelProtocolRegistry();
    let received: { maxOutputTokens?: number; capability?: { maxOutputTokens: number; defaultMaxOutputTokens?: number } } = {};
    registry.register({ protocol: "anthropic-messages", createModel: (config) => {
      received = {
        ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
        ...(config.contextCapability === undefined ? {} : { capability: config.contextCapability }),
      };
      return new EchoChatModel();
    } });
    createModelFromProviderProfile(yayi, "deepreasoning-ds-v4pro", undefined, registry);
    expect(received).toEqual({ maxOutputTokens: 32_000, capability: expect.objectContaining({ maxOutputTokens: 64_000, defaultMaxOutputTokens: 32_000 }) });
  });

  it("rejects an Anthropic-compatible default that exceeds the model upper bound", () => {
    const incompatible = {
      ...profile("custom-anthropic", ["small"]),
      protocol: "anthropic-messages",
      baseUrl: "https://provider.example.test/v1",
      models: [{
        provider: "custom-anthropic",
        model: "small",
        contextCapability: {
          provider: "custom-anthropic",
          model: "small",
          maxInputTokens: 200_000,
          maxOutputTokens: 8_192,
          supportsExactCount: false,
          supportsPromptCache: false,
        },
      }],
    } satisfies ProviderProfileRecord;
    expect(() => createModelFromProviderProfile(incompatible, "small", undefined, createBuiltInModelProtocolRegistry())).toThrow(/defaultMaxOutputTokens/);
  });
  it("does not enlarge unrelated custom providers", async () => {
    const snapshot = await new ModelCatalog([profile("fixture-provider", ["fixture-model"])]).refresh("local");
    expect(snapshot.groups[0]?.models[0]?.contextCapability).toBeUndefined();
  });
});
