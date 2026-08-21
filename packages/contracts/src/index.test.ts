import { describe, expect, it } from "vitest";
import { brand, type SessionId } from "./index.js";

describe("contracts", () => {
  it("brands runtime identifiers without changing their serialized value", () => {
    const id = brand<string, "SessionId">("session-1");
    const sessionId: SessionId = id;
    expect(sessionId).toBe("session-1");
    expect(JSON.stringify(sessionId)).toBe('"session-1"');
  });
});
