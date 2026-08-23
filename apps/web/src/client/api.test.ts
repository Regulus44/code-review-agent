import { describe, expect, it } from "vitest";
import { ApiError, WebApiClient } from "./api.js";

describe("WebApiClient", () => {
  it("builds typed requests and preserves idempotency headers", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317/",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ turnId: "turn_1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await client.sendMessage("ses_1" as never, "hello", "cmd_1");

    expect(calls[0]?.url).toBe("http://localhost:4317/v1/sessions/ses_1");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe("cmd_1");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ content: "hello" }));
  });

  it("normalizes non-2xx JSON responses as ApiError", async () => {
    const client = new WebApiClient({
      fetcher: async () => new Response(JSON.stringify({ error: "permission denied" }), { status: 403, headers: { "content-type": "application/json" } }),
    });

    await expect(client.health()).rejects.toMatchObject({ status: 403, message: "permission denied" });
    try {
      await client.health();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).body).toEqual({ error: "permission denied" });
    }
  });

  it("builds replay URLs from the last sequence", () => {
    const client = new WebApiClient({ baseUrl: "http://localhost:4317" });
    expect(client.eventsUrl("ses/with space" as never, 12)).toBe("http://localhost:4317/v1/sessions/ses%2Fwith%20space/events?after_sequence=12");
  });
});
