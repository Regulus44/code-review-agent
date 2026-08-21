import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "./index.js";
import { brand } from "@code-review-agent/contracts";

describe("InMemoryEventStore", () => {
  it("assigns monotonic session-local sequences and projects messages", async () => {
    const store = new InMemoryEventStore();
    const sessionId = await store.createSession("D:/workspace");
    await store.append({ sessionId, type: "user/message", payload: { content: "hello" } });
    await store.append({ sessionId, type: "assistant/message", payload: { content: "hi" } });
    const events = await store.list(sessionId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect((await store.list(sessionId, 2)).map((event) => event.type)).toEqual(["assistant/message"]);
    expect((await store.project(sessionId))?.messages.map((message) => message.content)).toEqual(["hello", "hi"]);
  });

  it("isolates unknown sessions", async () => {
    const store = new InMemoryEventStore();
    const unknown = brand<string, "SessionId">("missing");
    expect(await store.list(unknown)).toEqual([]);
    expect(await store.project(unknown)).toBeUndefined();
  });
});
