import { describe, expect, it } from "vitest";
import type { ProviderProfileRecord } from "@code-review-agent/contracts";
import { ModelCatalog, createModelFromProviderProfile } from "./catalog.js";
import { createBuiltInModelProtocolRegistry } from "./index.js";

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
    expect(snapshot.groups.find((group) => group.provider.endsWith("gl-5-2"))?.models[0]?.contextCapability?.maxInputTokens).toBe(200_000);
  });
  it("applies the estimate when creating a model from a custom profile", () => {
    const yayi = profile("yayi-deepreasoning-qw-3-8-max", ["deepreasoning-qw-3.8-max"]);
    expect(createModelFromProviderProfile(yayi, "deepreasoning-qw-3.8-max", undefined, createBuiltInModelProtocolRegistry()).capability?.maxInputTokens).toBe(200_000);
  });
  it("does not enlarge unrelated custom providers", async () => {
    const snapshot = await new ModelCatalog([profile("fixture-provider", ["fixture-model"])]).refresh("local");
    expect(snapshot.groups[0]?.models[0]?.contextCapability).toBeUndefined();
  });
});
