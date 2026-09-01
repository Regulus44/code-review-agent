import type { SkillProvider, SkillRegistry } from "@coding-agent/skills";
import { PluginSkillProvider } from "@coding-agent/skills-plugin";
import type { ToolDefinition } from "@coding-agent/contracts";
import { ToolPromptRegistry, ToolRegistry, type ToolPromptSpec } from "@coding-agent/tools";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly entry?: string;
  readonly contributes?: { readonly skills?: readonly string[] };
}

export interface PluginManifestValidation { readonly manifest: PluginManifest; readonly warnings: readonly string[]; }
export type PluginStatus = "disabled" | "installed" | "active" | "failed" | "missing";
export interface PluginInventoryEntry {
  readonly name: string;
  readonly version?: string;
  readonly pinnedVersion?: string;
  readonly sourcePath?: string;
  readonly enabled: boolean;
  readonly status: PluginStatus;
  readonly errorCode?: string;
}
export interface PluginInventorySnapshot { readonly version: 1; readonly revision: number; readonly entries: readonly PluginInventoryEntry[]; }
export interface PluginRuntimeSettings {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly status: "available" | "deferred" | "unavailable" | "disabled";
  readonly reason: string;
  readonly inventory: PluginInventorySnapshot;
}
export type PluginChange = {
  readonly type: "installed" | "updated" | "enabled" | "disabled" | "activated" | "deactivated" | "failed";
  readonly name: string;
  readonly version?: string;
  readonly errorCode?: string;
  readonly revision: number;
};

export interface PluginActivationContext {
  readonly plugin: PluginInventoryEntry;
  readonly skills?: SkillRegistry;
  readonly tools?: ToolRegistry;
  readonly prompts?: ToolPromptRegistry;
  registerSkillProvider(provider: SkillProvider): () => void;
  registerTool(definition: ToolDefinition): () => void;
  registerPrompt(spec: ToolPromptSpec): () => void;
}
export interface PluginActivation { readonly dispose?: () => void | Promise<void>; }
export interface PluginModule {
  readonly activate?: (context: PluginActivationContext) => PluginActivation | void | Promise<PluginActivation | void>;
}
export interface PluginRuntimeOptions {
  readonly cacheRootDir: string;
  readonly bundles?: readonly string[];
  readonly pins?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
  readonly defaultEnabled?: boolean;
}

interface InstalledRecord {
  readonly manifest: PluginManifest;
  readonly sourcePath: string;
  readonly installPath: string;
  enabled: boolean;
  status: PluginStatus;
  errorCode: string | undefined;
  dispose: (() => void | Promise<void>) | undefined;
  ownedTools: string[];
  ownedPrompts: string[];
  unregisterSkills: Array<() => void>;
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BUNDLE_FILES = 2048;

export class PluginRuntime {
  private readonly options: PluginRuntimeOptions;
  private readonly records = new Map<string, InstalledRecord>();
  private readonly listeners = new Set<(change: PluginChange) => void>();
  private readonly pins: Readonly<Record<string, string>>;
  private revision = 0;
  private bound?: { readonly skills?: SkillRegistry; readonly tools?: ToolRegistry; readonly prompts?: ToolPromptRegistry };

  constructor(options: PluginRuntimeOptions) {
    if (!path.isAbsolute(options.cacheRootDir)) throw new PluginRuntimeError("PLUGIN_CACHE_ROOT_ABSOLUTE_REQUIRED", "Plugin cache root must be absolute");
    this.options = { ...options, bundles: options.bundles ?? [], enabled: options.enabled === true, defaultEnabled: options.defaultEnabled !== false };
    this.pins = options.pins ?? {};
  }

  bind(registries: { readonly skills?: SkillRegistry; readonly tools?: ToolRegistry; readonly prompts?: ToolPromptRegistry }): void { this.bound = registries; }
  subscribe(listener: (change: PluginChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  settings(): PluginRuntimeSettings {
    const inventory = this.inventory();
    const enabled = this.options.enabled === true;
    const failed = inventory.entries.some((entry) => entry.status === "failed");
    return {
      configured: true,
      enabled,
      status: enabled ? failed ? "unavailable" : "available" : "disabled",
      reason: enabled ? "Local plugin bundle runtime is enabled." : "Plugin runtime is installed but disabled by default; enable it explicitly.",
      inventory,
    };
  }

  inventory(): PluginInventorySnapshot {
    const entries = [...this.records.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)).map((record) => publicEntry(record, this.pins));
    return { version: 1, revision: this.revision, entries };
  }

  async installBundle(sourcePath: string, enabled = this.options.defaultEnabled === true): Promise<PluginInventoryEntry> {
    const source = await safeBundleRoot(sourcePath);
    const cacheRoot = path.resolve(this.options.cacheRootDir);
    const normalizedSource = normalizePathForComparison(source);
    const normalizedCacheRoot = normalizePathForComparison(cacheRoot);
    if (normalizedSource === normalizedCacheRoot || normalizedSource.startsWith(normalizedCacheRoot + path.sep)) throw new PluginRuntimeError("PLUGIN_SOURCE_IN_CACHE", "Plugin bundle cannot be loaded from its own cache");
    const validation = await readManifest(source);
    const manifest = validation.manifest;
    const pin = this.pins[manifest.name];
    if (pin !== undefined && pin !== manifest.version) throw new PluginRuntimeError("PLUGIN_VERSION_PIN_MISMATCH", "Pinned version does not match " + manifest.name);
    const previous = this.records.get(manifest.name);
    const target = path.join(this.options.cacheRootDir, manifest.name, manifest.version);
    await mkdir(path.dirname(target), { recursive: true });
    if (!(await isInstalledBundle(target, manifest))) {
      const temp = target + ".tmp-" + createHash("sha256").update(String(Date.now()) + "-" + String(Math.random())).digest("hex").slice(0, 12);
      await rm(temp, { recursive: true, force: true });
      await copyBundle(source, temp);
      await writeFile(path.join(temp, ".bundle-installed"), manifest.name + "@" + manifest.version + "\n", "utf8");
      await rename(temp, target);
      this.emit({ type: previous !== undefined && previous.manifest.version !== manifest.version ? "updated" : "installed", name: manifest.name, version: manifest.version, revision: ++this.revision });
    }
    if (previous !== undefined) await this.deactivate(previous);
    const record: InstalledRecord = { manifest, sourcePath: source, installPath: target, enabled, status: enabled && this.options.enabled ? "installed" : "disabled", errorCode: undefined, dispose: undefined, ownedTools: [], ownedPrompts: [], unregisterSkills: [] };
    this.records.set(manifest.name, record);
    if (record.enabled && this.options.enabled) {
      const activated = await this.activate(record);
      if (!activated && previous !== undefined && previous.enabled) {
        this.records.set(manifest.name, previous);
        await this.activate(previous);
        return publicEntry(previous, this.pins);
      }
    }
    return publicEntry(record, this.pins);
  }

  async reconcile(): Promise<PluginInventorySnapshot> {
    await mkdir(this.options.cacheRootDir, { recursive: true });
    const state = await readState(path.join(this.options.cacheRootDir, "plugin-state.json"));
    const discovered = new Set<string>();
    for (const bundle of this.options.bundles ?? []) {
      try {
        const source = await safeBundleRoot(bundle);
        const manifest = (await readManifest(source)).manifest;
        discovered.add(manifest.name);
        const enabled = state[manifest.name] ?? this.options.defaultEnabled === true;
        await this.installBundle(source, enabled);
      } catch (error) {
        const name = path.basename(bundle);
        const existing = this.records.get(name);
        if (existing !== undefined) { existing.status = "failed"; existing.errorCode = codeOf(error); }
      }
    }
    for (const record of this.records.values()) {
      if (!discovered.has(record.manifest.name)) { await this.deactivate(record); record.status = "missing"; }
    }
    await writeState(path.join(this.options.cacheRootDir, "plugin-state.json"), Object.fromEntries([...this.records].map(([name, record]) => [name, record.enabled])));
    return this.inventory();
  }

  async enable(name: string): Promise<PluginInventoryEntry | undefined> { return this.setEnabled(name, true); }
  async disable(name: string): Promise<PluginInventoryEntry | undefined> { return this.setEnabled(name, false); }

  private async setEnabled(name: string, enabled: boolean): Promise<PluginInventoryEntry | undefined> {
    const record = this.records.get(name);
    if (record === undefined) return undefined;
    record.enabled = enabled;
    if (enabled && this.options.enabled) await this.activate(record);
    else await this.deactivate(record);
    if (!enabled || !this.options.enabled) record.status = "disabled";
    else if (record.status !== "active" && record.status !== "failed") record.status = "installed";
    this.emit({ type: enabled ? "enabled" : "disabled", name, version: record.manifest.version, revision: ++this.revision });
    await writeState(path.join(this.options.cacheRootDir, "plugin-state.json"), Object.fromEntries([...this.records].map(([key, value]) => [key, value.enabled])));
    return publicEntry(record, this.pins);
  }

  private async activate(record: InstalledRecord): Promise<boolean> {
    if (record.status === "active") return true;
    try {
      const modulePath = record.manifest.entry === undefined ? undefined : safeRelative(record.installPath, record.manifest.entry);
      const loaded = modulePath === undefined ? undefined : await import(pathToFileURL(modulePath).href + "?pluginVersion=" + encodeURIComponent(record.manifest.version));
      const module = loaded === undefined ? undefined : ((loaded.default ?? loaded) as PluginModule);
      const context: PluginActivationContext = {
        plugin: publicEntry(record, this.pins),
        ...(this.bound?.skills === undefined ? {} : { skills: this.bound.skills }),
        ...(this.bound?.tools === undefined ? {} : { tools: this.bound.tools }),
        ...(this.bound?.prompts === undefined ? {} : { prompts: this.bound.prompts }),
        registerSkillProvider: (provider) => {
          if (this.bound?.skills === undefined) throw new PluginRuntimeError("PLUGIN_SKILL_REGISTRY_UNAVAILABLE", "Skill registry is unavailable");
          const dispose = this.bound.skills.registerProvider(provider, "plugin:" + record.manifest.name);
          record.unregisterSkills.push(dispose);
          return dispose;
        },
        registerTool: (definition) => {
          if (this.bound?.tools === undefined) throw new PluginRuntimeError("PLUGIN_TOOL_REGISTRY_UNAVAILABLE", "Tool registry is unavailable");
          if (definition.source !== undefined && definition.source.kind !== "builtin") throw new PluginRuntimeError("PLUGIN_TOOL_SOURCE_INVALID", "Plugin tools cannot impersonate external sources");
          const tagged = { ...definition, source: { kind: "plugin" as const, pluginName: record.manifest.name } };
          this.bound.tools.register(tagged);
          record.ownedTools.push(tagged.name);
          return () => { if (this.bound?.tools?.has(tagged.name)) this.bound.tools.unregister(tagged.name); };
        },
        registerPrompt: (spec) => {
          if (this.bound?.prompts === undefined) throw new PluginRuntimeError("PLUGIN_PROMPT_REGISTRY_UNAVAILABLE", "Tool prompt registry is unavailable");
          this.bound.prompts.register(spec);
          record.ownedPrompts.push(spec.name);
          return () => { this.bound?.prompts?.unregister(spec.name); };
        },
      };
      const activation = await module?.activate?.(context);
      record.dispose = activation?.dispose;
      if (record.manifest.contributes?.skills !== undefined && this.bound?.skills !== undefined) {
        for (const relative of record.manifest.contributes.skills) {
          const skillsRoot = safeRelative(record.installPath, relative);
          const provider = new PluginSkillProvider({ pluginName: record.manifest.name, roots: [skillsRoot], rank: 120 });
          record.unregisterSkills.push(this.bound.skills.registerProvider(provider, "plugin:" + record.manifest.name));
        }
      }
      record.status = "active";
      record.errorCode = undefined;
      this.emit({ type: "activated", name: record.manifest.name, version: record.manifest.version, revision: ++this.revision });
      return true;
    } catch (error) {
      await this.deactivate(record);
      record.status = "failed";
      record.errorCode = codeOf(error);
      this.emit({ type: "failed", name: record.manifest.name, version: record.manifest.version, errorCode: record.errorCode, revision: ++this.revision });
      return false;
    }
  }

  private async deactivate(record: InstalledRecord): Promise<void> {
    for (const dispose of record.unregisterSkills.splice(0)) dispose();
    for (const name of record.ownedTools.splice(0)) this.bound?.tools?.unregister(name);
    for (const name of record.ownedPrompts.splice(0)) this.bound?.prompts?.unregister(name);
    const dispose = record.dispose;
    record.dispose = undefined;
    if (dispose !== undefined) {
      try { await dispose(); } catch { record.errorCode = "PLUGIN_DISPOSE_FAILED"; }
    }
    if (record.status === "active") this.emit({ type: "deactivated", name: record.manifest.name, version: record.manifest.version, revision: ++this.revision });
  }

  private emit(change: PluginChange): void { for (const listener of this.listeners) listener(change); }
}

export class PluginRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PluginRuntimeError"; }
}

export function validatePluginManifest(value: unknown): PluginManifestValidation {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.name !== "string" || !NAME.test(value.name) || typeof value.version !== "string" || !SEMVER.test(value.version)) throw new PluginRuntimeError("PLUGIN_MANIFEST_INVALID", "Manifest requires schemaVersion=1, kebab-case name and semver version");
  if (value.entry !== undefined && (typeof value.entry !== "string" || !value.entry.startsWith("./") || value.entry.includes("..\\") || value.entry.includes("../") || path.isAbsolute(value.entry))) throw new PluginRuntimeError("PLUGIN_ENTRY_INVALID", "Plugin entry must be a safe relative path");
  const contributes = value.contributes;
  if (contributes !== undefined && (!isRecord(contributes) || (contributes.skills !== undefined && (!Array.isArray(contributes.skills) || contributes.skills.some((item) => typeof item !== "string" || !item.startsWith("./") || item.includes("..")))))) throw new PluginRuntimeError("PLUGIN_CONTRIBUTIONS_INVALID", "Plugin contributions contain an unsafe path");
  return { manifest: { schemaVersion: 1, name: value.name, version: value.version, ...(typeof value.description === "string" ? { description: value.description.slice(0, 2048) } : {}), ...(value.entry === undefined ? {} : { entry: value.entry }), ...(contributes === undefined ? {} : { contributes: { ...(Array.isArray(contributes.skills) ? { skills: contributes.skills.slice(0, 32) } : {}) } }) }, warnings: [] };
}

async function safeBundleRoot(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new PluginRuntimeError("PLUGIN_SOURCE_ABSOLUTE_REQUIRED", "Plugin bundle path must be absolute");
  const root = await realpath(input);
  const info = await stat(root);
  if (!info.isDirectory()) throw new PluginRuntimeError("PLUGIN_SOURCE_NOT_DIRECTORY", "Plugin bundle must be a directory");
  return root;
}

async function readManifest(root: string): Promise<PluginManifestValidation> {
  const file = safeRelative(root, "./plugin.json");
  const info = await stat(file);
  if (info.size > MAX_MANIFEST_BYTES) throw new PluginRuntimeError("PLUGIN_MANIFEST_TOO_LARGE", "Plugin manifest is too large");
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch { throw new PluginRuntimeError("PLUGIN_MANIFEST_INVALID", "Plugin manifest is not valid JSON"); }
  return validatePluginManifest(value);
}

function safeRelative(root: string, relative: string): string {
  if (!relative.startsWith("./") || relative.includes("\\") || relative.includes("\0")) throw new PluginRuntimeError("PLUGIN_PATH_INVALID", "Plugin paths must be relative POSIX paths");
  const resolved = path.resolve(root, relative.slice(2));
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) throw new PluginRuntimeError("PLUGIN_PATH_TRAVERSAL", "Plugin path escapes bundle root");
  return resolved;
}

async function copyBundle(source: string, target: string): Promise<void> {
  let count = 0;
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (++count > MAX_BUNDLE_FILES) throw new PluginRuntimeError("PLUGIN_BUNDLE_TOO_LARGE", "Plugin bundle contains too many files");
      if (entry.isSymbolicLink()) throw new PluginRuntimeError("PLUGIN_SYMLINK_REJECTED", "Plugin bundle cannot contain symlinks");
      const src = path.join(current, entry.name);
      const dest = path.join(target, relative, entry.name);
      if (entry.isDirectory()) { await mkdir(dest, { recursive: true }); await walk(src, path.join(relative, entry.name)); }
      else if (entry.isFile()) { await mkdir(path.dirname(dest), { recursive: true }); await cp(src, dest); }
      else throw new PluginRuntimeError("PLUGIN_ENTRY_TYPE_UNSUPPORTED", "Plugin bundle contains an unsupported filesystem entry");
    }
  }
  await mkdir(target, { recursive: true });
  await walk(source, "");
}

async function isDirectory(input: string): Promise<boolean> { try { return (await stat(input)).isDirectory(); } catch { return false; } }
async function isInstalledBundle(input: string, manifest: PluginManifest): Promise<boolean> {
  if (!(await isDirectory(input))) return false;
  try { return (await readFile(path.join(input, ".bundle-installed"), "utf8")).trim() === manifest.name + "@" + manifest.version; } catch { return false; }
}
async function readState(file: string): Promise<Record<string, boolean>> { try { const value = JSON.parse(await readFile(file, "utf8")); return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean")) as Record<string, boolean> : {}; } catch { return {}; } }
async function writeState(file: string, state: Record<string, boolean>): Promise<void> { const temp = file + ".tmp"; await writeFile(temp, JSON.stringify(state), "utf8"); await rename(temp, file); }
function publicEntry(record: InstalledRecord, pins: Readonly<Record<string, string>>): PluginInventoryEntry { return { name: record.manifest.name, version: record.manifest.version, ...(pins[record.manifest.name] === undefined ? {} : { pinnedVersion: pins[record.manifest.name] }), enabled: record.enabled, status: record.status, ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }) }; }
function codeOf(error: unknown): string { return error instanceof PluginRuntimeError ? error.code : "PLUGIN_LOAD_FAILED"; }
function normalizePathForComparison(input: string): string { return process.platform === "win32" ? input.toLowerCase() : input; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
