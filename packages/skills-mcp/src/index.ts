import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
} from "@coding-agent/contracts";
import { isSkillName } from "@coding-agent/skills";
import type { McpConnectionManager } from "@coding-agent/mcp-client";

const DEFAULTS = Object.freeze({
  maxContentBytes: 64 * 1024,
  maxDescriptionBytes: 2 * 1024,
  maxSkills: 64,
  timeoutMs: 15_000,
  cacheTtlMs: 30_000,
});

export interface McpSkillProviderOptions {
  readonly manager: McpConnectionManager;
  readonly serverName: string;
  readonly tenantId?: string;
  /** Explicit feature gate. Remote Skill discovery is disabled unless true. */
  readonly enabled?: boolean;
  /** Optional exact/prefix allowlist for MCP resource URIs. */
  readonly allowedResourceUriPrefixes?: readonly string[];
  readonly rank?: number;
  readonly maxContentBytes?: number;
  readonly maxDescriptionBytes?: number;
  readonly maxSkills?: number;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
}

interface ResourceLocator {
  readonly serverName: string;
  readonly uri: string;
}

type ProviderOptions = Omit<McpSkillProviderOptions, "enabled" | "maxContentBytes" | "maxDescriptionBytes" | "maxSkills" | "timeoutMs" | "cacheTtlMs" | "rank"> & {
  readonly enabled: boolean;
  readonly maxContentBytes: number;
  readonly maxDescriptionBytes: number;
  readonly maxSkills: number;
  readonly timeoutMs: number;
  readonly cacheTtlMs: number;
  readonly rank: number;
};

interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  readonly allowedTools?: readonly string[];
  readonly unknown: readonly string[];
  readonly body: string;
}

/**
 * Opt-in MCP `skill://` provider. It deliberately depends on the host-owned
 * MCP manager rather than fetching arbitrary URLs, so credentials, tenant
 * scope, cancellation and MCP audit events remain in one adapter.
 */
export class McpSkillProvider implements SkillProvider {
  readonly name: string;
  readonly tenantId?: string;
  private readonly options: ProviderOptions;
  private control: SkillProviderControl | undefined;
  private unsubscribeResources: (() => void) | undefined;
  private readonly candidates = new Map<string, SkillCandidate>();
  private readonly definitions = new Map<string, { readonly definition: SkillDefinition; readonly expiresAt: number }>();
  private lastGood: readonly SkillCandidate[] = [];
  private lastListAt = 0;
  private lastListComplete = false;
  private listPromise: Promise<SkillProviderObservation> | undefined;

  constructor(options: McpSkillProviderOptions) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(options.serverName)) throw new Error("MCP Skill provider serverName is invalid");
    this.options = {
      ...options,
      enabled: options.enabled === true,
      maxContentBytes: boundedPositive(options.maxContentBytes, DEFAULTS.maxContentBytes, 1, 1024 * 1024),
      maxDescriptionBytes: boundedPositive(options.maxDescriptionBytes, DEFAULTS.maxDescriptionBytes, 1, 16 * 1024),
      maxSkills: boundedPositive(options.maxSkills, DEFAULTS.maxSkills, 1, 512),
      timeoutMs: boundedPositive(options.timeoutMs, DEFAULTS.timeoutMs, 1, 120_000),
      cacheTtlMs: boundedPositive(options.cacheTtlMs, DEFAULTS.cacheTtlMs, 1, 10 * 60_000),
      rank: boundedPositive(options.rank, 125, -1_000_000, 1_000_000),
    };
    this.name = `mcp:${options.serverName}`;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  start(control: SkillProviderControl): void {
    this.control = control;
    if (!this.options.enabled) return;
    control.signal.addEventListener("abort", () => this.dispose(), { once: true });
    this.unsubscribeResources = this.options.manager.subscribeResourceChanges((serverName) => {
      if (serverName !== this.options.serverName) return;
      this.invalidateCache();
      control.invalidate();
    });
  }

  async list(options: SkillLookupOptions = {}): Promise<SkillProviderObservation> {
    if (!this.options.enabled) return { candidates: [], complete: true };
    if (this.listPromise !== undefined) return this.listPromise;
    const now = Date.now();
    if (now - this.lastListAt < this.options.cacheTtlMs && this.candidates.size > 0) {
      return { candidates: [...this.candidates.values()], complete: this.lastListComplete };
    }
    this.listPromise = this.loadCandidates(options).finally(() => { this.listPromise = undefined; });
    return this.listPromise;
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!this.options.enabled) return undefined;
    const locator = parseLocator(candidate.locator);
    if (locator === undefined || locator.serverName !== this.options.serverName || candidate.provider !== this.name || candidate.trust !== "remote" || !this.isAllowed(locator.uri)) return undefined;
    if (remoteSkillName(this.options.serverName, locator.uri, candidate.name) !== candidate.name) return undefined;
    const cached = this.definitions.get(locator.uri);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.definition;
    try {
      const result = await this.readMcpResource(locator.uri, options.signal);
      const parsed = parseSkillMarkdown(result, this.options.maxDescriptionBytes);
      if (parsed === undefined || !isSkillName(candidate.name)) return undefined;
      const definition: SkillDefinition = {
        name: candidate.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
        source: "mcp",
        provider: this.name,
        trust: "remote",
        resourceBase: { kind: "opaque", description: `MCP resource ${this.options.serverName}/${locator.uri}` },
        content: parsed.body,
        metadata: {
          remote: true,
          disableShellExpansion: true,
          ...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools }),
          ...(parsed.unknown.length === 0 ? {} : { unknownProperties: parsed.unknown }),
        },
      };
      this.definitions.set(locator.uri, { definition, expiresAt: Date.now() + this.options.cacheTtlMs });
      return definition;
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      return undefined;
    }
  }

  dispose(): void {
    this.unsubscribeResources?.();
    this.unsubscribeResources = undefined;
    this.control = undefined;
    this.invalidateCache();
  }

  private async loadCandidates(options: SkillLookupOptions): Promise<SkillProviderObservation> {
    try {
      const discovery = this.options.manager.discovery(this.options.serverName, this.options.tenantId);
      if (discovery === undefined) return this.incomplete();
      const next = new Map<string, SkillCandidate>();
      let complete = true;
      for (const resource of discovery.resources) {
        if (next.size >= this.options.maxSkills) { complete = false; break; }
        if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Skill lookup aborted", "AbortError");
        if (!this.isAllowed(resource.uri) || !resource.uri.startsWith("skill://")) continue;
        try {
          const text = await this.readMcpResource(resource.uri, options.signal);
          const parsed = parseSkillMarkdown(text, this.options.maxDescriptionBytes);
          if (parsed === undefined) { complete = false; continue; }
          const name = remoteSkillName(this.options.serverName, resource.uri, parsed.name);
          const candidate: SkillCandidate = {
            name,
            description: parsed.description,
            ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
            invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
            source: "mcp",
            provider: this.name,
            trust: "remote",
            resourceBase: { kind: "opaque", description: `MCP resource ${this.options.serverName}/${resource.uri}` },
            rank: this.options.rank,
            locator: { serverName: this.options.serverName, uri: resource.uri } satisfies ResourceLocator,
            metadata: {
              remote: true,
              disableShellExpansion: true,
              ...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools }),
              ...(parsed.unknown.length === 0 ? {} : { unknownProperties: parsed.unknown }),
            },
          };
          next.set(name, candidate);
        } catch (error) {
          if (isAbort(error, options.signal)) throw error;
          complete = false;
        }
      }
      if (complete) {
        this.candidates.clear();
        for (const [name, candidate] of next) this.candidates.set(name, candidate);
        this.lastGood = [...next.values()];
      }
      this.lastListAt = Date.now();
      this.lastListComplete = complete;
      return { candidates: [...(complete ? next.values() : this.lastGood)], complete };
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      return this.incomplete();
    }
  }

  private incomplete(): SkillProviderObservation {
    this.lastListAt = Date.now();
    this.lastListComplete = false;
    return { candidates: [...this.lastGood], complete: false };
  }

  private async readMcpResource(uri: string, signal?: AbortSignal): Promise<string> {
    if (!this.isAllowed(uri) || !uri.startsWith("skill://")) throw new Error("MCP resource URI is not allowed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("MCP Skill resource timeout", "TimeoutError")), this.options.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason ?? new DOMException("MCP Skill resource aborted", "AbortError"));
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.options.manager.readResource(this.options.serverName, uri, controller.signal, this.options.tenantId);
      const parts = result.contents?.flatMap((item) => "text" in item && typeof item.text === "string" ? [item.text] : []) ?? [];
      const text = parts.join("\n");
      if (Buffer.byteLength(text, "utf8") > this.options.maxContentBytes) throw new Error("MCP Skill resource exceeds size limit");
      return text;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private isAllowed(uri: string): boolean {
    if (!uri.startsWith("skill://") || uri.length > 2048) return false;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "skill:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return false;
    } catch { return false; }
    const prefixes = this.options.allowedResourceUriPrefixes;
    return prefixes === undefined || prefixes.length === 0 || prefixes.some((prefix) => uri === prefix || uri.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
  }

  private invalidateCache(): void {
    this.candidates.clear();
    this.definitions.clear();
    this.lastListAt = 0;
    this.lastListComplete = false;
  }
}

export function createMcpSkillProvider(options: McpSkillProviderOptions): McpSkillProvider {
  return new McpSkillProvider(options);
}

function remoteSkillName(serverName: string, uri: string, frontmatterName: string): string {
  const slug = uri.slice("skill://".length).replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
  const server = serverName.replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
  const preferred = `mcp-${server}-${slug || frontmatterName}`;
  if (isSkillName(preferred)) return preferred.slice(0, 96);
  return `mcp-${Math.abs(hashCode(`${serverName}:${uri}`))}`;
}

function parseLocator(value: unknown): ResourceLocator | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.serverName === "string" && typeof item.uri === "string" ? { serverName: item.serverName, uri: item.uri } : undefined;
}

function parseSkillMarkdown(text: string, maxDescriptionBytes: number): ParsedSkill | undefined {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/u);
  if (match === null || match[1] === undefined) return undefined;
  const values = new Map<string, string>();
  const unknown: string[] = [];
  const known = new Set(["name", "description", "when_to_use", "whenToUse", "model_invocable", "modelInvocable", "disable-model-invocation", "user_invocable", "userInvocable", "user-invocable", "allowed-tools", "allowedTools"]);
  for (const line of match[1].split(/\r?\n/u)) {
    const item = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/u);
    if (item === null) { if (line.trim() !== "") unknown.push("malformed"); continue; }
    const key = item[1]; const value = item[2];
    if (key === undefined || value === undefined) { unknown.push("malformed"); continue; }
    if (!known.has(key)) unknown.push(key);
    values.set(key, stripYaml(value));
  }
  const name = values.get("name")?.trim();
  const description = values.get("description")?.trim();
  if (name === undefined || description === undefined || name === "" || description === "" || Buffer.byteLength(description, "utf8") > maxDescriptionBytes) return undefined;
  const bool = (a: string, b: string, fallback: boolean): boolean => {
    const raw = values.get(a) ?? values.get(b);
    return raw === undefined ? fallback : raw !== "false";
  };
  const disable = values.get("disable-model-invocation");
  const whenToUse = values.get("when_to_use") ?? values.get("whenToUse");
  const allowedRaw = values.get("allowed-tools") ?? values.get("allowedTools");
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    modelInvocable: disable === undefined ? bool("model_invocable", "modelInvocable", true) : disable === "false",
    userInvocable: values.get("user-invocable") === undefined ? bool("user_invocable", "userInvocable", true) : values.get("user-invocable") !== "false",
    ...(allowedRaw === undefined ? {} : { allowedTools: parseList(allowedRaw) }),
    unknown,
    body: text.slice(match[0].length),
  };
}

function parseList(value: string): readonly string[] { return value.replace(/^\[/u, "").replace(/\]$/u, "").split(/[;,\s]+/u).map((item) => stripYaml(item.trim())).filter(Boolean).slice(0, 64); }
function stripYaml(value: string): string { const trimmed = value.trim(); return ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1) : trimmed; }
function boundedPositive(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.max(min, Math.min(max, Math.floor(value))); }
function hashCode(value: string): number { let hash = 0; for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; return hash >>> 0; }
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  // Only propagate cancellation requested by the caller. Provider-owned
  // timeout/transport aborts are bounded failures and must preserve last-good.
  return signal?.aborted === true;
}
