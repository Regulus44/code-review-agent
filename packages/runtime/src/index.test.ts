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
});
