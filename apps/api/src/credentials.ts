import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CredentialBackend, CredentialRecord, McpCredentialReference } from "@coding-agent/contracts";

export interface CredentialMaterial {
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CredentialInput {
  readonly kind: McpCredentialReference["kind"];
  readonly label?: string;
  readonly material: CredentialMaterial;
}

export interface SecretReference {
  readonly tenantId: string;
  readonly credentialId: string;
  readonly version: number;
}

export interface SecretProvider {
  readonly kind: "host-only" | "external";
  put(reference: SecretReference, material: CredentialMaterial): void;
  get(reference: SecretReference): CredentialMaterial | undefined;
  delete(reference: SecretReference): void;
}

export interface ExternalSecretManager {
  put(reference: SecretReference, material: CredentialMaterial): void;
  get(reference: SecretReference): CredentialMaterial | undefined;
  delete(reference: SecretReference): void;
}

export class HostOwnedSecretProvider implements SecretProvider {
  readonly kind = "host-only" as const;
  private readonly material = new Map<string, CredentialMaterial>();

  put(reference: SecretReference, material: CredentialMaterial): void { this.material.set(secretKey(reference), cloneMaterial(material)); }
  get(reference: SecretReference): CredentialMaterial | undefined {
    const material = this.material.get(secretKey(reference));
    return material === undefined ? undefined : cloneMaterial(material);
  }
  delete(reference: SecretReference): void { this.material.delete(secretKey(reference)); }
}

export interface LocalFileSecretProviderOptions {
  /** Absolute or process-relative path owned by the API host. */
  readonly filePath: string;
}

interface LocalSecretFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, CredentialMaterial>>;
}

/**
 * Host-local durable secret provider.
 *
 * The file contains only the secret material map and is never returned through
 * the credential API, events, projections, or logs. Writes are atomic so a
 * process interruption cannot leave a partially-written credential file.
 */
export class LocalFileSecretProvider implements SecretProvider {
  readonly kind = "host-only" as const;
  readonly filePath: string;
  private readonly material = new Map<string, CredentialMaterial>();
  private unavailable = false;

  constructor(options: LocalFileSecretProviderOptions) {
    this.filePath = path.resolve(options.filePath);
    this.load();
  }

  put(reference: SecretReference, material: CredentialMaterial): void {
    this.ensureAvailable();
    const key = secretKey(reference);
    const previous = this.material.get(key);
    this.material.set(key, cloneMaterial(material));
    try {
      this.persist();
    } catch (error) {
      if (previous === undefined) this.material.delete(key);
      else this.material.set(key, previous);
      throw error;
    }
  }

  get(reference: SecretReference): CredentialMaterial | undefined {
    if (this.unavailable) return undefined;
    const value = this.material.get(secretKey(reference));
    return value === undefined ? undefined : cloneMaterial(value);
  }

  delete(reference: SecretReference): void {
    this.ensureAvailable();
    const key = secretKey(reference);
    const previous = this.material.get(key);
    if (previous === undefined) return;
    this.material.delete(key);
    try {
      this.persist();
    } catch (error) {
      this.material.set(key, previous);
      throw error;
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) throw new Error("invalid credential file");
      for (const [key, value] of Object.entries(parsed.entries)) {
        const material = parseStoredMaterial(value);
        if (material === undefined) throw new Error("invalid credential material");
        this.material.set(key, material);
      }
    } catch {
      // Fail closed: existing metadata remains visible, but no secret is
      // resolved and mutations are rejected until the file is repaired.
      this.unavailable = true;
      this.material.clear();
    }
  }

  private persist(): void {
    this.ensureAvailable();
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const payload: LocalSecretFile = { version: 1, entries: Object.fromEntries(this.material) };
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(payload) + "\n", { encoding: "utf8", mode: 0o600 });
      // chmod is effective on POSIX and harmless on Windows. Windows ACLs are
      // inherited from the user-owned application data directory.
      try { chmodSync(temporary, 0o600); } catch { /* platform without chmod */ }
      renameSync(temporary, this.filePath);
      try { chmodSync(this.filePath, 0o600); } catch { /* platform without chmod */ }
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  private ensureAvailable(): void {
    if (this.unavailable) throw new Error("Local credential secret store is unavailable");
  }
}

/** Adapter boundary for a vault such as KMS/Vault/Secrets Manager. */
export class ExternalSecretProvider implements SecretProvider {
  readonly kind = "external" as const;
  constructor(private readonly manager: ExternalSecretManager) {}
  put(reference: SecretReference, material: CredentialMaterial): void { this.manager.put(reference, cloneMaterial(material)); }
  get(reference: SecretReference): CredentialMaterial | undefined {
    const material = this.manager.get(reference);
    return material === undefined ? undefined : cloneMaterial(material);
  }
  delete(reference: SecretReference): void { this.manager.delete(reference); }
}

export class CredentialLifecycleError extends Error {
  constructor(readonly code: "CREDENTIAL_BACKEND_NOT_CONFIGURED" | "CREDENTIAL_NOT_FOUND" | "CREDENTIAL_REFERENCE_INVALID" | "CREDENTIAL_IN_USE" | "CREDENTIAL_SECRET_PROVIDER_UNAVAILABLE", message: string) {
    super(message);
    this.name = "CredentialLifecycleError";
  }
}

/**
 * Host-owned credential lifecycle. Durable storage contains metadata only;
 * material is process-local and missing material always resolves fail-closed.
 */
export class CredentialVault {
  constructor(private readonly backend?: CredentialBackend, private readonly secretProvider: SecretProvider = new HostOwnedSecretProvider()) {}

  secretStoreKind(): SecretProvider["kind"] { return this.secretProvider.kind; }

  list(tenantId: string): readonly CredentialRecord[] {
    return this.requireBackend().listCredentials(tenantId);
  }

  create(tenantId: string, input: CredentialInput): CredentialRecord {
    const now = new Date().toISOString();
    const record: CredentialRecord = {
      id: `cred_${randomUUID()}`,
      tenantId,
      kind: input.kind,
      ...(input.label === undefined ? {} : { label: input.label }),
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const backend = this.requireBackend();
    try {
      backend.upsertCredential(record);
      this.secretProvider.put({ tenantId, credentialId: record.id, version: record.version }, input.material);
    } catch (error) {
      backend.deleteCredential(tenantId, record.id);
      throw new CredentialLifecycleError("CREDENTIAL_SECRET_PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "Secret provider rejected credential material");
    }
    return record;
  }

  rotate(tenantId: string, id: string, input: CredentialInput): CredentialRecord {
    const backend = this.requireBackend();
    const current = backend.getCredential(tenantId, id);
    if (current === undefined) throw new CredentialLifecycleError("CREDENTIAL_NOT_FOUND", "Credential not found");
    if (current.kind !== input.kind) throw new CredentialLifecycleError("CREDENTIAL_REFERENCE_INVALID", "Credential kind cannot change during rotation");
    const { revokedAt: _revokedAt, ...withoutRevocation } = current;
    const next: CredentialRecord = {
      ...withoutRevocation,
      ...(input.label === undefined ? {} : { label: input.label }),
      status: "active",
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    let persisted: CredentialRecord;
    try {
      persisted = withoutUndefinedRevokedAt(backend.upsertCredential(next));
      this.secretProvider.put({ tenantId, credentialId: id, version: next.version }, input.material);
      this.secretProvider.delete({ tenantId, credentialId: id, version: current.version });
    } catch (error) {
      throw new CredentialLifecycleError("CREDENTIAL_SECRET_PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "Secret provider rejected credential material");
    }
    return persisted;
  }

  revoke(tenantId: string, id: string): CredentialRecord {
    const backend = this.requireBackend();
    const current = backend.getCredential(tenantId, id);
    if (current === undefined) throw new CredentialLifecycleError("CREDENTIAL_NOT_FOUND", "Credential not found");
    if (current.status === "revoked") return current;
    const persisted = backend.upsertCredential({ ...current, status: "revoked", updatedAt: new Date().toISOString(), revokedAt: new Date().toISOString() });
    this.secretProvider.delete({ tenantId, credentialId: id, version: current.version });
    return persisted;
  }

  remove(tenantId: string, id: string, referenced: boolean): boolean {
    if (referenced) throw new CredentialLifecycleError("CREDENTIAL_IN_USE", "Credential is still referenced by a model route or MCP server");
    const current = this.requireBackend().getCredential(tenantId, id);
    if (current !== undefined) this.secretProvider.delete({ tenantId, credentialId: id, version: current.version });
    const removed = this.requireBackend().deleteCredential(tenantId, id);
    return removed;
  }

  resolve(reference: McpCredentialReference, tenantId?: string): CredentialMaterial | undefined {
    if (tenantId === undefined || reference.id.trim() === "") return undefined;
    const record = this.requireBackend().getCredential(tenantId, reference.id);
    if (record === undefined || record.status !== "active" || record.kind !== reference.kind) return undefined;
    if (reference.version !== undefined && reference.version !== record.version) return undefined;
    return this.secretProvider.get({ tenantId, credentialId: reference.id, version: record.version });
  }

  reference(record: CredentialRecord): McpCredentialReference {
    return {
      id: record.id,
      kind: record.kind,
      ...(record.label === undefined ? {} : { label: record.label }),
      version: record.version,
    };
  }

  requireReference(tenantId: string, reference: McpCredentialReference): CredentialRecord {
    const record = this.requireBackend().getCredential(tenantId, reference.id);
    if (record === undefined || record.kind !== reference.kind || record.status !== "active" || (reference.version !== undefined && reference.version !== record.version)) {
      throw new CredentialLifecycleError("CREDENTIAL_REFERENCE_INVALID", "Credential reference is missing, revoked, or stale");
    }
    return record;
  }

  private requireBackend(): CredentialBackend {
    if (this.backend === undefined) throw new CredentialLifecycleError("CREDENTIAL_BACKEND_NOT_CONFIGURED", "Credential metadata persistence is not configured");
    return this.backend;
  }
}

function secretKey(reference: SecretReference): string { return `${reference.tenantId}\u0000${reference.credentialId}\u0000${reference.version}`; }

function cloneMaterial(material: CredentialMaterial): CredentialMaterial {
  return {
    ...(material.env === undefined ? {} : { env: { ...material.env } }),
    ...(material.headers === undefined ? {} : { headers: { ...material.headers } }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredMaterial(value: unknown): CredentialMaterial | undefined {
  if (!isRecord(value)) return undefined;
  const env = parseStoredMap(value.env);
  const headers = parseStoredMap(value.headers);
  if (env === undefined && headers === undefined) return undefined;
  return { ...(env === undefined ? {} : { env }), ...(headers === undefined ? {} : { headers }) };
}

function parseStoredMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 32) return undefined;
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(key) || typeof item !== "string" || item.length === 0 || item.length > 16_384) return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function withoutUndefinedRevokedAt(record: CredentialRecord): CredentialRecord {
  if (record.revokedAt !== undefined) return record;
  const { revokedAt: _revokedAt, ...without } = record;
  return without;
}
