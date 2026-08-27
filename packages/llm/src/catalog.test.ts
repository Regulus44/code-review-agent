import { describe, expect, it } from "vitest";
import type { ProviderProfileRecord } from "@code-review-agent/contracts";
import { ModelCatalog, createModelFromProviderProfile } from "./catalog.js";

function profile(id: string, models: string[] = ["listed"]): ProviderProfileRecord {
  const now = new Date().toISOString();
  return {
    id,
    displayName: id.toUpperCase(),
    protocol: "echo",
    models: models.map((model) => ({ provider: id, model })),
    enabled: true,
    revision: 1,
    source: "custom",
    createdAt: now,
    updatedAt: now,
  };
}

describe("ModelCatalog", () => {
  it("keeps provider groups visible when one discovery fails", async () => {
    const catalog = new ModelCatalog([profile("good"), profile("bad")]);
    const snapshot = await catalog.refresh(undefined, undefined);
    expect(snapshot.groups).toHaveLength(2);

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
    const created = createModelFromProviderProfile(profile("custom"), "unlisted");
    expect(created.config).toMatchObject({ provider: "custom", model: "unlisted" });
  });
});
