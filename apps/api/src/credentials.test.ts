import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryEventStore } from "@coding-agent/storage";
import { CredentialLifecycleError, CredentialVault, ExternalSecretProvider, LocalFileSecretProvider, type CredentialMaterial, type SecretReference } from "./credentials.js";

describe("CredentialVault", () => {
  it("keeps material host-local, rotates references, and fails closed after revoke", () => {
    const vault = new CredentialVault(new InMemoryEventStore());
    const created = vault.create("tenant-a", { kind: "header", label: "Provider", material: { headers: { authorization: "Bearer secret-value" } } });
    const reference = vault.reference(created);
    expect(JSON.stringify(created)).not.toContain("secret-value");
    expect(vault.resolve(reference, "tenant-a")).toEqual({ headers: { authorization: "Bearer secret-value" } });
    expect(vault.resolve(reference, "tenant-b")).toBeUndefined();

    const rotated = vault.rotate("tenant-a", created.id, { kind: "header", material: { headers: { authorization: "Bearer rotated-value" } } });
    expect(rotated.version).toBe(2);
    expect(vault.resolve(reference, "tenant-a")).toBeUndefined();
    expect(vault.resolve(vault.reference(rotated), "tenant-a")).toEqual({ headers: { authorization: "Bearer rotated-value" } });

    const revoked = vault.revoke("tenant-a", created.id);
    expect(revoked.status).toBe("revoked");
    expect(vault.resolve(vault.reference(rotated), "tenant-a")).toBeUndefined();
  });

  it("refuses deletion while a caller reports a durable reference", () => {
    const vault = new CredentialVault(new InMemoryEventStore());
    const created = vault.create("tenant-a", { kind: "env", material: { env: { PROVIDER_KEY: "secret-value" } } });
    expect(() => vault.remove("tenant-a", created.id, true)).toThrowError(CredentialLifecycleError);
    expect(vault.remove("tenant-a", created.id, false)).toBe(true);
    expect(vault.list("tenant-a")).toEqual([]);
  });

  it("uses an external secret provider without putting material in credential metadata", () => {
    const remote = new Map<string, CredentialMaterial>();
    const provider = new ExternalSecretProvider({
      put(reference: SecretReference, material: CredentialMaterial): void { remote.set(`${reference.tenantId}:${reference.credentialId}:${reference.version}`, material); },
      get(reference: SecretReference): CredentialMaterial | undefined { return remote.get(`${reference.tenantId}:${reference.credentialId}:${reference.version}`); },
      delete(reference: SecretReference): void { remote.delete(`${reference.tenantId}:${reference.credentialId}:${reference.version}`); },
    });
    const vault = new CredentialVault(new InMemoryEventStore(), provider);
    const created = vault.create("tenant-a", { kind: "header", material: { headers: { authorization: "Bearer external-secret" } } });
    expect(vault.secretStoreKind()).toBe("external");
    expect(JSON.stringify(created)).not.toContain("external-secret");
    expect(vault.resolve(vault.reference(created), "tenant-a")).toEqual({ headers: { authorization: "Bearer external-secret" } });
    vault.revoke("tenant-a", created.id);
    expect(vault.resolve(vault.reference(created), "tenant-a")).toBeUndefined();
  });

  it("persists local secret material across provider instances and updates atomically", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cra-credentials-"));
    const filePath = path.join(directory, "credentials.secrets.json");
    try {
      const first = new LocalFileSecretProvider({ filePath });
      const vault = new CredentialVault(new InMemoryEventStore(), first);
      const created = vault.create("tenant-a", { kind: "header", material: { headers: { authorization: "Bearer local-secret" } } });
      const persisted = JSON.parse(readFileSync(filePath, "utf8")) as { entries: Record<string, CredentialMaterial> };
      expect(persisted.entries[`tenant-a${String.fromCharCode(0)}${created.id}${String.fromCharCode(0)}1`]).toEqual({ headers: { authorization: "Bearer local-secret" } });

      const reopened = new LocalFileSecretProvider({ filePath });
      expect(reopened.get({ tenantId: "tenant-a", credentialId: created.id, version: 1 })).toEqual({ headers: { authorization: "Bearer local-secret" } });
      reopened.delete({ tenantId: "tenant-a", credentialId: created.id, version: 1 });
      expect(new LocalFileSecretProvider({ filePath }).get({ tenantId: "tenant-a", credentialId: created.id, version: 1 })).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the local secret file is malformed", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cra-credentials-invalid-"));
    const filePath = path.join(directory, "credentials.secrets.json");
    try {
      writeFileSync(filePath, "{not-json", "utf8");
      const provider = new LocalFileSecretProvider({ filePath });
      expect(provider.get({ tenantId: "tenant-a", credentialId: "cred_missing", version: 1 })).toBeUndefined();
      expect(() => provider.put({ tenantId: "tenant-a", credentialId: "cred_missing", version: 1 }, { headers: { authorization: "secret" } })).toThrow("unavailable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
