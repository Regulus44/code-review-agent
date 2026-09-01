import type {
  SkillCatalogSnapshot,
  SkillCandidate,
  SkillChangeEvent,
  SkillDefinition,
  SkillLookupOptions,
  SkillPermissionAssessment,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
  SkillRegistration,
  SkillScope,
  SkillSourceTrust,
  SkillSummary,
} from "@coding-agent/contracts";

export * from "@coding-agent/contracts";

/** Public skill names deliberately use the same stable grammar as slash commands. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_FAILURES = 16;
const RUNTIME_PROVIDER = "runtime";
const RUNTIME_RANK = 250;

export function isSkillName(value: string): boolean {
  return SKILL_NAME_PATTERN.test(value);
}

export function isModelInvocable(skill: Pick<SkillSummary, "invocation">): boolean {
  return skill.invocation.modelInvocable;
}

export function isUserInvocable(skill: Pick<SkillSummary, "invocation">): boolean {
  return skill.invocation.userInvocable;
}

export class SkillRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface IndexedCandidate {
  readonly candidate: SkillCandidate;
  readonly provider: SkillProvider;
  readonly providerOrder: number;
  readonly localOrder: number;
}

interface Layer {
  readonly providers: Map<string, { readonly provider: SkillProvider; readonly order: number; readonly controller: AbortController }>;
  readonly runtime: Map<string, SkillDefinition>;
}

/**
 * A deliberately small, provider-neutral registry. It merges a global layer
 * with an explicit caller supplied scope chain. The nearest scope wins a name;
 * rank only orders candidates that compete within the same layer.
 */
export class SkillRegistry {
  private readonly layers = new Map<string, Layer>();
  private readonly listeners = new Set<(event: SkillChangeEvent) => void>();
  private nextProviderOrder = 0;
  private revision = 0;

  registerProvider(provider: SkillProvider, scope?: SkillScope): () => void {
    validateProvider(provider);
    const layer = this.layer(scope);
    if (layer.providers.has(provider.name)) throw new SkillRegistryError("SKILL_PROVIDER_DUPLICATE", `Skill provider already registered: ${provider.name}`);
    const controller = new AbortController();
    const entry = { provider, order: this.nextProviderOrder++, controller };
    layer.providers.set(provider.name, entry);
    let active = true;
    const invalidate = () => {
      if (active) this.change("provider-invalidated", provider.name, scope);
    };
    const control: SkillProviderControl = { signal: controller.signal, invalidate };
    try {
      provider.start?.(control);
    } catch (error) {
      layer.providers.delete(provider.name);
      controller.abort();
      throw error;
    }
    this.change("provider-registered", provider.name, scope);
    return () => {
      if (!active) return;
      active = false;
      controller.abort();
      layer.providers.delete(provider.name);
      this.change("provider-removed", provider.name, scope);
    };
  }

  register(skill: SkillRegistration, scope?: SkillScope): () => void {
    const definition = normalizeRegistration(skill);
    const layer = this.layer(scope);
    if (layer.runtime.has(definition.name)) throw new SkillRegistryError("SKILL_DUPLICATE", `Runtime skill already registered: ${definition.name}`);
    layer.runtime.set(definition.name, definition);
    this.change("runtime-registered", RUNTIME_PROVIDER, scope);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      layer.runtime.delete(definition.name);
      this.change("runtime-removed", RUNTIME_PROVIDER, scope);
    };
  }

  subscribe(listener: (event: SkillChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Explicitly invalidate provider-backed catalogs after an external workspace mutation. */
  invalidate(provider?: string, scope?: SkillScope): number {
    this.change("provider-invalidated", provider, scope);
    return this.revision;
  }

  providerCount(scope?: SkillScope): number {
    return this.layers.get(scopeKey(scope))?.providers.size ?? 0;
  }

  async snapshot(options: SkillLookupOptions = {}): Promise<SkillCatalogSnapshot> {
    throwIfAborted(options.signal);
    const failures: { provider: string; code: "provider-failed" | "candidate-invalid" }[] = [];
    let complete = true;
    const winners = new Map<string, IndexedCandidate>();
    for (const scope of scopeChain(options)) {
      const result = await this.collectLayer(scope, options, failures);
      complete = complete && result.complete;
      // Later (closer) scope wins independently of its rank.
      for (const [name, entry] of result.winners) winners.set(name, entry);
    }
    const skills = [...winners.values()]
      .map(({ candidate }) => summaryOf(candidate))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      version: 1,
      revision: this.revision,
      complete,
      skills,
      ...(failures.length === 0 ? {} : { failures }),
    };
  }

  async list(options: SkillLookupOptions = {}): Promise<readonly SkillSummary[]> {
    return (await this.snapshot(options)).skills;
  }

  async get(name: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillName(name)) throw new SkillRegistryError("SKILL_NAME_INVALID", `Invalid skill name: ${name}`);
    throwIfAborted(options.signal);
    const found = await this.resolve(name, options);
    if (found === undefined) return undefined;
    const definition = await found.provider.get(found.candidate, options);
    throwIfAborted(options.signal);
    if (definition === undefined) return undefined;
    return validateDefinition(definition, found.candidate);
  }

  private async resolve(name: string, options: SkillLookupOptions): Promise<IndexedCandidate | undefined> {
    const failures: { provider: string; code: "provider-failed" | "candidate-invalid" }[] = [];
    let winner: IndexedCandidate | undefined;
    for (const scope of scopeChain(options)) {
      const result = await this.collectLayer(scope, options, failures);
      const candidate = result.winners.get(name);
      if (candidate !== undefined) winner = candidate;
    }
    return winner;
  }

  private async collectLayer(scope: SkillScope | undefined, options: SkillLookupOptions, failures: { provider: string; code: "provider-failed" | "candidate-invalid" }[]): Promise<{ readonly winners: Map<string, IndexedCandidate>; readonly complete: boolean }> {
    const layer = this.layers.get(scopeKey(scope));
    if (layer === undefined) return { winners: new Map(), complete: true };
    const entries: IndexedCandidate[] = [];
    let localOrder = 0;
    for (const definition of layer.runtime.values()) {
      entries.push({ candidate: candidateOf(definition), provider: runtimeProvider(definition), providerOrder: -1, localOrder: localOrder++ });
    }
    let complete = true;
    for (const { provider, order } of layer.providers.values()) {
      try {
        const raw = await provider.list(options);
        throwIfAborted(options.signal);
        const observation = observe(raw);
        if (!observation.complete) complete = false;
        for (const candidate of observation.candidates) {
          try {
            validateCandidate(candidate, provider.name);
            entries.push({ candidate, provider, providerOrder: order, localOrder: localOrder++ });
          } catch {
            complete = false;
            addFailure(failures, provider.name, "candidate-invalid");
          }
        }
      } catch (error) {
        if (isAbort(error, options.signal)) throw error;
        complete = false;
        addFailure(failures, provider.name, "provider-failed");
      }
    }
    const winners = new Map<string, IndexedCandidate>();
    for (const entry of entries.sort(compareCandidate)) {
      if (!winners.has(entry.candidate.name)) winners.set(entry.candidate.name, entry);
    }
    return { winners, complete };
  }

  private layer(scope: SkillScope | undefined): Layer {
    const key = scopeKey(scope);
    let layer = this.layers.get(key);
    if (layer === undefined) {
      layer = { providers: new Map(), runtime: new Map() };
      this.layers.set(key, layer);
    }
    return layer;
  }

  private change(reason: SkillChangeEvent["reason"], provider?: string, scope?: SkillScope): void {
    const event: SkillChangeEvent = { version: 1, revision: ++this.revision, reason, ...(provider === undefined ? {} : { provider }), ...(scope === undefined ? {} : { scope }) };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* observers cannot veto lifecycle changes */ }
    }
  }
}

function scopeChain(options: SkillLookupOptions): readonly (SkillScope | undefined)[] {
  const scopes = options.scopeChain ?? (options.scope === undefined ? [] : [options.scope]);
  return [undefined, ...scopes];
}

function scopeKey(scope: SkillScope | undefined): string { return scope === undefined ? "@global" : `@scope:${scope}`; }
function addFailure(failures: { provider: string; code: "provider-failed" | "candidate-invalid" }[], provider: string, code: "provider-failed" | "candidate-invalid"): void {
  if (failures.length < MAX_FAILURES && !failures.some((item) => item.provider === provider && item.code === code)) failures.push({ provider, code });
}
function observe(raw: readonly SkillCandidate[] | SkillProviderObservation): SkillProviderObservation {
  return "candidates" in raw ? raw : { candidates: raw, complete: true };
}
function compareCandidate(left: IndexedCandidate, right: IndexedCandidate): number {
  return left.candidate.rank - right.candidate.rank || left.providerOrder - right.providerOrder || left.localOrder - right.localOrder || left.candidate.name.localeCompare(right.candidate.name);
}
function summaryOf(candidate: SkillSummary & Partial<Pick<SkillCandidate, "rank" | "locator" | "path" | "metadata">>): SkillSummary {
  const { rank: _rank, locator: _locator, path: _path, metadata: _metadata, ...summary } = candidate;
  return summary;
}
function candidateOf(definition: SkillDefinition): SkillCandidate {
  return { ...summaryOf(definition), rank: RUNTIME_RANK, locator: definition.name, ...(definition.path === undefined ? {} : { path: definition.path }), ...(definition.metadata === undefined ? {} : { metadata: definition.metadata }) };
}
function runtimeProvider(definition: SkillDefinition): SkillProvider {
  return { name: definition.provider, list: async () => [candidateOf(definition)], get: async () => definition };
}
function validateProvider(provider: SkillProvider): void {
  if (provider.name.trim() === "") throw new SkillRegistryError("SKILL_PROVIDER_INVALID", "Skill provider name is required");
}
function validateCandidate(candidate: SkillCandidate, provider: string): void {
  if (!isSkillName(candidate.name)) throw new SkillRegistryError("SKILL_NAME_INVALID", `Invalid skill name: ${candidate.name}`);
  if (candidate.provider !== provider) throw new SkillRegistryError("SKILL_PROVIDER_MISMATCH", "Skill candidate provider does not match its registered provider");
  if (!Number.isFinite(candidate.rank)) throw new SkillRegistryError("SKILL_RANK_INVALID", "Skill rank must be finite");
  if (candidate.description.trim() === "") throw new SkillRegistryError("SKILL_DESCRIPTION_INVALID", "Skill description is required");
}
function validateDefinition(definition: SkillDefinition, candidate: SkillCandidate): SkillDefinition {
  validateCandidate({ ...candidate, ...summaryOf(definition), rank: candidate.rank, locator: candidate.locator }, candidate.provider);
  if (definition.name !== candidate.name || definition.provider !== candidate.provider || definition.source !== candidate.source) throw new SkillRegistryError("SKILL_DEFINITION_MISMATCH", "Loaded skill no longer matches the discovered candidate");
  return definition;
}
function normalizeRegistration(skill: SkillRegistration): SkillDefinition {
  const definition: SkillDefinition = {
    ...skill,
    provider: skill.provider ?? RUNTIME_PROVIDER,
    invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
    source: skill.source ?? "runtime",
    trust: skill.trust ?? "local",
  };
  validateCandidate(candidateOf(definition), definition.provider);
  return definition;
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Skill lookup aborted", "AbortError");
}
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

/** Source trust can only reduce capability: unknown frontmatter always asks. */
export function assessSkillPermission(input: {
  readonly trust: SkillSourceTrust;
  readonly allowedTools?: readonly string[];
  readonly unknownProperties?: readonly string[];
  readonly baseAllowedTools?: readonly string[];
}): SkillPermissionAssessment {
  const unknown = [...new Set(input.unknownProperties ?? [])].sort();
  if (unknown.length > 0) return { decision: "ask", effectiveAllowedTools: [], reason: "unknown-properties", unknownProperties: unknown };
  if (input.trust === "remote" || input.trust === "unknown") return { decision: "ask", effectiveAllowedTools: [], reason: "untrusted-source" };
  const requested = [...new Set(input.allowedTools ?? [])];
  const base = input.baseAllowedTools;
  const effective = base === undefined ? requested : requested.filter((tool) => base.includes(tool));
  return { decision: "allow", effectiveAllowedTools: effective, reason: "allowlisted" };
}
