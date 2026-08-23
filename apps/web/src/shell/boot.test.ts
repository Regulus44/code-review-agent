import { describe, expect, it } from "vitest";
import { createShellBootState, normalizeBootError, presentShellBoot, reduceShellBoot } from "./boot.js";

describe("shell boot state", () => {
  it("starts in a typed loading state and reaches ready", () => {
    const booting = createShellBootState();
    expect(booting).toEqual({ status: "booting" });
    expect(reduceShellBoot(booting, { type: "ready" })).toEqual({ status: "ready" });
    expect(presentShellBoot(booting)).toMatchObject({ status: "booting", appBusy: true, retryable: false });
  });

  it("normalizes unknown failures and presents a retryable boundary", () => {
    const failed = reduceShellBoot(createShellBootState(), { type: "failed", error: new Error("host unavailable") });
    expect(failed).toEqual({ status: "failed", error: "host unavailable", retryable: true });
    expect(presentShellBoot(failed)).toMatchObject({ title: "Unable to connect", message: "host unavailable", retryable: true });
    expect(normalizeBootError({})).toBe("The Coding Agent host did not respond.");
  });

  it("bounds failure text without losing the typed status", () => {
    const failed = reduceShellBoot(createShellBootState(), { type: "failed", error: "x".repeat(500) });
    const intent = presentShellBoot(failed, 80);
    expect(intent.status).toBe("failed");
    expect(intent.message.length).toBeLessThanOrEqual(80);
  });
});
