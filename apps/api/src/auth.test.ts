import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { verifyProductizationJwt } from "./auth.js";

function token(secret: string, payload: Record<string, unknown>, kid = "key-1"): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT", kid });
  const body = encode(payload);
  const signingInput = `${header}.${body}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("Productization JWT verification", () => {
  it("verifies issuer, audience, time window, signature, and principal catalog binding", async () => {
    const catalog = new InMemoryEventStore();
    catalog.upsertPrincipal({ id: "principal-a" as never, subject: "idp|a", tenantId: "tenant-a" as never, roles: ["member"], status: "active", createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
    const now = Math.floor(Date.now() / 1_000);
    const identity = await verifyProductizationJwt(token("secret", { iss: "https://idp.example", aud: "code-review-agent", sub: "idp|a", tenant_id: "tenant-a", iat: now, exp: now + 120 }), { issuer: "https://idp.example", audience: "code-review-agent", keys: [{ kid: "key-1", alg: "HS256", secret: "secret" }] }, catalog);
    expect(identity).toEqual({ principalId: "principal-a", tenantId: "tenant-a" });
  });

  it("fails closed for invalid signature, claims, expiry, and unknown principal", async () => {
    const catalog = new InMemoryEventStore();
    const now = Math.floor(Date.now() / 1_000);
    const options = { issuer: "https://idp.example", audience: "code-review-agent", keys: [{ kid: "key-1", alg: "HS256" as const, secret: "secret" }] };
    await expect(verifyProductizationJwt(token("wrong", { iss: options.issuer, aud: options.audience, sub: "missing", exp: now + 120 }), options, catalog)).rejects.toThrow("signature");
    await expect(verifyProductizationJwt(token("secret", { iss: "wrong", aud: options.audience, sub: "missing", exp: now + 120 }), options, catalog)).rejects.toThrow("issuer");
    await expect(verifyProductizationJwt(token("secret", { iss: options.issuer, aud: options.audience, sub: "missing", exp: now - 120 }), options, catalog)).rejects.toThrow("expired");
    await expect(verifyProductizationJwt(token("secret", { iss: options.issuer, aud: options.audience, sub: "missing", exp: now + 120 }), options, catalog)).rejects.toThrow("principal");
  });

  it("supports host-controlled JWKS refresh for key rotation", async () => {
    const catalog = new InMemoryEventStore();
    catalog.upsertPrincipal({ id: "principal-b" as never, subject: "idp|b", tenantId: "tenant-b" as never, roles: [], status: "active", createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
    const now = Math.floor(Date.now() / 1_000);
    const identity = await verifyProductizationJwt(token("rotated", { iss: "https://idp.example", aud: ["other", "code-review-agent"], sub: "idp|b", exp: now + 120 }, "key-2"), { issuer: "https://idp.example", audience: "code-review-agent", keys: [], jwks: async () => [{ kid: "key-2", alg: "HS256", secret: "rotated" }] }, catalog);
    expect(identity.tenantId).toBe("tenant-b");
  });
});
