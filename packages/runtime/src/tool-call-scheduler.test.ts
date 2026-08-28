import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  MAX_PARALLEL_TOOL_CALLS,
  resolveMaxParallelToolCalls,
  scheduleToolCalls,
} from "./tool-call-scheduler.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !predicate(); index += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (!predicate()) throw new Error("scheduler test condition was not reached");
}

describe("scheduleToolCalls", () => {
  it("defaults to ten and validates the host-owned cap", () => {
    expect(resolveMaxParallelToolCalls(undefined)).toBe(DEFAULT_MAX_PARALLEL_TOOL_CALLS);
    expect(resolveMaxParallelToolCalls(MAX_PARALLEL_TOOL_CALLS)).toBe(MAX_PARALLEL_TOOL_CALLS);
    expect(() => resolveMaxParallelToolCalls(0)).toThrow("maxParallelToolCalls must be an integer between 1 and 512");
    expect(() => resolveMaxParallelToolCalls(513)).toThrow("maxParallelToolCalls must be an integer between 1 and 512");
    expect(() => resolveMaxParallelToolCalls(1.5)).toThrow("maxParallelToolCalls must be an integer between 1 and 512");
  });

  it("uses a rolling pool and never exceeds the configured in-flight limit", async () => {
    const calls = ["1", "2", "3", "4"];
    const gates = new Map(calls.map((call) => [call, deferred<string>()]));
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    const running = scheduleToolCalls({
      calls,
      maxParallelToolCalls: 2,
      executionMode: () => "parallel",
      execute: async (call) => {
        started.push(call);
        active += 1;
        maximum = Math.max(maximum, active);
        try { return await gates.get(call)!.promise; }
        finally { active -= 1; }
      },
    });

    await until(() => started.length === 2);
    expect(started).toEqual(["1", "2"]);
    gates.get("1")!.resolve("result-1");
    await until(() => started.length === 3);
    expect(started).toEqual(["1", "2", "3"]);
    gates.get("2")!.resolve("result-2");
    gates.get("3")!.resolve("result-3");
    await until(() => started.length === 4);
    gates.get("4")!.resolve("result-4");

    const result = await running;
    expect(maximum).toBe(2);
    expect(result.results).toEqual(["result-1", "result-2", "result-3", "result-4"]);
  });

  it("forms exclusive barriers and re-reads mode before an unstarted call", async () => {
    const first = deferred<string>();
    const events: string[] = [];
    const running = scheduleToolCalls({
      calls: ["read-1", "write", "read-2"],
      maxParallelToolCalls: 2,
      executionMode: (call) => call === "write" ? "exclusive" : "parallel",
      execute: async (call) => {
        events.push(`start:${call}`);
        if (call === "read-1") await first.promise;
        events.push(`end:${call}`);
        return call;
      },
    });

    await until(() => events.includes("start:read-1"));
    expect(events).toEqual(["start:read-1"]);
    first.resolve("read-1");
    const result = await running;
    expect(result.results).toEqual(["read-1", "write", "read-2"]);
    expect(events).toEqual([
      "start:read-1", "end:read-1",
      "start:write", "end:write",
      "start:read-2", "end:read-2",
    ]);
  });

  it("commits settled results in model order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const committed: string[] = [];
    const running = scheduleToolCalls({
      calls: ["first", "second"],
      maxParallelToolCalls: 2,
      executionMode: () => "parallel",
      execute: async (call) => call === "first" ? first.promise : second.promise,
      commit: (_call, result) => { committed.push(result); },
    });

    await until(() => true);
    second.resolve("second-result");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(committed).toEqual([]);
    first.resolve("first-result");
    await running;
    expect(committed).toEqual(["first-result", "second-result"]);
  });

  it("stops replenishment after abort, drains started calls, and skips the suffix", async () => {
    const controller = new AbortController();
    const gates = new Map(["1", "2"].map((call) => [call, deferred<string>()]));
    const started: string[] = [];
    const skipped: string[] = [];
    const running = scheduleToolCalls({
      calls: ["1", "2", "3", "4"],
      maxParallelToolCalls: 2,
      executionMode: () => "parallel",
      execute: async (call) => {
        started.push(call);
        return gates.get(call)!.promise;
      },
      skip: (call) => { skipped.push(call); return `skipped-${call}`; },
      signal: controller.signal,
    });

    await until(() => started.length === 2);
    controller.abort(new Error("cancel test"));
    gates.get("1")!.resolve("done-1");
    gates.get("2")!.resolve("done-2");
    const result = await running;

    expect(started).toEqual(["1", "2"]);
    expect(skipped).toEqual(["3", "4"]);
    expect(result.aborted).toBe(true);
    expect(result.results).toEqual(["done-1", "done-2", "skipped-3", "skipped-4"]);
  });

  it("reclassifies a call changed by a prior result before starting it", async () => {
    let secondMode: "parallel" | "exclusive" = "parallel";
    const events: string[] = [];
    const result = await scheduleToolCalls({
      calls: ["first", "second"],
      maxParallelToolCalls: 1,
      executionMode: (call) => call === "second" ? secondMode : "parallel",
      execute: async (call) => {
        events.push(`start:${call}`);
        if (call === "first") secondMode = "exclusive";
        events.push(`end:${call}`);
        return call;
      },
    });
    expect(result.results).toEqual(["first", "second"]);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });
});
