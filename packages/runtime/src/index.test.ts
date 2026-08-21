import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { AgentHost } from "./index.js";

describe("AgentHost", () => {
  it("runs a streaming turn and persists every visible event", async () => {
    const host = new AgentHost({ store: new InMemoryEventStore() });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "inspect this repository");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.map((event) => event.type)).toContain("assistant/chunk");
    expect(events.at(-1)?.type).toBe("turn/ended");
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("Echo: inspect this repository");
  });

  it("cancels a running turn", async () => {
    const host = new AgentHost({ store: new InMemoryEventStore() });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "cancel me");
    expect(await host.cancelTurn(session.id, turn)).toBe(true);
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "agent/status")).toBe(true);
    expect(events.at(-1)?.payload["status"]).toBe("stopped");
  });

  it("queues turns and makes repeated send commands idempotent", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const session = await host.createSession("D:/workspace");
    const first = await host.sendMessage(session.id, "first", "send-1");
    expect(await host.sendMessage(session.id, "first", "send-1")).toBe(first);
    const second = await host.sendMessage(session.id, "second", "send-2");
    await host.waitForTurn(first);
    await host.waitForTurn(second);
    const events = await host.events(session.id);
    expect(events.filter((event) => event.type === "user/message")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn/queued")).toHaveLength(2);
    expect((await host.getSession(session.id))?.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
  });

  it("supports resume and fork commands", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const session = await host.createSession("D:/workspace");
    await store.append({ sessionId: session.id, type: "agent/status", payload: { status: "interrupted" } });
    expect((await host.resumeSession(session.id, "resume-1")).status).toBe("idle");
    const turn = await host.sendMessage(session.id, "history");
    await host.waitForTurn(turn);
    const forked = await host.forkSession(session.id, "D:/fork", "fork-1");
    expect((await host.forkSession(session.id, "D:/fork", "fork-1"))).toBe(forked);
    expect((await host.getSession(forked))?.workspaceRoot).toBe("D:/fork");
    expect((await host.getSession(forked))?.status).toBe("idle");
    expect((await host.getSession(forked))?.messages.at(-1)?.content).toBe("Echo: history");
  });

  it("records explainable model failures", async () => {
    const store = new InMemoryEventStore();
    const failingModel = {
      async *stream(): AsyncIterable<{ type: "done" }> {
        throw new Error("provider unavailable");
      },
    };
    const host = new AgentHost({ store, model: failingModel });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "fail me");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.find((event) => event.type === "agent/error")?.payload["message"]).toBe("provider unavailable");
    expect(events.at(-1)?.type).toBe("turn/ended");
    expect(events.at(-1)?.payload["status"]).toBe("failed");
    expect((await host.getSession(session.id))?.status).toBe("failed");
  });
});
