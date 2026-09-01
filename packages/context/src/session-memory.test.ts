import { describe, expect, it } from "vitest";
import {
  createSessionMemoryFileWriteGuard,
  SessionMemoryExtractionScheduler,
  sessionMemoryStats,
  shouldExtractSessionMemory,
} from "./session-memory.js";

describe("session memory extraction gates", () => {
  it("requires the initialization token threshold", () => {
    const stats = sessionMemoryStats([{ role: "user", content: "small", messageId: "m1" }]);
    expect(shouldExtractSessionMemory({ status: "idle", initialized: false, lastExtractedTokens: 0 }, stats, { minimumMessageTokensToInit: 100, minimumTokensBetweenUpdate: 1 })).toMatchObject({ shouldExtract: false, reason: "below_initialization_threshold" });
  });

  it("uses a natural assistant break once token growth is sufficient", () => {
    const stats = sessionMemoryStats([
      { role: "user", content: "context", messageId: "m1" },
      { role: "assistant", content: "answer", messageId: "m2" },
    ], "m0");
    expect(shouldExtractSessionMemory({ status: "completed", initialized: true, lastExtractedTokens: 0 }, stats, { minimumTokensBetweenUpdate: 1, toolCallsBetweenUpdates: 8 })).toMatchObject({ shouldExtract: true, trigger: "natural_break" });
  });

  it("requires both token and tool thresholds while the last assistant is still using tools", () => {
    const stats = sessionMemoryStats([
      { role: "user", content: "context", messageId: "m1" },
      { role: "assistant", content: "", messageId: "m2", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
    ]);
    expect(shouldExtractSessionMemory({ status: "completed", initialized: true, lastExtractedTokens: 0 }, stats, { minimumTokensBetweenUpdate: 1, toolCallsBetweenUpdates: 2 })).toMatchObject({ shouldExtract: false, reason: "tool_and_natural_break_missing" });
  });

  it("serializes extraction tasks and keeps the write path exact", async () => {
    const guard = createSessionMemoryFileWriteGuard("D:/workspace/.memory.md");
    expect(() => guard.assertWritable("D:/workspace/.memory.md")).not.toThrow();
    expect(() => guard.assertWritable("D:/workspace/other.md")).toThrow("SESSION_MEMORY_WRITE_PATH_DENIED");
    const scheduler = new SessionMemoryExtractionScheduler();
    const order: string[] = [];
    const first = scheduler.enqueue("s1", async () => { order.push("first-start"); await new Promise((resolve) => setTimeout(resolve, 5)); order.push("first-end"); });
    const second = scheduler.enqueue("s1", async () => { order.push("second"); });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("cancels all queued work for one session without affecting another", async () => {
    const scheduler = new SessionMemoryExtractionScheduler();
    const started: string[] = [];
    const first = scheduler.enqueue("cancel-me", async (signal) => {
      started.push("first");
      if (signal.aborted) throw signal.reason;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }).catch(() => undefined);
    const second = scheduler.enqueue("cancel-me", async (signal) => {
      started.push(signal.aborted ? "second-aborted" : "second");
    }).catch(() => undefined);
    const other = scheduler.enqueue("keep-me", async () => { started.push("other"); });
    expect(scheduler.cancel("cancel-me")).toBe(true);
    await Promise.all([first, second, other]);
    expect(started).toContain("first");
    expect(started).toContain("other");
    expect(started).toContain("second-aborted");
  });
});
