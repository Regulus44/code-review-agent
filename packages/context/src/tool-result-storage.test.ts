import { describe, expect, it } from "vitest";
import {
  buildSkillResourceModelView,
  buildToolResultModelView,
  createToolResultStorage,
  DEFAULT_TOOL_RESULT_MAX_TOKENS,
  DEFAULT_TOOL_RESULT_PERSIST_THRESHOLD_CHARS,
  DEFAULT_TOOL_RESULT_PREVIEW_BYTES,
  truncateUtf8,
  InMemorySkillResourceArtifactStore,
  skillResourceArtifactId,
} from "./tool-result-storage.js";

describe("tool-result-storage", () => {
  it("keeps Skill resource snapshots in an immutable host-owned store", async () => {
    const store = new InMemorySkillResourceArtifactStore();
    const artifactId = skillResourceArtifactId("ses_1", "review", "references/checklist.md", "digest-1");
    expect(await store.write({ artifactId, sessionId: "ses_1", skill: "review", path: "references/checklist.md", content: "alpha", digest: "digest-1" })).toBe("created");
    expect(await store.write({ artifactId, sessionId: "ses_1", skill: "review", path: "references/checklist.md", content: "alpha", digest: "digest-1" })).toBe("exists");
    expect(await store.read({ artifactId, sessionId: "ses_1" })).toEqual({ content: "alpha", digest: "digest-1" });
    expect(await store.read({ artifactId, sessionId: "other" })).toBeUndefined();
    const receipt = { kind: "skill-resource" as const, artifactId, skill: "review", path: "references/checklist.md", sizeBytes: 5, digest: "digest-1" };
    expect(buildSkillResourceModelView(receipt, "alpha")).toContain('status="available"');
    expect(buildSkillResourceModelView(receipt)).toContain('status="unavailable"');
  });

  it("keeps results at or below the threshold in memory", async () => {
    const writes: string[] = [];
    const storage = createToolResultStorage({ write: async (input) => { writes.push(input.relativePath); return "created"; } });
    const result = await storage.persist({ sessionId: "ses_1", workspaceRoot: ".", toolCallId: "call_1", content: "x".repeat(DEFAULT_TOOL_RESULT_PERSIST_THRESHOLD_CHARS) });
    expect(result.status).toBe("not-needed");
    expect(result.modelView).toHaveLength(DEFAULT_TOOL_RESULT_PERSIST_THRESHOLD_CHARS);
    expect(writes).toEqual([]);
  });

  it("persists oversized text with a bounded UTF-8 preview", async () => {
    const writes: string[] = [];
    const storage = createToolResultStorage({ write: async (input) => { writes.push(input.relativePath); expect(input.content).toContain("终"); return "created"; } });
    const content = "终".repeat(50_001);
    const result = await storage.persist({ sessionId: "ses_1", workspaceRoot: ".", toolCallId: "call_1", content });
    expect(result.status).toBe("persisted");
    expect(result.replacement?.relativePath).toBe(".agent-artifacts/tool-results/ses_1/call_1.txt");
    expect(result.replacement?.previewBytes).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_PREVIEW_BYTES);
    expect(result.modelView).toContain(".agent-artifacts/tool-results/ses_1/call_1.txt");
    expect(result.modelView).not.toContain(content.slice(0, 10_000));
    expect(writes).toEqual([".agent-artifacts/tool-results/ses_1/call_1.txt"]);
  });

  it("enforces the token hard cap independently of the character threshold", async () => {
    const storage = createToolResultStorage({ write: async () => "created" }, { maxTokens: 1_000 });
    const result = await storage.persist({ sessionId: "ses_1", workspaceRoot: ".", toolCallId: "token_call", content: "x".repeat(4_100), thresholdChars: 50_000 });
    expect(result.status).toBe("persisted");
    expect(result.replacement?.reason).toBe("max-tokens");
    expect(result.replacement?.originalTokens).toBeGreaterThan(1_000);
  });

  it("uses json artifacts for structured text and excludes media blocks", async () => {
    const writes: string[] = [];
    const storage = createToolResultStorage({ write: async (input) => { writes.push(input.relativePath); return "created"; } });
    const json = JSON.stringify({ values: "x".repeat(50_001) });
    const structured = await storage.persist({ sessionId: "ses_1", workspaceRoot: ".", toolCallId: "json_call", content: json });
    expect(structured.replacement?.relativePath).toBe(".agent-artifacts/tool-results/ses_1/json_call.json");
    const media = await storage.persist({ sessionId: "ses_1", workspaceRoot: ".", toolCallId: "image_call", content: JSON.stringify([{ type: "image", data: "x".repeat(100_000) }]) });
    expect(media.status).toBe("unsupported");
    expect(writes).toEqual([".agent-artifacts/tool-results/ses_1/json_call.json"]);
  });

  it("fails closed when artifact persistence fails", async () => {
    const storage = createToolResultStorage({ write: async () => { throw new Error("disk full"); } });
    const content = "x".repeat(50_001);
    const result = await storage.persist({ sessionId: "ses_1", workspaceRoot: ".", toolCallId: "call_1", content });
    expect(result.status).toBe("failed");
    expect(result.replacement?.reason).toBe("persistence-failed");
    expect(result.modelView).toContain("unavailable");
    expect(result.modelView).not.toContain(content.slice(0, 10_000));
  });

  it("redacts credential-shaped values from the preview but preserves the artifact", async () => {
    let written = "";
    const storage = createToolResultStorage({
      write: async (input) => {
        written = input.content;
        return "created";
      },
    });
    const content = [
      "api_key=secret-value",
      "Authorization: Bearer bearer-secret-value",
      JSON.stringify({ access_token: "json-secret-value", payload: "x".repeat(50_000) }),
    ].join("\n");
    const result = await storage.persist({
      sessionId: "ses_1",
      workspaceRoot: ".",
      toolCallId: "redaction_call",
      content,
    });

    expect(result.status).toBe("persisted");
    expect(result.replacement?.preview).toContain("api_key=[REDACTED]");
    expect(result.replacement?.preview).toContain("Authorization: [REDACTED]");
    expect(result.replacement?.preview).toContain('access_token":"[REDACTED]"');
    expect(result.replacement?.preview).not.toContain("secret-value");
    expect(result.replacement?.preview).not.toContain("bearer-secret-value");
    expect(result.replacement?.preview).not.toContain("json-secret-value");
    expect(written).toContain("api_key=secret-value");
    expect(written).toContain("bearer-secret-value");
    expect(written).toContain("json-secret-value");
  });

  it("treats repeated exclusive creation as idempotent", async () => {
    let writes = 0;
    const storage = createToolResultStorage({ write: async () => { writes += 1; return writes === 1 ? "created" : "exists"; } });
    const input = { sessionId: "ses_1", workspaceRoot: ".", toolCallId: "call_1", content: "x".repeat(50_001) };
    const first = await storage.persist(input);
    const second = await storage.persist(input);
    expect(first.replacement).toEqual(second.replacement);
    expect(second.status).toBe("persisted");
    expect(writes).toBe(2);
  });

  it("does not split a UTF-8 code point in the preview", () => {
    const preview = truncateUtf8("😀".repeat(1_000), 2_000);
    expect(Buffer.byteLength(preview, "utf8")).toBe(2_000);
    expect(preview.endsWith("😀")).toBe(true);
    expect(buildToolResultModelView({
      kind: "tool-result",
      toolCallId: "call_1",
      artifact: { id: "artifact_1", kind: "file", label: "result", path: ".agent-artifacts/tool-results/ses_1/call_1.txt" },
      relativePath: ".agent-artifacts/tool-results/ses_1/call_1.txt",
      originalChars: 50_001,
      originalBytes: 50_001,
      originalTokens: DEFAULT_TOOL_RESULT_MAX_TOKENS,
      thresholdChars: DEFAULT_TOOL_RESULT_PERSIST_THRESHOLD_CHARS,
      preview,
      previewBytes: 2_000,
      reason: "max-chars",
    }, true)).toContain("preview");
  });
});
