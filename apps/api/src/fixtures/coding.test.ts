import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHost } from "@code-review-agent/runtime";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { seedCodingFixture } from "./coding.js";

describe("Phase 7 coding browser fixture", () => {
  it("seeds completed read-only and recoverable edit/test permission paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase7-coding-test-"));
    try {
      const store = new InMemoryEventStore();
      const host = new AgentHost({ store });
      const fixture = await seedCodingFixture({ store, host, workspaceRoot: root, commandPrefix: "fixture-test" });

      const readProjection = await store.project(fixture.readOnly.sessionId);
      expect(readProjection?.permissionPreset).toBe("read-only");
      expect(readProjection?.toolCalls).toHaveLength(1);
      expect(readProjection?.toolCalls[0]?.status).toBe("completed");
      expect(readProjection?.messages.at(-1)?.content).toContain("fixtureValue = 42");

      const editProjection = await store.project(fixture.edit.sessionId);
      expect(editProjection?.permissionPreset).toBe("ask-on-write");
      expect(editProjection?.permissions).toMatchObject([{ status: "pending", toolName: "edit_file" }]);
      const editResult = await host.resolvePermission(fixture.edit.sessionId, fixture.edit.permission!.id, "approved", "fixture-edit-approve");
      expect(editResult.status).toBe("completed");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await readFile(join(fixture.edit.workspaceRoot, "notes.txt"), "utf8")).toBe("after\n");
      const editToolCall = (await store.project(fixture.edit.sessionId))?.toolCalls.find((toolCall) => toolCall.name === "edit_file");
      expect(editToolCall?.result?.diff).toMatchObject({ before: "before\n", after: "after\n" });

      const testProjection = await store.project(fixture.testRecovery.sessionId);
      expect(testProjection?.permissionPreset).toBe("ask-on-execute");
      expect(testProjection?.permissions).toMatchObject([{ status: "pending", toolName: "run_tests" }]);
      expect(fixture.testRecovery.permission?.expiresAt).toEqual(expect.any(String));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
