import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginRuntime, PluginRuntimeError, validatePluginManifest } from "./index.js";
import { SkillRegistry } from "@coding-agent/skills";
import { ToolPromptRegistry, ToolRegistry } from "@coding-agent/tools";

async function bundle(manifest: unknown, entry?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coding-agent-plugin-"));
  await writeFile(path.join(root, "plugin.json"), JSON.stringify(manifest), "utf8");
  if (entry !== undefined) await writeFile(path.join(root, "index.mjs"), entry, "utf8");
  return root;
}

describe("plugin runtime", () => {
  it("validates manifest names, versions and traversal", () => {
    expect(() => validatePluginManifest({ schemaVersion: 1, name: "../bad", version: "1.0.0" })).toThrowError(PluginRuntimeError);
    expect(() => validatePluginManifest({ schemaVersion: 1, name: "good", version: "1" })).toThrowError(/Manifest/);
    expect(validatePluginManifest({ schemaVersion: 1, name: "good-plugin", version: "1.2.3", entry: "./index.mjs" }).manifest.name).toBe("good-plugin");
    expect(() => validatePluginManifest({ schemaVersion: 1, name: "good-plugin", version: "1.2.3", entry: "../index.mjs" })).toThrowError(/entry/i);
  });

  it("installs atomically, pins versions, enables and disables", async () => {
    const root = await bundle({ schemaVersion: 1, name: "demo-plugin", version: "1.0.0" });
    const cache = await mkdtemp(path.join(os.tmpdir(), "coding-agent-plugin-cache-"));
    const runtime = new PluginRuntime({ cacheRootDir: cache, bundles: [root], enabled: true, pins: { "demo-plugin": "1.0.0" } });
    const changes: string[] = [];
    runtime.subscribe((change) => changes.push(change.type));
    const snapshot = await runtime.reconcile();
    expect(snapshot.entries[0]).toMatchObject({ name: "demo-plugin", version: "1.0.0", status: "active", enabled: true });
    expect((await runtime.reconcile()).entries[0]?.status).toBe("active");
    await runtime.disable("demo-plugin");
    expect(runtime.inventory().entries[0]?.status).toBe("disabled");
    await runtime.enable("demo-plugin");
    expect(runtime.inventory().entries[0]?.status).toBe("active");
    expect(changes).toContain("installed");
    expect(changes).toContain("disabled");
    expect(changes).toContain("enabled");
    const updatedRoot = await bundle({ schemaVersion: 1, name: "demo-plugin", version: "1.1.0" });
    const updater = new PluginRuntime({ cacheRootDir: cache, enabled: true });
    updater.subscribe((change) => changes.push(change.type));
    await updater.installBundle(root);
    await updater.installBundle(updatedRoot);
    expect(changes).toContain("updated");
  });

  it("keeps failed activation bounded and rejects pin mismatch", async () => {
    const root = await bundle({ schemaVersion: 1, name: "bad-plugin", version: "1.0.0", entry: "./index.mjs" }, "export async function activate() { throw new Error('boom') }");
    const cache = await mkdtemp(path.join(os.tmpdir(), "coding-agent-plugin-cache-"));
    const runtime = new PluginRuntime({ cacheRootDir: cache, bundles: [root], enabled: true, pins: { "bad-plugin": "1.0.0" } });
    await runtime.reconcile();
    expect(runtime.inventory().entries[0]).toMatchObject({ status: "failed", errorCode: "PLUGIN_LOAD_FAILED" });
    const mismatch = new PluginRuntime({ cacheRootDir: cache, pins: { "bad-plugin": "2.0.0" } });
    await expect(mismatch.installBundle(root)).rejects.toMatchObject({ code: "PLUGIN_VERSION_PIN_MISMATCH" });
  });

  it("routes module contributions through host registries", async () => {
    const root = await bundle({ schemaVersion: 1, name: "contributor", version: "1.0.0", entry: "./index.mjs" }, [
      "export function activate(ctx) {",
      "  ctx.registerTool({ name: 'plugin_echo', description: 'plugin', inputSchema: { type: 'object' }, executionMode: 'parallel', riskLevel: 'read', approvalMode: 'auto', interruptBehavior: 'cancel', execute: async () => ({ ok: true, data: { value: 'ok' } }) });",
      "  ctx.registerPrompt({ name: 'plugin_echo', purpose: 'plugin', whenToUse: ['x'], whenNotToUse: ['y'], prerequisites: ['z'], inputRules: ['z'], sequencingRules: ['z'], resultInterpretation: ['z'], failureRecovery: ['z'], safetyRules: ['z'] });",
      "}"
    ].join("\n"));
    const cache = await mkdtemp(path.join(os.tmpdir(), "coding-agent-plugin-cache-"));
    const tools = new ToolRegistry();
    const prompts = new ToolPromptRegistry();
    const skills = new SkillRegistry();
    const runtime = new PluginRuntime({ cacheRootDir: cache, bundles: [root], enabled: true });
    runtime.bind({ skills, tools, prompts });
    await runtime.reconcile();
    expect(tools.has("plugin_echo")).toBe(true);
    expect(prompts.has("plugin_echo")).toBe(true);
    await runtime.disable("contributor");
    expect(tools.has("plugin_echo")).toBe(false);
    expect(prompts.has("plugin_echo")).toBe(false);
  });
});
