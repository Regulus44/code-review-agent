import { describe, expect, it } from "vitest";
import {
  parseProjectMemoryIndex,
  buildProjectMemoryRecallCandidates,
  recallRelevantProjectMemory,
  selectProjectMemoryHeaders,
  truncateProjectMemoryEntrypoint,
  validateProjectMemoryTopic,
  type ProjectMemoryScope,
  type ProjectMemoryStore,
  type ProjectMemoryTopic,
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

  it("uses MEMORY.md links as the deterministic lexical manifest", () => {
    const headers = [
      { id: "deploy", path: "topics/deploy.md", title: "Deployment", description: "release" },
      { id: "secret", path: "topics/secret.md", title: "Secret", description: "credentials" },
    ];
    expect(buildProjectMemoryRecallCandidates(headers, "- [Ship](topics/deploy.md) — production release")).toMatchObject([{ id: "deploy", title: "Ship", description: "production release" }]);
    expect(buildProjectMemoryRecallCandidates(headers, "- [Missing](topics/missing.md)")).toEqual([]);
  });

  it("fails closed for a topic read error while retaining deterministic results", async () => {
    const store: ProjectMemoryStore = {
      getEntrypoint: async () => undefined,
      listTopics: async () => [{ id: "broken", path: "topics/broken.md", title: "Broken" }],
      readTopic: async () => { throw new Error("half-written"); },
    };
    const result = await recallRelevantProjectMemory(store, scope, "broken");
    expect(result.topics).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.failedTopicIds).toEqual(["broken"]);
  });

  it("measures the R3 lexical fixture with fixed gold sets, stale filtering, and turn-local deduplication", async () => {
    const topics = [
      { id: "deploy-runbook", path: "topics/deploy-runbook.md", title: "Production Deployment Runbook", description: "release checklist canary safeguards", type: "project" as const, content: "Run the production deployment checklist." },
      { id: "deploy-verification", path: "topics/deploy-verification.md", title: "Deployment Verification Guide", description: "production release smoke health checks", type: "project" as const, content: "Verify deployment health after release." },
      // These two topics overlap lexically with the gold topics but are intentionally unrelated to operating a deployment.
      { id: "release-copy-style", path: "topics/release-copy-style.md", title: "Deployment Copy Style", description: "release announcement typography", type: "reference" as const, content: "Editorial style for release announcements." },
      { id: "release-calendar-template", path: "topics/release-calendar-template.md", title: "Release Calendar Template", description: "deployment communications schedule", type: "reference" as const, content: "Template for publication dates." },
      { id: "legacy-deployment", path: "topics/legacy-deployment.md", title: "Legacy Deployment Procedure", description: "production release rollback", type: "feedback" as const, content: "Obsolete deployment advice.", references: [{ kind: "path" as const, value: "scripts/legacy-release.ts" }] },
      { id: "onboarding", path: "topics/onboarding.md", title: "Contributor Onboarding", description: "local setup orientation", type: "project" as const, content: "Onboarding notes." },
      { id: "incident-triage", path: "topics/incident-triage.md", title: "Incident Triage", description: "severity response procedure", type: "project" as const, content: "Incident response notes." },
      { id: "database-indexes", path: "topics/database-indexes.md", title: "Database Indexes", description: "query performance tuning", type: "project" as const, content: "Database notes." },
      { id: "test-conventions", path: "topics/test-conventions.md", title: "Test Conventions", description: "fixture naming policy", type: "project" as const, content: "Test notes." },
      { id: "frontend-a11y", path: "topics/frontend-a11y.md", title: "Frontend Accessibility", description: "keyboard navigation", type: "project" as const, content: "Accessibility notes." },
    ] satisfies readonly ProjectMemoryTopic[];
    const queries = [
      { query: "production deployment release checklist", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "deployment release canary verification", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "production release smoke check deployment", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "deployment health verification", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "production deployment rollout checklist", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "release verification after deployment", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "deployment checklist for production", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "production release canary deployment", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "verify release deployment health", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
      { query: "deployment production release safeguards", goldTopicIds: ["deploy-runbook", "deploy-verification"] },
    ] as const;
    const store: ProjectMemoryStore = {
      async getEntrypoint() { return { content: topics.map((topic) => `- [${topic.title}](${topic.path}) — ${topic.description}`).join("\n") }; },
      async listTopics() { return topics; },
      async readTopic(_scope, id) { return topics.find((topic) => topic.id === id); },
    };
    const validate = (topic: ProjectMemoryTopic, scoped: ProjectMemoryScope) => validateProjectMemoryTopic(
      topic,
      { pathExists: async (path) => path !== "scripts/legacy-release.ts" },
      scoped,
    );
    const modelViewTopicIds = new Set<string>();
    const surfacedStaleTopicIds = new Set<string>();
    let goldHits = 0;
    let goldTotal = 0;
    let duplicateInjections = 0;
    let staleCandidateOccurrences = 0;
    let staleSuppressedOccurrences = 0;

    for (const testCase of queries) {
      const first = await recallRelevantProjectMemory(store, scope, testCase.query, { validate });
      const recalledIds = first.topics.map((topic) => topic.id);
      expect(recalledIds.length).toBeLessThanOrEqual(5);
      expect(recalledIds).toEqual(expect.arrayContaining([...testCase.goldTopicIds]));
      expect(recalledIds).toEqual(expect.arrayContaining(["release-copy-style", "release-calendar-template"]));
      expect(first.staleTopicIds).toEqual(["legacy-deployment"]);
      staleCandidateOccurrences += 1;
      if (!recalledIds.includes("legacy-deployment")) staleSuppressedOccurrences += 1;
      for (const topicId of testCase.goldTopicIds) if (recalledIds.includes(topicId)) goldHits += 1;
      goldTotal += testCase.goldTopicIds.length;
      for (const topicId of recalledIds) modelViewTopicIds.add(topicId);
      for (const topicId of first.staleTopicIds) surfacedStaleTopicIds.add(topicId);

      // A second lookup in the same turn receives every surfaced id and must not inject it again.
      const alreadySurfacedIds = new Set([...recalledIds, ...first.staleTopicIds, ...first.failedTopicIds]);
      const repeated = await recallRelevantProjectMemory(store, scope, testCase.query, { alreadySurfacedIds, validate });
      duplicateInjections += repeated.topics.filter((topic) => alreadySurfacedIds.has(topic.id)).length;
      expect(repeated.topics.every((topic) => !alreadySurfacedIds.has(topic.id))).toBe(true);
      expect(repeated.staleTopicIds).toEqual([]);
    }

    // R3 fixture metrics: Recall@5 = 20/20; the single stale topic is
    // suppressed in all 10 query occurrences; duplicate injections = 0.
    expect(goldHits).toBe(20);
    expect(goldTotal).toBe(20);
    expect(staleSuppressedOccurrences).toBe(10);
    expect(staleCandidateOccurrences).toBe(10);
    expect([...surfacedStaleTopicIds].filter((topicId) => !modelViewTopicIds.has(topicId))).toEqual(["legacy-deployment"]);
    expect(duplicateInjections).toBe(0);
  });
});
