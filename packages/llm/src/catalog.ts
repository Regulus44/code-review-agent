import type {
  ChatModel,
  ModelCatalogEntry,
  ModelContextCapability,
  ProviderCatalogGroup,
  ProviderProfileRecord,
} from "@code-review-agent/contracts";
import { createBuiltInModelProtocolRegistry, ModelConfigurationError, type ModelProtocolRegistry } from "./index.js";

/** Secret material is deliberately structural and never part of a profile/catalog DTO. */
export interface ProviderCredentialMaterial {
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ProviderCatalogDiscovery {
  readonly listModels: (profile: ProviderProfileRecord, signal?: AbortSignal) => Promise<readonly ModelCatalogEntry[]>;
}

export interface ModelCatalogSnapshot {
  readonly groups: readonly ProviderCatalogGroup[];
  readonly refreshedAt: string;
}

/**
 * Small host-owned provider directory. Catalog membership is advisory: resolve()
 * returns an unlisted model as long as its provider profile is enabled.
 */
export class ModelCatalog {
  private readonly profiles = new Map<string, ProviderProfileRecord>();
  private readonly discoveries = new Map<string, ProviderCatalogDiscovery>();
  private readonly failures = new Map<string, string>();
  private snapshot: ModelCatalogSnapshot = { groups: [], refreshedAt: new Date(0).toISOString() };

  constructor(profiles: readonly ProviderProfileRecord[] = []) {
    for (const profile of profiles) this.register(profile);
  }

  register(profile: ProviderProfileRecord, discovery?: ProviderCatalogDiscovery): void {
    validateProfile(profile);
    const key = profileKey(profile);
    this.profiles.set(key, profile);
    if (discovery === undefined) this.discoveries.delete(key);
    else this.discoveries.set(key, discovery);
  }

  unregister(provider: string, tenantId?: string): boolean {
    const key = `${tenantId ?? ""}\u0000${provider}`;
    this.discoveries.delete(key);
    this.failures.delete(key);
    return this.profiles.delete(key);
  }

  listProfiles(tenantId?: string): readonly ProviderProfileRecord[] {
    return [...this.profiles.values()]
      .filter((profile) => profile.tenantId === undefined || profile.tenantId === tenantId)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  profile(provider: string, tenantId?: string): ProviderProfileRecord | undefined {
    return this.profiles.get(`${tenantId ?? ""}\u0000${provider}`) ?? this.profiles.get(`\u0000${provider}`);
  }

  async refresh(tenantId?: string, signal?: AbortSignal): Promise<ModelCatalogSnapshot> {
    const refreshedAt = new Date().toISOString();
    const groups: ProviderCatalogGroup[] = [];
    for (const profile of this.listProfiles(tenantId)) {
      const key = profileKey(profile);
      if (!profile.enabled) {
        groups.push(toGroup(profile, "unavailable", profile.models, refreshedAt, "Provider is disabled"));
        continue;
      }
      const discovery = this.discoveries.get(key);
      if (discovery === undefined) {
        this.failures.delete(key);
        groups.push(toGroup(profile, "ready", profile.models, refreshedAt));
        continue;
      }
      try {
        const discovered = await discovery.listModels(profile, signal);
        const models = normalizeModels(profile.id, discovered);
        this.profiles.set(key, { ...profile, models, updatedAt: refreshedAt });
        this.failures.delete(key);
        groups.push(toGroup({ ...profile, models }, "ready", models, refreshedAt));
      } catch (error) {
        const message = boundedErrorMessage(error);
        this.failures.set(key, message);
        // Keep the last static/discovered entries visible when one provider fails.
        groups.push(toGroup(profile, "failed", profile.models, refreshedAt, message));
      }
    }
    this.snapshot = { groups, refreshedAt };
    return this.snapshot;
  }

  snapshotFor(tenantId?: string): ModelCatalogSnapshot {
    const groups = this.snapshot.groups.filter((group) => {
      const profile = this.profile(group.provider, tenantId);
      return profile !== undefined && (profile.tenantId === undefined || profile.tenantId === tenantId);
    });
    return { groups, refreshedAt: this.snapshot.refreshedAt };
  }

  resolve(provider: string, model: string, tenantId?: string): { readonly profile: ProviderProfileRecord; readonly catalogEntry?: ModelCatalogEntry } {
    const profile = this.profile(provider, tenantId);
    if (profile === undefined || !profile.enabled) throw new ModelConfigurationError(`Provider is unavailable: ${provider}`);
    const catalogEntry = profile.models.find((entry) => entry.model === model);
    return { profile, ...(catalogEntry === undefined ? {} : { catalogEntry }) };
  }
}

/** Build a provider-neutral ChatModel from a profile and host-owned credential material. */
export function createModelFromProviderProfile(
  profile: ProviderProfileRecord,
  model: string,
  credential?: ProviderCredentialMaterial,
  registry: ModelProtocolRegistry = createBuiltInModelProtocolRegistry(),
): { readonly model: ChatModel; readonly config: { readonly provider: string; readonly model: string; readonly baseUrl?: string; readonly configured: boolean }; readonly capability?: ModelContextCapability } {
  if (!profile.enabled) throw new ModelConfigurationError(`Provider is disabled: ${profile.id}`);
  const entry = profile.models.find((item) => item.model === model);
  const env = credential?.env ?? {};
  const headers = credential?.headers;
  const apiKey = env["API_KEY"] ?? env["apiKey"] ?? env["ANTHROPIC_API_KEY"] ?? env["ANTHROPIC_AUTH_TOKEN"] ?? env["DEEPSEEK_API_KEY"] ?? env["OPENAI_API_KEY"];
  const modelConfig = {
    model,
    ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(headers === undefined ? {} : { headers }),
    ...(entry?.contextCapability === undefined ? {} : { contextCapability: entry.contextCapability }),
    ...(entry?.defaultMaxOutputTokens === undefined ? {} : { maxOutputTokens: entry.defaultMaxOutputTokens }),
  };
  const created = registry.create(profile.protocol, modelConfig);
  return {
    model: created,
    config: { provider: profile.id, model, ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }), configured: apiKey !== undefined || headers !== undefined || profile.source === "builtin" },
    ...(entry?.contextCapability === undefined ? {} : { capability: entry.contextCapability }),
  };
}

function profileKey(profile: ProviderProfileRecord): string {
  return `${profile.tenantId ?? ""}\u0000${profile.id}`;
}

function validateProfile(profile: ProviderProfileRecord): void {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(profile.id)) throw new ModelConfigurationError("Provider id must be a lowercase identifier");
  if (profile.displayName.trim() === "") throw new ModelConfigurationError("Provider displayName is required");
  if (profile.protocol.trim() === "") throw new ModelConfigurationError("Provider protocol is required");
  if (profile.baseUrl !== undefined) {
    try {
      const url = new URL(profile.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("invalid baseUrl");
    } catch {
      throw new ModelConfigurationError("Provider baseUrl must be an http(s) URL without credentials or query data");
    }
  }
  if (!Number.isInteger(profile.revision) || profile.revision < 1) throw new ModelConfigurationError("Provider revision must be a positive integer");
  for (const model of profile.models) {
    if (model.provider !== profile.id || model.model.trim() === "") throw new ModelConfigurationError("Provider catalog model is invalid");
  }
}

function normalizeModels(provider: string, models: readonly ModelCatalogEntry[]): readonly ModelCatalogEntry[] {
  const seen = new Set<string>();
  const result: ModelCatalogEntry[] = [];
  for (const model of models) {
    if (model.provider !== provider || model.model.trim() === "" || seen.has(model.model)) continue;
    seen.add(model.model);
    result.push(model);
  }
  return result;
}

function toGroup(profile: ProviderProfileRecord, status: ProviderCatalogGroup["status"], models: readonly ModelCatalogEntry[], refreshedAt: string, error?: string): ProviderCatalogGroup {
  return {
    provider: profile.id,
    displayName: profile.displayName,
    protocol: profile.protocol,
    enabled: profile.enabled,
    source: profile.source ?? "custom",
    status,
    models,
    refreshedAt,
    ...(error === undefined ? {} : { error: error.slice(0, 300) }),
  };
}

function boundedErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return String(error).slice(0, 300);
}
