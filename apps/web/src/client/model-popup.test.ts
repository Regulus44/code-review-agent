import { describe, expect, it } from "vitest";
import type { ModelSelection, ProviderCatalogGroup } from "@coding-agent/contracts";
import { ModelDirectory } from "./model-directory.js";
import { ModelPopupController } from "./model-popup.js";

const groups: readonly ProviderCatalogGroup[] = [
  {
    provider: "anthropic",
    displayName: "Anthropic",
    protocol: "anthropic-messages",
    enabled: true,
    source: "custom",
    status: "ready",
    models: [
      { provider: "anthropic", model: "claude-sonnet", displayName: "Claude Sonnet" },
      { provider: "anthropic", model: "shared-model" },
    ],
  },
  {
    provider: "offline",
    displayName: "Offline Provider",
    protocol: "echo",
    enabled: true,
    source: "custom",
    status: "failed",
    error: "catalog unavailable",
    models: [{ provider: "offline", model: "shared-model" }],
  },
  {
    provider: "openai-compatible",
    displayName: "OpenAI Compatible",
    protocol: "openai-chat-completions",
    enabled: true,
    source: "custom",
    status: "ready",
    models: [{ provider: "openai-compatible", model: "shared-model" }],
  },
];

function fixture() {
  const selections: ModelSelection[] = [];
  const api = {
    listSessionModels: async () => ({
      sessionId: "ses_popup" as never,
      selection: { provider: "anthropic", model: "claude-sonnet", reasoningEffort: "high" },
      providers: groups,
    }),
    selectSessionModel: async (_sessionId: never, selection: ModelSelection) => {
      selections.push(selection);
      return {
        sessionId: "ses_popup" as never,
        selection,
        model: {},
        effective: { provider: selection.provider, model: selection.model },
      };
    },
  };
  const directory = new ModelDirectory(api, "ses_popup" as never);
  const popup = new ModelPopupController(directory);
  return { popup, selections };
}

describe("ModelPopupController", () => {
  it("builds searchable provider/model rows over the shared directory", async () => {
    const { popup } = fixture();
    await popup.open();
    expect(popup.getSnapshot().options).toHaveLength(4);
    expect(popup.getSnapshot().activeId).toBe(JSON.stringify(["anthropic", "claude-sonnet"]));

    popup.setQuery("offline");
    expect(popup.getSnapshot().visibleOptions).toMatchObject([{ provider: "offline", disabled: true }]);
    expect(popup.getSnapshot().activeId).toBeNull();
  });

  it("moves through enabled rows and skips provider failures", async () => {
    const { popup } = fixture();
    await popup.open("shared-model");
    expect(popup.getSnapshot().visibleOptions).toHaveLength(3);
    popup.move(1);
    expect(popup.getSnapshot().activeId).toBe(JSON.stringify(["openai-compatible", "shared-model"]));
    popup.move(1);
    expect(popup.getSnapshot().activeId).toBe(JSON.stringify(["anthropic", "shared-model"]));
  });

  it("selects the active row through ModelDirectory and closes", async () => {
    const { popup, selections } = fixture();
    await popup.open("shared-model");
    const selected = await popup.selectActive("popup-select");
    expect(selected).toEqual({ provider: "anthropic", model: "shared-model" });
    expect(selections).toEqual([{ provider: "anthropic", model: "shared-model" }]);
    expect(popup.getSnapshot().open).toBe(false);
  });

  it("resolves duplicate model ids by provider and preserves the active reasoning effort", async () => {
    const { popup, selections } = fixture();
    await popup.open();
    const active = popup.getSnapshot().options.find((option) => option.active);
    expect(active?.selection.reasoningEffort).toBe("high");
    popup.setQuery("shared-model");
    const secondProvider = popup.getSnapshot().visibleOptions.find((option) => option.provider === "openai-compatible");
    expect(secondProvider?.id).toBe(JSON.stringify(["openai-compatible", "shared-model"]));
    expect(secondProvider?.selection).toEqual({ provider: "openai-compatible", model: "shared-model" });
    const anthropic = popup.getSnapshot().visibleOptions.find((option) => option.provider === "anthropic" && option.model === "shared-model");
    expect(anthropic?.id).toBe(JSON.stringify(["anthropic", "shared-model"]));
    await popup.select(anthropic?.id ?? "");
    expect(selections).toEqual([{ provider: "anthropic", model: "shared-model" }]);
  });
});
