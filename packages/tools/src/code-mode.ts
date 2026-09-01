import type { ToolResult } from "@coding-agent/contracts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { WorkspaceResolver } from "@coding-agent/workspace";

export interface CodeModePolicy {
  readonly enabled?: boolean;
  readonly allowedCommands?: readonly string[];
  readonly maxCodeBytes?: number;
  readonly maxRuntimeMs?: number;
  readonly maxOutputBytes?: number;
  /** Code Mode intentionally starts with a deny-by-default network policy. */
  readonly network?: "disabled";
  /**
   * `process-policy` is the current supported boundary. `os-required` fails
   * closed until the host supplies an OS-level network isolation adapter.
   */
  readonly networkEnforcement?: "process-policy" | "os-required";
  /** Optional host-provided OS/container boundary. */
  readonly isolationAdapter?: CodeModeIsolationAdapter;
}

export type CodeModeNetworkEnforcement = "process-policy" | "os-required";

export interface CodeModeLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Host capability for a real network boundary. Node permission flags and a
 * child process are not sufficient evidence for this contract. Adapters must
 * describe the boundary and wrap the exact command that will be executed.
 */
export interface CodeModeIsolationAdapter {
  readonly kind: "linux-network-namespace" | "container-network-none";
  readonly available: boolean;
  readonly reason: string;
  readonly evidence: readonly string[];
  wrap(command: string, args: readonly string[], workspaceRoot: string): CodeModeLaunch;
}

/**
 * Linux host adapter using an unprivileged network namespace. Availability is
 * intentionally conservative: the executable must exist, while the actual
 * user-namespace policy is still verified by the launch result.
 */
export class LinuxNetworkNamespaceIsolationAdapter implements CodeModeIsolationAdapter {
  readonly kind = "linux-network-namespace" as const;
  readonly available: boolean;
  readonly reason: string;
  readonly evidence: readonly string[];
  private readonly executable: string | undefined;

  constructor(executable = "/usr/bin/unshare") {
    this.executable = process.platform === "linux" && existsSync(executable) ? executable : undefined;
    this.available = this.executable !== undefined;
    this.reason = this.available
      ? "Linux unshare network namespace is available; launch failures remain fail-closed."
      : "Linux unshare executable is unavailable on this host.";
    this.evidence = this.available
      ? ["process.platform=linux", `unshare=${this.executable}`, "flags=--user --map-root-user --net --pid --fork --mount-proc"]
      : ["process.platform is not linux or unshare is unavailable"];
  }

  wrap(command: string, args: readonly string[]): CodeModeLaunch {
    if (!this.available || this.executable === undefined) throw new Error(this.reason);
    return {
      command: this.executable,
      args: ["--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "--mount-proc", command, ...args],
    };
  }
}

/**
 * Docker adapter for deployments that choose an ephemeral isolated worker.
 * The API process never grants this adapter implicitly: callers must provide
 * it and require `os-required`, so an unavailable Docker daemon fails closed.
 */
export class ContainerNetworkNoneIsolationAdapter implements CodeModeIsolationAdapter {
  readonly kind = "container-network-none" as const;
  readonly available: boolean;
  readonly reason: string;
  readonly evidence: readonly string[];

  constructor(
    readonly image = "node:22-bookworm-slim",
    private readonly executable = "docker",
  ) {
    const probe = spawnSync(this.executable, ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", timeout: 2_000, windowsHide: true });
    this.available = probe.status === 0;
    this.reason = this.available
      ? "Docker daemon is reachable; Code Mode runs in an ephemeral network-none worker."
      : "Docker daemon is unavailable; the container isolation adapter cannot be enabled.";
    this.evidence = this.available
      ? ["runtime=docker", `image=${this.image}`, "network=none", "read-only=true", "no-new-privileges=true", "cap-drop=ALL", "workspace=/workspace"]
      : ["docker daemon probe failed"];
  }

  wrap(_command: string, args: readonly string[], workspaceRoot: string): CodeModeLaunch {
    if (!this.available) throw new Error(this.reason);
    const containerArgs = args.map((value) => value
      .replaceAll(`--allow-fs-read=${workspaceRoot}`, "--allow-fs-read=/workspace")
      .replaceAll(`--allow-fs-write=${workspaceRoot}`, "--allow-fs-write=/workspace"));
    return {
      command: this.executable,
      args: [
        "run", "--rm", "--network", "none", "--read-only",
        "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
        "--user", "10001:10001", "--workdir", "/workspace",
        "--mount", `type=bind,source=${workspaceRoot},target=/workspace,rw`,
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        this.image, "/usr/local/bin/node", ...containerArgs,
      ],
    };
  }
}

export interface CodeModePolicySnapshot {
  readonly enabled: boolean;
  readonly allowedCommands: readonly string[];
  readonly maxCodeBytes: number;
  readonly maxRuntimeMs: number;
  readonly maxOutputBytes: number;
  readonly network: "disabled";
  readonly networkEnforcement: CodeModeNetworkEnforcement;
  /** True only when the configured adapter supplies an OS/container boundary. */
  readonly osNetworkIsolation: boolean;
  readonly isolationKind?: CodeModeIsolationAdapter["kind"];
  readonly isolationReason?: string;
  readonly isolationEvidence?: readonly string[];
}

export interface CodeModeInput {
  readonly code: string;
  readonly language?: "javascript";
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export interface CodeModeRunOptions {
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  readonly reportProgress?: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
}

const DEFAULT_MAX_CODE_BYTES = 256 * 1024;
const DEFAULT_MAX_RUNTIME_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RUNTIME_MS = 120_000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const NETWORK_IMPORT_PATTERN = /(?:\bfetch\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\b|\bglobalThis\s*\.\s*(?:fetch|WebSocket|XMLHttpRequest)\b|\bprocess\s*\.\s*getBuiltinModule\s*\(|(?:require|import)\s*\(?\s*["'](?:node:)?(?:http|https|net|tls|dgram|dns|undici)["'])/iu;

/**
 * Execute bounded JavaScript in a child process with explicit workspace
 * permissions. The process is never started through a shell, inherits no
 * application secrets, and has network access disabled by policy.
 */
export class CodeModeSandbox {
  private readonly policy: Required<Pick<CodeModePolicy, "enabled" | "maxCodeBytes" | "maxRuntimeMs" | "maxOutputBytes" | "network" | "networkEnforcement">> & Pick<CodeModePolicy, "allowedCommands" | "isolationAdapter">;

  constructor(policy: CodeModePolicy = {}) {
    this.policy = {
      enabled: policy.enabled === true,
      allowedCommands: policy.allowedCommands === undefined ? ["node"] : [...new Set(policy.allowedCommands.map((value) => value.trim().toLowerCase()).filter(Boolean))],
      maxCodeBytes: bounded(policy.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES, 1, 1 * 1024 * 1024),
      maxRuntimeMs: bounded(policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS, 1, MAX_RUNTIME_MS),
      maxOutputBytes: bounded(policy.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 256, MAX_OUTPUT_BYTES),
      network: policy.network ?? "disabled",
      networkEnforcement: policy.networkEnforcement ?? "process-policy",
      ...(policy.isolationAdapter === undefined ? {} : { isolationAdapter: policy.isolationAdapter }),
    };
  }

  snapshot(): CodeModePolicySnapshot {
    return {
      enabled: this.policy.enabled,
      allowedCommands: [...(this.policy.allowedCommands ?? [])],
      maxCodeBytes: this.policy.maxCodeBytes,
      maxRuntimeMs: this.policy.maxRuntimeMs,
      maxOutputBytes: this.policy.maxOutputBytes,
      network: this.policy.network,
      networkEnforcement: this.policy.networkEnforcement,
      osNetworkIsolation: this.policy.isolationAdapter?.available === true,
      ...(this.policy.isolationAdapter === undefined ? {} : {
        isolationKind: this.policy.isolationAdapter.kind,
        isolationReason: this.policy.isolationAdapter.reason,
        isolationEvidence: [...this.policy.isolationAdapter.evidence],
      }),
    };
  }

  async run(input: CodeModeInput, options: CodeModeRunOptions): Promise<ToolResult> {
    if (!this.policy.enabled) return fail("CODE_MODE_DISABLED", "Code Mode is disabled by the host policy.");
    if (this.policy.networkEnforcement === "os-required" && this.policy.isolationAdapter?.available !== true) return fail("CODE_MODE_OS_ISOLATION_UNAVAILABLE", this.policy.isolationAdapter?.reason ?? "Code Mode requires an OS/container isolation adapter, but none is configured.");
    if (input.language !== undefined && input.language !== "javascript") return fail("CODE_MODE_LANGUAGE_UNSUPPORTED", "Only JavaScript Code Mode is enabled.");
    if (typeof input.code !== "string" || input.code.trim().length === 0) return fail("CODE_MODE_EMPTY", "Code Mode requires non-empty JavaScript code.");
    if (Buffer.byteLength(input.code, "utf8") > this.policy.maxCodeBytes) return fail("CODE_MODE_INPUT_TOO_LARGE", `Code exceeds the ${this.policy.maxCodeBytes}-byte Code Mode limit.`);
    if (NETWORK_IMPORT_PATTERN.test(input.code)) return fail("CODE_MODE_NETWORK_DENIED", "Network APIs and network modules are disabled in Code Mode.");
    if (!(this.policy.allowedCommands ?? []).includes("node")) return fail("CODE_MODE_COMMAND_NOT_ALLOWED", "The node Code Mode runner is not in the command allowlist.");

    const resolver = new WorkspaceResolver(options.workspaceRoot);
    let cwd: string;
    try { cwd = input.cwd === undefined ? resolver.rootPath : await resolver.resolveExisting(input.cwd); }
    catch (error) { return fail("CODE_MODE_PATH_INVALID", error instanceof Error ? error.message : String(error)); }
    if (options.signal.aborted) return fail("CODE_MODE_CANCELLED", "Code Mode was cancelled before start.");

    const startedAt = Date.now();
    const nodeArgs = [
      "--permission",
      "--no-addons",
      `--allow-fs-read=${resolver.rootPath}`,
      `--allow-fs-write=${resolver.rootPath}`,
      "-e",
      input.code,
      "--",
      ...(input.args ?? []).slice(0, 16),
    ];
    let launch: CodeModeLaunch = { command: process.execPath, args: nodeArgs };
    if (this.policy.isolationAdapter !== undefined) {
      try { launch = this.policy.isolationAdapter.wrap(process.execPath, nodeArgs, resolver.rootPath); }
      catch (error) { return fail("CODE_MODE_OS_ISOLATION_UNAVAILABLE", error instanceof Error ? error.message : String(error)); }
    }
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        env: { PATH: process.env.PATH ?? "", AGENT_CODE_MODE: "1", NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return fail("CODE_MODE_START_FAILED", error instanceof Error ? error.message : String(error));
    }
    await options.reportProgress?.({ phase: "started", cwd, maxRuntimeMs: this.policy.maxRuntimeMs, network: this.policy.network, networkEnforcement: this.policy.networkEnforcement, ...(this.policy.isolationAdapter === undefined ? {} : { isolation: this.policy.isolationAdapter.kind }) });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputLimit = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      const remaining = Math.max(0, this.policy.maxOutputBytes - Buffer.byteLength(stdout, "utf8") - Buffer.byteLength(stderr, "utf8"));
      const text = chunk.subarray(0, remaining).toString("utf8");
      if (target === "stdout") stdout += text; else stderr += text;
      if (chunk.byteLength > remaining || outputBytes > this.policy.maxOutputBytes) {
        outputLimit = true;
        terminateProcessTree(child);
      }
    };
    if (child.stdout === null || child.stderr === null) {
      terminateProcessTree(child);
      return fail("CODE_MODE_START_FAILED", "Code Mode runner did not expose output pipes.");
    }
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

    let cancelled = false;
    let timedOut = false;
    const abort = (): void => { cancelled = true; terminateProcessTree(child); };
    if (options.signal.aborted) abort(); else options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminateProcessTree(child); }, this.policy.maxRuntimeMs);
    timer.unref();
    const exit = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly spawnError?: Error }>((resolve) => {
      let spawnError: Error | undefined;
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code, signal) => resolve({ code, signal, ...(spawnError === undefined ? {} : { spawnError }) }));
    });
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    const durationMs = Date.now() - startedAt;
    await options.reportProgress?.({ phase: "ended", durationMs, outputBytes, ...(cancelled ? { status: "cancelled" } : timedOut ? { status: "timeout" } : { status: exit.code === 0 ? "completed" : "failed" }) });
    if (cancelled) return fail("CODE_MODE_CANCELLED", "Code Mode was cancelled.", { stdout, stderr, durationMs, outputBytes });
    if (timedOut) return fail("CODE_MODE_TIMEOUT", `Code Mode exceeded the ${this.policy.maxRuntimeMs}ms runtime budget.`, { stdout, stderr, durationMs, outputBytes });
    if (outputLimit) return fail("CODE_MODE_OUTPUT_LIMIT", `Code Mode exceeded the ${this.policy.maxOutputBytes}-byte output budget.`, { stdout, stderr, durationMs, outputBytes });
    if (exit.spawnError !== undefined) return fail("CODE_MODE_START_FAILED", exit.spawnError.message, { stdout, stderr, durationMs, outputBytes });
    const output = { language: "javascript", cwd, stdout, stderr, exitCode: exit.code, signal: exit.signal, durationMs, outputBytes, network: this.policy.network, networkEnforcement: this.policy.networkEnforcement, ...(this.policy.isolationAdapter === undefined ? {} : { isolation: this.policy.isolationAdapter.kind }) };
    if (exit.code !== 0) return fail("CODE_MODE_NON_ZERO_EXIT", `Code Mode exited with code ${exit.code ?? "unknown"}.`, output);
    return { ok: true, output, usage: { bytes: outputBytes, truncated: false }, modelView: { ...output, stdout: boundText(stdout), stderr: boundText(stderr) }, presentation: { kind: "terminal", title: "Code Mode", text: boundText(stdout || stderr), data: { cwd, durationMs, outputBytes, network: this.policy.network } } };
  }
}

function bounded(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.floor(value))); }
function boundText(value: string): string { return value.length > 8_000 ? `${value.slice(0, 7_968)}… [output truncated]` : value; }
function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) { child.kill(); return; }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, windowsHide: true });
    killer.unref();
    try { child.kill(); } catch { /* taskkill is the process-tree fallback */ }
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
  }
}

function fail(code: string, message: string, output?: Readonly<Record<string, unknown>>): ToolResult {
  return {
    ok: false,
    ...(output === undefined ? {} : { output }),
    error: { code, message, remedy: "Inspect the bounded Code Mode diagnostics and adjust code, cwd, or policy before retrying." },
    presentation: { kind: "terminal", title: code, text: message, ...(output === undefined ? {} : { data: output }) },
  };
}
