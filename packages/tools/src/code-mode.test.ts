import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { CodeModeSandbox, LinuxNetworkNamespaceIsolationAdapter, type CodeModeIsolationAdapter } from "./code-mode.js";

describe("CodeModeSandbox", () => {
  it("requires an explicit host enablement and exposes bounded policy metadata", async () => {
    const sandbox = new CodeModeSandbox({ maxRuntimeMs: 1_000, maxOutputBytes: 2_000 });
    await expect(sandbox.run({ code: "console.log('no')" }, { workspaceRoot: ".", signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_DISABLED" } });
    expect(sandbox.snapshot()).toMatchObject({ enabled: false, maxRuntimeMs: 1_000, maxOutputBytes: 2_000, network: "disabled", networkEnforcement: "process-policy", osNetworkIsolation: false });
  });

  it("runs JavaScript with workspace-bounded filesystem permissions and no inherited secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-code-mode-"));
    try {
      await writeFile(path.join(root, "fixture.txt"), "fixture-value", "utf8");
      const sandbox = new CodeModeSandbox({ enabled: true, maxRuntimeMs: 5_000 });
      const result = await sandbox.run({ code: "const fs = require('node:fs'); console.log(fs.readFileSync('fixture.txt', 'utf8')); console.log(process.env.API_KEY || 'no-secret')" }, { workspaceRoot: root, signal: new AbortController().signal });
      expect(result).toMatchObject({ ok: true, output: { exitCode: 0, stdout: expect.stringContaining("fixture-value"), network: "disabled" } });
      expect(result.output).not.toEqual(expect.objectContaining({ apiKey: expect.anything() }));
      expect(String((result.output as { stdout?: string }).stdout)).toContain("no-secret");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects path traversal, network imports, unsupported language, and non-allowlisted runner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-code-mode-policy-"));
    try {
      const signal = new AbortController().signal;
      const sandbox = new CodeModeSandbox({ enabled: true });
      await expect(sandbox.run({ code: "console.log(1)", cwd: "../" }, { workspaceRoot: root, signal })).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_PATH_INVALID" } });
      await expect(sandbox.run({ code: "fetch('https://example.com')" }, { workspaceRoot: root, signal })).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_NETWORK_DENIED" } });
      await expect(sandbox.run({ code: "globalThis.fetch('https://example.com')" }, { workspaceRoot: root, signal })).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_NETWORK_DENIED" } });
      await expect(sandbox.run({ code: "process.getBuiltinModule('node:http')" }, { workspaceRoot: root, signal })).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_NETWORK_DENIED" } });
      await expect(sandbox.run({ language: "python" as "javascript", code: "print(1)" }, { workspaceRoot: root, signal })).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_LANGUAGE_UNSUPPORTED" } });
      await expect(new CodeModeSandbox({ enabled: true, allowedCommands: ["python"] }).run({ code: "console.log(1)" }, { workspaceRoot: root, signal })).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_COMMAND_NOT_ALLOWED" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when a caller requires unavailable OS-level network isolation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-code-mode-os-isolation-"));
    try {
      const sandbox = new CodeModeSandbox({ enabled: true, networkEnforcement: "os-required" });
      expect(sandbox.snapshot()).toMatchObject({ networkEnforcement: "os-required", osNetworkIsolation: false });
      await expect(sandbox.run({ code: "console.log('must not run')" }, { workspaceRoot: root, signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_OS_ISOLATION_UNAVAILABLE" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses an explicit isolation adapter and records the boundary in progress/output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-code-mode-isolation-adapter-"));
    try {
      const launches: Array<{ command: string; args: readonly string[] }> = [];
      const adapter: CodeModeIsolationAdapter = {
        kind: "container-network-none",
        available: true,
        reason: "fixture container boundary",
        evidence: ["fixture=isolated-worker", "network=none"],
        wrap(command, args) {
          launches.push({ command, args });
          return { command, args };
        },
      };
      const progress: Array<Readonly<Record<string, unknown>>> = [];
      const sandbox = new CodeModeSandbox({ enabled: true, networkEnforcement: "os-required", isolationAdapter: adapter });
      expect(sandbox.snapshot()).toMatchObject({ osNetworkIsolation: true, isolationKind: "container-network-none", isolationEvidence: ["fixture=isolated-worker", "network=none"] });
      const result = await sandbox.run({ code: "console.log('isolated')" }, { workspaceRoot: root, signal: new AbortController().signal, reportProgress: async (payload) => { progress.push(payload); } });
      expect(result).toMatchObject({ ok: true, output: { isolation: "container-network-none", networkEnforcement: "os-required" } });
      expect(launches).toHaveLength(1);
      expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "started", isolation: "container-network-none" })]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not claim Linux isolation when the unshare executable is unavailable", () => {
    const adapter = new LinuxNetworkNamespaceIsolationAdapter(path.join(tmpdir(), "missing-unshare"));
    expect(adapter.available).toBe(false);
    expect(adapter.evidence.join(" ")).toContain("unavailable");
    expect(() => adapter.wrap(process.execPath, ["-e", "console.log(1)"])).toThrow();
  });

  it("enforces output, timeout, and cancellation budgets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-code-mode-budgets-"));
    try {
      const limited = await new CodeModeSandbox({ enabled: true, maxOutputBytes: 256, maxRuntimeMs: 5_000 }).run({ code: "console.log('x'.repeat(10_000))" }, { workspaceRoot: root, signal: new AbortController().signal });
      expect(limited).toMatchObject({ ok: false, error: { code: "CODE_MODE_OUTPUT_LIMIT" } });
      const timed = await new CodeModeSandbox({ enabled: true, maxRuntimeMs: 25 }).run({ code: "setTimeout(() => {}, 10_000)" }, { workspaceRoot: root, signal: new AbortController().signal });
      expect(timed).toMatchObject({ ok: false, error: { code: "CODE_MODE_TIMEOUT" } });
      const controller = new AbortController();
      const running = new CodeModeSandbox({ enabled: true, maxRuntimeMs: 5_000 }).run({ code: "setTimeout(() => {}, 10_000)" }, { workspaceRoot: root, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(running).resolves.toMatchObject({ ok: false, error: { code: "CODE_MODE_CANCELLED" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
