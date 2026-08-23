import { describe, expect, it } from "vitest";
import { presentBoundedValue } from "./safe-value.js";

describe("bounded display values", () => {
  it("redacts credential-like fields recursively", () => {
    const value = presentBoundedValue({ token: "secret-token", nested: { password: "pw", ok: true } });
    expect(value.text).toContain('"token": "[redacted]"');
    expect(value.text).toContain('"password": "[redacted]"');
    expect(value.text).toContain('"ok": true');
    expect(value.untrusted).toBe(true);
  });

  it("bounds large values and marks truncation", () => {
    const value = presentBoundedValue({ output: "x".repeat(2_000) }, 256);
    expect(value.truncated).toBe(true);
    expect(value.text.length).toBeLessThanOrEqual(256);
    expect(value.text).toContain("output truncated");
  });

  it("handles primitive and circular values without throwing", () => {
    expect(presentBoundedValue("hello").text).toContain("hello");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(presentBoundedValue(circular).text).toContain("[circular]");
  });
});
