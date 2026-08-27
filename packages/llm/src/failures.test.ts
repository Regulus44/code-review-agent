import { describe, expect, it } from "vitest";
import { ModelFailureError, modelFailureMetadata, parseRetryAfter, retryDelayMs, sanitizeFailureMessage } from "./failures.js";

describe("model failure taxonomy", () => {
  it("normalizes status and provider facts without exposing response bodies", () => {
    const error = new ModelFailureError("Bearer sk-secret-token failed", {
      code: "RATE_LIMIT",
      status: 429,
      retryable: true,
      retryAfterMs: 1_000,
      requestId: "req_fixture",
    });
    expect(error.message).toBe("Bearer [redacted] failed");
    expect(modelFailureMetadata(error)).toMatchObject({ code: "RATE_LIMIT", status: 429, retryable: true, retryAfterMs: 1_000, requestId: "req_fixture" });
  });

  it("parses seconds and HTTP-date retry-after values with a bounded delay", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:59 GMT"))).toBe(1_000);
    expect(retryDelayMs(1, 999_999)).toBe(30_000);
  });

  it("redacts bearer and token-like material from diagnostics", () => {
    expect(sanitizeFailureMessage("Authorization: Bearer abcdefghijkl and sk-1234567890")).toContain("[redacted]");
  });
});
