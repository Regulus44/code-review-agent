import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { brand, type AgentEvent, type EventStore, type SessionProjection, type SessionId } from "@code-review-agent/contracts";
import { createBuiltinTools } from "./builtin.js";
import { ToolRegistry } from "./registry.js";
import { ToolRuntime } from "./runtime.js";

class QueryStore implements EventStore {
  readonly events: AgentEvent[] = [];
  async append(input: Parameters<EventStore["append"]>[0]): Promise<AgentEvent> {
    const event: AgentEvent = { eventId: `evt_${this.events.length + 1}`, sequence: this.events.length + 1, schemaVersion: 1, sessionId: input.sessionId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }), type: input.type, createdAt: new Date().toISOString(), payload: input.payload };
    this.events.push(event);
    return event;
  }
  async list(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> { return this.events.filter((event) => event.sessionId === sessionId && event.sequence > afterSequence); }
  async project(): Promise<SessionProjection | undefined> { return undefined; }
  subscribe(): () => void { return () => undefined; }
}

describe("Phase 3B.4 tools", () => {
  it("persists goals and supports bounded session recovery queries", async () => {
    const store = new QueryStore();
    const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools({ eventStore: store }));
    const runtime = new ToolRuntime({ store, registry });
    const sessionId = brand<string, "SessionId">("ses_p1_tools");
    const created = await runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "create_goal", input: { title: "Phase 3B", successCriteria: ["Goal is queryable"] } });
    expect(created.status).toBe("completed");
    const queried = await runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "session_query", input: { eventTypes: ["goal/created"], maxResults: 10 } });
    expect(queried.result?.output).toMatchObject({ returned: 1, events: [{ type: "goal/created" }] });
  });

  it("gates image capability and returns bounded PNG artifact metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-image-tool-"));
    try {
      const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(1, 16); png.writeUInt32BE(2, 20);
      await writeFile(path.join(root, "pixel.png"), png);
      const store = new QueryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools({ eventStore: store, visionEnabled: true }));
      const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_image_tool");
      const result = await runtime.execute({ sessionId, workspaceRoot: root, name: "read_image", input: { path: "pixel.png" } });
      expect(result.status).toBe("completed"); expect(result.result?.output).toMatchObject({ artifact: { mediaType: "image/png", width: 1, height: 2, bytes: 24 } });
      const hidden = new ToolRegistry(); hidden.registerMany(createBuiltinTools({ eventStore: store })); expect(hidden.list().some((tool) => tool.name === "read_image")).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("runs the Windows PowerShell smoke path when the host exposes pwsh", async () => {
    const store = new QueryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools({ eventStore: store }));
    const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_pwsh_smoke");
    const pending = await runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "pwsh", input: { command: "Write-Output 'pwsh-smoke'" } });
    expect(pending.status).toBe("awaiting_permission");
    const result = await runtime.resolvePermission(pending.permission!.id, "approved");
    expect(["completed", "failed"]).toContain(result.status);
    if (result.status === "completed") expect(result.result?.output).toContain("pwsh-smoke"); else expect(result.result?.error?.code).toBe("COMMAND_NOT_FOUND");
  });
});
