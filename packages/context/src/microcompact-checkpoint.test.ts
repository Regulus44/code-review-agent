import { describe, expect, it } from "vitest";
import { buildMicrocompactCheckpoint, validateMicrocompactCheckpoint } from "./microcompact-checkpoint.js";

describe("microcompact checkpoint", () => {
  it("extracts bounded facts without tool output bodies or absolute paths", () => {
    const checkpoint = buildMicrocompactCheckpoint({
      checkpointId: "mc_1",
      messages: [{ role: "user", content: "Fix the parser" }],
      events: [
        { eventId: "1", sequence: 1, schemaVersion: 1, sessionId: "s" as never, createdAt: new Date().toISOString(), type: "tool/call", payload: { toolCallId: "c1", name: "read_file", input: { path: "D:\\repo\\src\\parser.ts" } } },
        { eventId: "2", sequence: 2, schemaVersion: 1, sessionId: "s" as never, createdAt: new Date().toISOString(), type: "tool/result", payload: { toolCallId: "c1", result: { ok: true, output: "SECRET_PROVIDER_BODY" } } },
      ],
    });
    validateMicrocompactCheckpoint(checkpoint);
    expect(checkpoint.filesRead).toEqual(["repo/src/parser.ts"]);
    expect(JSON.stringify(checkpoint)).not.toContain("SECRET_PROVIDER_BODY");
    expect(JSON.stringify(checkpoint)).not.toContain("D:\\\\repo");
  });

  it("rejects an over-budget checkpoint", () => {
    const checkpoint = buildMicrocompactCheckpoint({ checkpointId: "mc_2", maxChars: 512, messages: [{ role: "user", content: "x".repeat(2000) }], events: [] });
    expect(() => validateMicrocompactCheckpoint(checkpoint)).toThrow("CHECKPOINT_TOO_LARGE");
  });
});
