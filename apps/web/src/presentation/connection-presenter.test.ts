import { describe, expect, it } from "vitest";
import { presentConnection } from "./connection-presenter.js";

describe("presentConnection", () => {
  it("keeps the healthy and idle shell quiet", () => {
    expect(presentConnection("connected")).toMatchObject({ visible: false, retryable: false });
    expect(presentConnection("idle")).toMatchObject({ visible: false, retryable: false });
  });

  it("shows bounded reconnect and failure guidance", () => {
    expect(presentConnection("reconnecting", "temporary transport error")).toMatchObject({ visible: true, tone: "warning", retryable: false });
    const failed = presentConnection("failed", "x".repeat(500), 80);
    expect(failed).toMatchObject({ visible: true, tone: "error", retryable: true });
    expect(failed.message.length).toBeLessThanOrEqual(80);
  });

  it("distinguishes the initial loading state", () => {
    expect(presentConnection("connecting")).toEqual({ visible: true, tone: "neutral", message: "正在加载会话…", retryable: false });
  });
});
