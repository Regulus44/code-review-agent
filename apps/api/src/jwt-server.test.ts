import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { brand } from "@coding-agent/contracts";
import { InMemoryEventStore } from "@coding-agent/storage";
import { createApiServer } from "./server.js";

function jwt(secret: string, payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT", kid: "fixture-key" });
  const body = encode(payload);
  const input = header + "." + body;
  return input + "." + createHmac("sha256", secret).update(input).digest("base64url");
}

describe("API external IdP JWT boundary", () => {
  it("accepts only a verified JWT mapped through the durable principal catalog", async () => {
    const store = new InMemoryEventStore();
    store.upsertPrincipal({ id: brand<string, "PrincipalId">("principal-idp-a"), subject: "idp|a", tenantId: brand<string, "TenantId">("tenant-idp-a"), roles: ["member"], status: "active", createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
    const server = createApiServer({ store, productization: { auth: { required: true, tokens: [], jwt: { issuer: "https://idp.example", audience: "coding-agent", keys: [{ kid: "fixture-key", alg: "HS256", secret: "fixture-secret" }] } } } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("JWT API did not bind");
    const baseUrl = "http://127.0.0.1:" + address.port;
    const now = Math.floor(Date.now() / 1_000);
    const signed = jwt("fixture-secret", { iss: "https://idp.example", aud: "coding-agent", sub: "idp|a", tenant_id: "tenant-idp-a", exp: now + 120 });
    try {
      const capabilities = await fetch(baseUrl + "/v1/capabilities", { headers: { authorization: "Bearer " + signed } });
      expect(capabilities.status).toBe(200);
      expect((await capabilities.json() as { productization: { auth: { mode: string }; multiUser: { principalCatalog: string } } }).productization).toMatchObject({ auth: { mode: "jwt" }, multiUser: { principalCatalog: "external" } });
      const principals = await fetch(baseUrl + "/v1/principals", { headers: { authorization: "Bearer " + signed } });
      expect(principals.status).toBe(200);
      expect((await principals.json() as { principals: { id: string; tenantId: string }[] }).principals).toEqual([{ id: "principal-idp-a", subject: "idp|a", tenantId: "tenant-idp-a", roles: ["member"], status: "active", createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }]);
      const foreign = await fetch(baseUrl + "/v1/principals/principal-missing", { headers: { authorization: "Bearer " + signed } });
      expect(foreign.status).toBe(404);
      const invalid = await fetch(baseUrl + "/v1/capabilities", { headers: { authorization: "Bearer malformed.jwt.value" } });
      expect(invalid.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
