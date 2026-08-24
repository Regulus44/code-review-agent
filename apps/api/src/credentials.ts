import { randomUUID } from "node:crypto";
import type { CredentialBackend, CredentialRecord, McpCredentialReference } from "@code-review-agent/contracts";

export interface CredentialMaterial {
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CredentialInput {
  readonly kind: McpCredentialReference["kind"];
  readonly label?: string;
  readonly material: CredentialMaterial;
}

export class CredentialLifecycleError extends Error {
  constructor(readonly code: "CREDENTIAL_BACKEND_NOT_CONFIGURED" | "CREDENTIAL_NOT_FOUND" | "CREDENTIAL_REFERENCE_INVALID" | "CREDENTIAL_IN_USE", message: string) {
    super(message);
    this.name = "CredentialLifecycleError";
  }
}

/**
 * Host-owned credential lifecycle. Durable storage contains metadata only;
 * material is process-local and missing material always resolves fail-closed.
 */
export class CredentialVault {
  private readonly material = new Map<string, CredentialMaterial>();

  constructor(private readonly backend?: CredentialBackend) {}

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
    this.requireBackend().upsertCredential(record);
    this.material.set(key(tenantId, record.id), cloneMaterial(input.material));
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
    const persisted = withoutUndefinedRevokedAt(backend.upsertCredential(next));
    this.material.set(key(tenantId, id), cloneMaterial(input.material));
    return persisted;
  }

  revoke(tenantId: string, id: string): CredentialRecord {
    const backend = this.requireBackend();
    const current = backend.getCredential(tenantId, id);
    if (current === undefined) throw new CredentialLifecycleError("CREDENTIAL_NOT_FOUND", "Credential not found");
    if (current.status === "revoked") return current;
    const persisted = backend.upsertCredential({ ...current, status: "revoked", updatedAt: new Date().toISOString(), revokedAt: new Date().toISOString() });
    this.material.delete(key(tenantId, id));
    return persisted;
  }

  remove(tenantId: string, id: string, referenced: boolean): boolean {
    if (referenced) throw new CredentialLifecycleError("CREDENTIAL_IN_USE", "Credential is still referenced by a model route or MCP server");
    const removed = this.requireBackend().deleteCredential(tenantId, id);
    this.material.delete(key(tenantId, id));
    return removed;
  }

  resolve(reference: McpCredentialReference, tenantId?: string): CredentialMaterial | undefined {
    if (tenantId === undefined || reference.id.trim() === "") return undefined;
    const record = this.requireBackend().getCredential(tenantId, reference.id);
    if (record === undefined || record.status !== "active" || record.kind !== reference.kind) return undefined;
    if (reference.version !== undefined && reference.version !== record.version) return undefined;
    const material = this.material.get(key(tenantId, reference.id));
    return material === undefined ? undefined : cloneMaterial(material);
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

function key(tenantId: string, id: string): string {
  return `${tenantId}\u0000${id}`;
}

function cloneMaterial(material: CredentialMaterial): CredentialMaterial {
  return {
    ...(material.env === undefined ? {} : { env: { ...material.env } }),
    ...(material.headers === undefined ? {} : { headers: { ...material.headers } }),
  };
}

function withoutUndefinedRevokedAt(record: CredentialRecord): CredentialRecord {
  if (record.revokedAt !== undefined) return record;
  const { revokedAt: _revokedAt, ...without } = record;
  return without;
}
