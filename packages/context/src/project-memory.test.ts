import { describe, expect, it } from "vitest";
import {
  parseProjectMemoryIndex,
  recallRelevantProjectMemory,
  selectProjectMemoryHeaders,
  truncateProjectMemoryEntrypoint,
  validateProjectMemoryTopic,
  type ProjectMemoryScope,
  type ProjectMemoryStore,
} from "./project-memory.js";

const scope: ProjectMemoryScope = { sessionId: "ses_test", workspaceRoot: "D:/workspace", tenantId: "tenant-a", scopeKey: "pm_test" };

describe("M12 Project Memory", () => {
  it("bounds MEMORY.md by lines and emits a warning", () => {
    const result = truncateProjectMemoryEntrypoint(Array.from({ length: 205 }, (_, index) => `line ${index}`).join("\n"));
    expect(result.wasLineTruncated).toBe(true);
    expect(result.lineCount).toBe(205);
    expect(result.content.split("\n")).toContain("line 199");
    expect(result.content).not.toContain("line 200");
    expect(result.warning).toContain("MEMORY.md exceeded");
  });

  it("bounds UTF-8 content by bytes without splitting a code point", () => {
    const result = truncateProjectMemoryEntrypoint("中".repeat(20_000));
    expect(result.wasByteTruncated).toBe(true);
    expect(new TextEncoder().encode(result.content.split("\n\n> WARNING:")[0] ?? "").byteLength).toBeLessThanOrEqual(25_000);
    expect(result.content).not.toContain("�");
  });

  it("parses safe index links and rejects traversal paths", () => {
    expect(parseProjectMemoryIndex("- [Deploy](topics/deploy.md) — release procedure\n- [Bad](../secret.md)\n- [Absolute](/tmp/secret.md)")).toEqual([
      { id: "topics/deploy.md", path: "topics/deploy.md", title: "Deploy", description: "release procedure" },
    ]);
  });

  it("ranks relevant topics and caps recall at five", () => {
    const headers = Array.from({ length: 8 }, (_, index) => ({ id: `topic-${index}`, path: `topics/${index}.md`, title: index < 6 ? `Deploy ${index}` : `Other ${index}`, description: "release" }));
    expect(selectProjectMemoryHeaders(headers, "deploy release", 99)).toHaveLength(5);
    expect(selectProjectMemoryHeaders(headers, "deploy release")[0]?.id).toBe("topic-0");
  });

  it("recalls each topic once and excludes stale references", async () => {
    const topics = [
      { id: "deploy", path: "topics/deploy.md", title: "Deploy", description: "release", type: "project" as const, content: "Deploy with pnpm." , references: [{ kind: "path" as const, value: "scripts/deploy.ts" }] },
      { id: "old", path: "topics/old.md", title: "Old", description: "release", type: "feedback" as const, content: "Old advice.", references: [{ kind: "path" as const, value: "missing.ts" }] },
    ];
    const store: ProjectMemoryStore = {
      async getEntrypoint() { return { content: "- [Deploy](topics/deploy.md)" }; },
      async listTopics() { return topics; },
      async readTopic(_scope, id) { return topics.find((topic) => topic.id === id); },
    };
    const first = await recallRelevantProjectMemory(store, scope, "deploy release", {
      validate: (topic, scoped) => validateProjectMemoryTopic(topic, { pathExists: async (path) => path !== "missing.ts" }, scoped),
    });
    expect(first.topics.map((topic) => topic.id)).toEqual(["deploy"]);
    expect(first.staleTopicIds).toEqual(["old"]);
    const second = await recallRelevantProjectMemory(store, scope, "deploy release", { alreadySurfacedIds: new Set(["deploy", "old"]) });
    expect(second.topics).toEqual([]);
    expect(second.candidateCount).toBe(0);
  });
});
