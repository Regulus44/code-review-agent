import { describe, expect, it } from "vitest";
import type { ModelSelection } from "@coding-agent/contracts";
import type { SessionModelsResponse } from "./api.js";
import { ModelDirectory } from "./model-directory.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("ModelDirectory", () => {
  it("keeps one Session snapshot with inherited effective selection", async () => {
    const api = {
      listSessionModels: async () => ({
        sessionId: "ses_1" as never,
        selection: null,
        providers: [],
        effective: { provider: "echo", model: "echo-fixture" },
      }),
      selectSessionModel: async (_sessionId: never, selection: ModelSelection) => ({
        sessionId: "ses_1" as never,
        selection,
        model: {},
        effective: { provider: selection.provider, model: selection.model },
      }),
    };
    const directory = new ModelDirectory(api, "ses_1" as never);
    const observed: string[] = [];
    directory.subscribe((state) => observed.push(state.status));

    await directory.load();
    expect(directory.getSnapshot()).toMatchObject({
      current: { provider: "echo", model: "echo-fixture" },
      inherited: true,
      status: "ready",
    });
    expect(observed).toEqual(["loading", "ready"]);
  });

  it("ignores an older catalog response after a Session reset", async () => {
    const first = deferred<SessionModelsResponse>();
    const api = {
      listSessionModels: () => first.promise,
      selectSessionModel: async () => ({
        sessionId: "ses_2" as never,
        selection: { provider: "echo", model: "second" },
        model: {},
        effective: { provider: "echo", model: "second" },
      }),
    };
    const directory = new ModelDirectory(api, "ses_1" as never);
    const pending = directory.load();
    directory.setSession("ses_2" as never);
    first.resolve({
      sessionId: "ses_1" as never,
      selection: { provider: "echo", model: "stale" },
      providers: [],
    });
    await pending;
    expect(directory.getSnapshot()).toMatchObject({ sessionId: "ses_2", current: null, status: "idle" });
  });

  it("preserves the previous selection when a switch fails", async () => {
    let fail = false;
    const api = {
      listSessionModels: async () => ({
        sessionId: "ses_1" as never,
        selection: { provider: "echo", model: "first" },
        providers: [],
      }),
      selectSessionModel: async () => {
        if (fail) throw new Error("provider unavailable");
        return { sessionId: "ses_1" as never, selection: { provider: "echo", model: "second" }, model: {}, effective: { provider: "echo", model: "second" } };
      },
    };
    const directory = new ModelDirectory(api, "ses_1" as never);
    await directory.load();
    fail = true;
    await expect(directory.select({ provider: "echo", model: "second" })).rejects.toThrow("provider unavailable");
    expect(directory.getSnapshot()).toMatchObject({ current: { provider: "echo", model: "first" }, status: "error" });
  });

  it("keeps a newer catalog response when concurrent loads resolve out of order", async () => {
    const first = deferred<SessionModelsResponse>();
    const second = deferred<SessionModelsResponse>();
    let calls = 0;
    const api = {
      listSessionModels: () => (calls++ === 0 ? first.promise : second.promise),
      selectSessionModel: async (_sessionId: never, selection: ModelSelection) => ({
        sessionId: "ses_1" as never,
        selection,
        providers: [],
        model: {},
        effective: { provider: selection.provider, model: selection.model },
      }),
    };
    const directory = new ModelDirectory(api, "ses_1" as never);
    const older = directory.load();
    const newer = directory.load();
    second.resolve({
      sessionId: "ses_1" as never,
      selection: { provider: "new-provider", model: "new-model" },
      providers: [],
    });
    await newer;
    first.resolve({
      sessionId: "ses_1" as never,
      selection: { provider: "old-provider", model: "old-model" },
      providers: [],
    });
    await older;
    expect(directory.getSnapshot()).toMatchObject({
      current: { provider: "new-provider", model: "new-model" },
      status: "ready",
    });
  });
});
