import { describe, expect, it, vi } from "vitest";
import { McpSkillProvider } from "./index.js";
import type { McpConnectionManager } from "@coding-agent/mcp-client";

function fixture() {
  let changed: ((server: string) => void) | undefined;
  let body = "---\nname: review\ndescription: Review remote code\nallowed-tools: write_file\n---\nUse $ARGUMENTS and never run !echo secret";
  let reads = 0;
  const shape = {
    discovery: () => ({ tools: [], prompts: [], resources: [
      { uri: "skill://review", name: "review" },
      { uri: "https://169.254.169.254/latest", name: "metadata" },
    ] }),
    readResource: async (_server: string, uri: string, signal?: AbortSignal) => {
      reads += 1;
      if (signal?.aborted) throw signal.reason;
      return { contents: [{ uri, text: body }] };
    },
    subscribeResourceChanges: (listener: (server: string) => void) => { changed = listener; return () => { changed = undefined; }; },
  };
  const manager = shape as unknown as McpConnectionManager;
  return { manager, change: (server = "demo") => changed?.(server), setBody: (value: string) => { body = value; }, reads: () => reads };
}

describe("McpSkillProvider", () => {
  it("is fail-closed until the explicit feature gate is enabled", async () => {
    const f = fixture();
    const provider = new McpSkillProvider({ manager: f.manager, serverName: "demo" });
    expect(await provider.list()).toEqual({ candidates: [], complete: true });
    expect(f.reads()).toBe(0);
  });

  it("enforces the resource URI allowlist before reading remote content", async () => {
    const f = fixture();
    const provider = new McpSkillProvider({ manager: f.manager, serverName: "demo", enabled: true, allowedResourceUriPrefixes: ["skill://approved/"] });
    const snapshot = await provider.list();
    expect(snapshot).toEqual({ candidates: [], complete: true });
    expect(f.reads()).toBe(0);
  });

  it("discovers only skill:// resources, bounds names, and keeps remote body declarative", async () => {
    const f = fixture();
    const provider = new McpSkillProvider({ manager: f.manager, serverName: "demo", enabled: true });
    const control = { signal: new AbortController().signal, invalidate: vi.fn() };
    provider.start(control);
    const snapshot = await provider.list();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]?.name).toBe("mcp-demo-review");
    expect(snapshot.candidates[0]?.trust).toBe("remote");
    const loaded = await provider.get(snapshot.candidates[0]!);
    expect(loaded?.content).toContain("$ARGUMENTS");
    expect(loaded?.metadata).toMatchObject({ remote: true, disableShellExpansion: true, allowedTools: ["write_file"] });
    expect(loaded?.resourceBase).toEqual({ kind: "opaque", description: "MCP resource demo/skill://review" });
  });

  it("returns incomplete with last-good candidates after an oversized or malformed refresh", async () => {
    const f = fixture();
    const provider = new McpSkillProvider({ manager: f.manager, serverName: "demo", enabled: true, maxContentBytes: 256, cacheTtlMs: 1 });
    const first = await provider.list();
    expect(first.complete).toBe(true);
    f.setBody("x".repeat(200));
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = await provider.list();
    expect(second.complete).toBe(false);
    expect(second.candidates).toHaveLength(1);
  });

  it("invalidates body/list cache on MCP resources/list_changed", async () => {
    const f = fixture();
    const provider = new McpSkillProvider({ manager: f.manager, serverName: "demo", enabled: true, cacheTtlMs: 60_000 });
    const control = { signal: new AbortController().signal, invalidate: vi.fn() };
    provider.start(control);
    const first = await provider.list();
    expect(f.reads()).toBe(1); // non-skill URI is filtered before any remote read
    f.setBody("---\nname: changed\ndescription: Changed\n---\nnew");
    f.change();
    expect(control.invalidate).toHaveBeenCalledTimes(1);
    const second = await provider.list();
    expect(second.candidates[0]?.description).toBe("Changed");
    expect(first.candidates[0]?.name).toBe("mcp-demo-review");
  });

  it("cancels a slow MCP read at the provider timeout", async () => {
    const f = fixture();
    const slow = {
      discovery: f.manager.discovery,
      subscribeResourceChanges: f.manager.subscribeResourceChanges,
      readResource: async (_server: string, _uri: string, signal?: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("read should have been cancelled")), 100);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }),
    } as never;
    const provider = new McpSkillProvider({ manager: slow, serverName: "demo", enabled: true, timeoutMs: 5 });
    const snapshot = await provider.list();
    expect(snapshot.complete).toBe(false);
    expect(snapshot.candidates).toEqual([]);
  });
});
