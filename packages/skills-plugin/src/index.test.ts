import { describe, expect, it } from "vitest";
import { PluginSkillProvider } from "./index.js";

describe("PluginSkillProvider", () => {
  it("names providers by plugin scope", () => {
    const provider = new PluginSkillProvider({ pluginName: "demo", roots: ["C:/tmp/demo"] });
    expect(provider.name).toBe("plugin:demo");
  });
});
