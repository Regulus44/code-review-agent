import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { CredentialLifecycleError, CredentialVault, ExternalSecretProvider, type CredentialMaterial, type SecretReference } from "./credentials.js";

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
});
