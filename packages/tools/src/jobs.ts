import { brand, type AgentEvent, type EventStore, type ToolResult } from "@coding-agent/contracts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectCommand, workspaceCommandDeniedResult } from "./workspace-command-guard.js";
import { hiddenProcessSpawnOptions } from "./process-spawn.js";

export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "orphaned";

export interface JobSummary {
  readonly jobId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly command: string;
  readonly status: JobStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly bufferedBytes: number;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly spillPath?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly deadlineAt?: string;
  readonly retryable: boolean;
  readonly lastError?: { readonly code: string; readonly message: string };
}

interface JobRecord {
  readonly jobId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly command: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly workspaceGuarded: boolean;
  status: JobStatus;
  readonly startedAt: string;
  endedAt: string | undefined;
  exitCode: number | undefined;
  signal: string | undefined;
  readonly child?: ChildProcessWithoutNullStreams;
  output: string;
  readOffset: number;
  readOffsetBytes: number;
  totalBytes: number;
  readonly spillPath: string;
  spillWrite: Promise<void>;
  spillError: string | undefined;
  killed: boolean;
  endedNotified: boolean;
  error: { readonly code: string; readonly message: string } | undefined;
  attempt: number;
  readonly maxAttempts: number;
  readonly deadlineAt: string | undefined;
  deadlineTimer: NodeJS.Timeout | undefined;
  retryTimer: NodeJS.Timeout | undefined;
  retryRequested: boolean;
  readonly appendEvent?: (type: "job/started" | "job/output" | "job/ended", payload: Readonly<Record<string, unknown>>) => Promise<void>;
}

export interface StartJobInput {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly workspaceGuarded?: boolean;
  readonly retry?: { readonly maxAttempts?: number; readonly backoffMs?: number };
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly appendEvent?: (type: "job/started" | "job/output" | "job/ended", payload: Readonly<Record<string, unknown>>) => Promise<void>;
}

const MAX_JOB_OUTPUT_BYTES = 512 * 1024;
const MAX_EVENT_OUTPUT_BYTES = 8 * 1024;
const MAX_JOB_ATTEMPTS = 5;
const MAX_RETRY_BACKOFF_MS = 60_000;

/** Session/workspace-scoped background process registry with durable event hooks. */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();

  private readonly modelOutputChars: number;

  constructor(private readonly options: { readonly eventStore?: Pick<EventStore, "list">; readonly modelOutputChars?: number } = {}) {
    const requested = options.modelOutputChars;
    this.modelOutputChars = requested !== undefined && Number.isFinite(requested) && requested > 0 ? Math.min(150_000, Math.floor(requested)) : 30_000;
  }

  async start(input: StartJobInput): Promise<ToolResult> {
    if (input.workspaceGuarded === true) {
      const decision = await inspectCommand({ workspaceRoot: input.workspaceRoot, workdir: input.cwd, shellCommand: input.command, ...(input.env === undefined ? {} : { env: input.env }) });
      if (!decision.allowed) return workspaceCommandDeniedResult(decision);
    }
    try { if (!(await stat(input.cwd)).isDirectory()) return fail("WORKDIR_INVALID", `Job cwd is not a directory: ${input.cwd}`); }
    catch { return fail("WORKDIR_INVALID", `Job cwd does not exist: ${input.cwd}`); }
    if (input.signal?.aborted) return fail("COMMAND_CANCELLED", "Background job was cancelled before start");
    const jobId = `job_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const spillPath = path.join(path.resolve(input.workspaceRoot), ".agent-artifacts", "jobs", `${jobId}.log`);
    try { await mkdir(path.dirname(spillPath), { recursive: true }); await writeFile(spillPath, "", "utf8"); }
    catch (error) { return fail("JOB_SPILL_FAILED", `Unable to create the durable job output artifact: ${error instanceof Error ? error.message : String(error)}`); }
    const maxAttempts = normalizeAttempts(input.retry?.maxAttempts);
    const deadlineAt = normalizeDeadline(input.deadlineMs);
    let child: ChildProcessWithoutNullStreams;
    try {
      // The bundled PowerShell runtime on Windows loses redirected stdout/stderr
      // when launched detached. Jobs are already owned by this host and are
      // marked orphaned from durable events after a restart, so keep the child
      // attached on Windows to preserve output capture and spill semantics.
      child = spawn(input.executable, [...input.args], { cwd: input.cwd, ...hiddenProcessSpawnOptions(), env: { ...process.env, ...(input.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) { return fail("COMMAND_FAILED", error instanceof Error ? error.message : String(error)); }
    const record: JobRecord = { jobId, sessionId: input.sessionId, workspaceRoot: input.workspaceRoot, cwd: input.cwd, command: input.command, executable: input.executable, args: [...input.args], ...(input.env === undefined ? {} : { env: { ...input.env } }), workspaceGuarded: input.workspaceGuarded === true, status: "running", startedAt, endedAt: undefined, exitCode: undefined, signal: undefined, child, output: "", readOffset: 0, readOffsetBytes: 0, totalBytes: 0, spillPath, spillWrite: Promise.resolve(), spillError: undefined, killed: false, endedNotified: false, error: undefined, attempt: 1, maxAttempts, deadlineAt, deadlineTimer: undefined, retryTimer: undefined, retryRequested: false, ...(input.appendEvent === undefined ? {} : { appendEvent: input.appendEvent }) };
    this.jobs.set(jobId, record);
    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      record.totalBytes += chunk.byteLength;
      const text = chunk.toString("utf8");
      record.output += text;
      if (Buffer.byteLength(record.output, "utf8") > MAX_JOB_OUTPUT_BYTES) {
        const encoded = Buffer.from(record.output, "utf8").subarray(-MAX_JOB_OUTPUT_BYTES);
        record.output = encoded.toString("utf8");
        record.readOffset = Math.max(0, record.readOffset - text.length);
      }
      record.spillWrite = record.spillWrite.then(async () => { await appendFile(record.spillPath, chunk); }).catch((error: unknown) => { record.spillError = error instanceof Error ? error.message : String(error); });
      const eventText = chunk.byteLength > MAX_EVENT_OUTPUT_BYTES ? chunk.subarray(0, MAX_EVENT_OUTPUT_BYTES).toString("utf8") : text;
      void record.appendEvent?.("job/output", { jobId, stream, text: eventText, bytes: chunk.byteLength, totalBytes: record.totalBytes, bufferedBytes: Buffer.byteLength(record.output, "utf8"), truncated: record.totalBytes > MAX_JOB_OUTPUT_BYTES || eventText.length < text.length, spillPath: relativeSpillPath(record) });
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "COMMAND_NOT_FOUND" : "COMMAND_FAILED";
      record.error = { code, message: error.message };
      record.status = "failed";
    });
    child.once("close", (exitCode, signalName) => {
      if (record.deadlineTimer !== undefined) clearTimeout(record.deadlineTimer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      record.exitCode = exitCode === null ? undefined : exitCode;
      record.signal = signalName ?? undefined;
      record.status = record.killed ? (record.error?.code === "JOB_DEADLINE_EXCEEDED" ? "failed" : "cancelled") : exitCode === 0 ? "completed" : "failed";
      record.endedAt = new Date().toISOString();
      this.notifyEnded(record);
    });
    if (deadlineAt !== undefined) {
      const delay = Math.max(1, new Date(deadlineAt).getTime() - Date.now());
      record.deadlineTimer = setTimeout(() => {
        if (record.status !== "running") return;
        record.error = { code: "JOB_DEADLINE_EXCEEDED", message: `Background job exceeded its deadline at ${deadlineAt}` };
        record.killed = true;
        terminateProcessTree(record.child as ChildProcessWithoutNullStreams);
      }, delay);
    }
    input.signal?.addEventListener("abort", () => { void this.killWithReason(input.sessionId, jobId, "aborted"); }, { once: true });
    await record.appendEvent?.("job/started", { ...this.summary(record), executable: record.executable, args: record.args, workspaceGuarded: record.workspaceGuarded, attempt: record.attempt, maxAttempts: record.maxAttempts, ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt }) });
    return { ok: true, output: { jobId, status: record.status, command: record.command, cwd: record.cwd }, presentation: { kind: "terminal", title: `Started job ${jobId}`, text: record.command, data: this.summary(record) } };
  }

  async read(sessionId: string, jobId: string, maxBytes = 64 * 1024): Promise<ToolResult> {
    const record = await this.getOrRecover(sessionId, jobId);
    const bounded = Math.min(Math.max(maxBytes, 1), this.modelOutputChars, MAX_JOB_OUTPUT_BYTES);
    await record.spillWrite;
    if (record.spillError !== undefined) return fail("JOB_SPILL_UNAVAILABLE", `Durable job output is unavailable: ${record.spillError}`);
    const spilled = await readSpill(record, bounded);
    if (spilled !== undefined) {
      record.readOffsetBytes += spilled.bytesRead;
      return { ok: true, output: { jobId, status: record.status, output: spilled.text, hasMore: record.readOffsetBytes < record.totalBytes, exitCode: record.exitCode, signal: record.signal, truncated: record.totalBytes > MAX_JOB_OUTPUT_BYTES }, usage: { bytes: record.totalBytes, truncated: record.totalBytes > bounded }, presentation: { kind: "terminal", title: `Job ${record.status}`, text: spilled.text, data: this.summary(record) } };
    }
    const available = record.output.slice(record.readOffset);
    const text = available.slice(0, bounded);
    record.readOffset += text.length;
    return { ok: true, output: { jobId, status: record.status, output: text, hasMore: record.readOffset < record.output.length, exitCode: record.exitCode, signal: record.signal, truncated: record.totalBytes > MAX_JOB_OUTPUT_BYTES }, usage: { bytes: Buffer.byteLength(available, "utf8"), truncated: Buffer.byteLength(available, "utf8") > Buffer.byteLength(text, "utf8") }, presentation: { kind: "terminal", title: `Job ${record.status}`, text, data: this.summary(record) } };
  }

  async kill(sessionId: string, jobId: string): Promise<ToolResult> {
    return this.killWithReason(sessionId, jobId, "cancelled");
  }

  async retry(sessionId: string, jobId: string, options: { readonly backoffMs?: number } = {}): Promise<ToolResult> {
    const record = await this.getOrRecover(sessionId, jobId);
    if (record.status === "running") return fail("JOB_RETRY_RUNNING", "The background job is still running.");
    if (record.executable.length === 0 || record.attempt >= record.maxAttempts) return fail("JOB_RETRY_EXHAUSTED", "The job has no remaining retry attempts.");
    if (record.retryTimer !== undefined) return { ok: true, output: { jobId, status: "retry_scheduled", attempt: record.attempt + 1 }, presentation: { kind: "terminal", title: `Retry already scheduled for ${jobId}`, data: this.summary(record) } };
    const backoffMs = normalizeBackoff(options.backoffMs);
    if (record.retryRequested) return fail("JOB_RETRY_IN_FLIGHT", "A retry has already been requested for this job.");
    record.retryRequested = true;
    const retryAt = new Date(Date.now() + backoffMs).toISOString();
    void record.appendEvent?.("job/ended", { ...this.summary(record), status: "failed", retryScheduled: true, retryAt });
    if (backoffMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    const replacementInput: StartJobInput = {
      sessionId: record.sessionId,
      workspaceRoot: record.workspaceRoot,
      cwd: record.cwd,
      executable: record.executable,
      args: record.args,
      command: record.command,
      ...(record.env === undefined ? {} : { env: record.env }),
      workspaceGuarded: record.workspaceGuarded,
      retry: { maxAttempts: record.maxAttempts - record.attempt },
      ...(record.deadlineAt === undefined ? {} : { deadlineMs: Math.max(1, new Date(record.deadlineAt).getTime() - Date.now()) }),
      ...(record.appendEvent === undefined ? {} : { appendEvent: record.appendEvent }),
    };
    const replacement = await this.start(replacementInput);
    const replacementId = replacement.ok && typeof replacement.output === "object" && replacement.output !== null && "jobId" in replacement.output ? (replacement.output as { jobId: string }).jobId : undefined;
    return replacement.ok
      ? { ok: true, output: { jobId, status: "retry_started", ...(replacementId === undefined ? {} : { replacementJobId: replacementId }) }, presentation: { kind: "terminal", title: `Retry started for ${jobId}`, data: this.summary(record) } }
      : { ok: false, ...(replacement.error === undefined ? {} : { error: replacement.error }), ...(replacement.presentation === undefined ? {} : { presentation: replacement.presentation }) };
  }

  async shutdown(): Promise<void> {
    const running = [...this.jobs.values()].filter((record) => record.status === "running" && record.child !== undefined);
    for (const record of running) {
      record.error = { code: "HOST_SHUTDOWN", message: "Host is shutting down" };
      record.killed = true;
      terminateProcessTree(record.child as ChildProcessWithoutNullStreams);
    }
    await Promise.all(running.map((record) => waitForJobEnd(record, 2_000)));
  }

  async killWithReason(sessionId: string, jobId: string, reason: "cancelled" | "aborted" = "cancelled"): Promise<ToolResult> {
    const record = await this.getOrRecover(sessionId, jobId);
    if (record.status !== "running") return { ok: true, output: this.summary(record), presentation: { kind: "terminal", title: `Job ${record.status}`, data: this.summary(record) } };
    if (record.child === undefined) return fail("JOB_NOT_RUNNING", "The job metadata was recovered after restart, but its process is no longer attached.");
    record.killed = true;
    if (reason === "aborted") record.error = { code: "COMMAND_CANCELLED", message: "Background job was cancelled by the caller" };
    terminateProcessTree(record.child);
    return { ok: true, output: { jobId, status: "cancelling" }, presentation: { kind: "terminal", title: `Stopping job ${jobId}`, data: this.summary(record) } };
  }

  list(sessionId: string, workspaceRoot: string): readonly JobSummary[] {
    return [...this.jobs.values()].filter((job) => job.sessionId === sessionId && job.workspaceRoot === workspaceRoot).map((job) => this.summary(job));
  }

  async listForSession(sessionId: string, workspaceRoot: string): Promise<readonly JobSummary[]> {
    await this.recoverSession(sessionId, workspaceRoot);
    return this.list(sessionId, workspaceRoot);
  }

  private async getOrRecover(sessionId: string, jobId: string): Promise<JobRecord> {
    const existing = this.jobs.get(jobId);
    if (existing !== undefined) {
      if (existing.sessionId !== sessionId) throw new Error("JOB_NOT_FOUND: job does not belong to this session");
      return existing;
    }
    await this.recoverSession(sessionId);
    const record = this.jobs.get(jobId);
    if (record === undefined || record.sessionId !== sessionId) throw new Error("JOB_NOT_FOUND: job does not belong to this session");
    return record;
  }

  private async recoverSession(sessionId: string, workspaceRoot?: string): Promise<void> {
    const eventStore = this.options.eventStore;
    if (eventStore === undefined) return;
    const events = await eventStore.list(brand<string, "SessionId">(sessionId), 0);
    const started = new Map<string, AgentEvent>();
    const output = new Map<string, string>();
    const ended = new Map<string, AgentEvent>();
    for (const event of events) {
      const jobId = event.payload["jobId"];
      if (typeof jobId !== "string") continue;
      if (event.type === "job/started") started.set(jobId, event);
      if (event.type === "job/output") output.set(jobId, `${output.get(jobId) ?? ""}${typeof event.payload["text"] === "string" ? event.payload["text"] : ""}`);
      if (event.type === "job/ended") ended.set(jobId, event);
    }
    for (const [jobId, event] of started) {
      if (this.jobs.has(jobId)) continue;
      const payload = event.payload;
      const eventWorkspace = typeof payload["workspaceRoot"] === "string" ? payload["workspaceRoot"] : undefined;
      if (workspaceRoot !== undefined && eventWorkspace !== workspaceRoot) continue;
      const finalPayload = ended.get(jobId)?.payload;
      const finalStatus = finalPayload?.["status"];
      const status: JobStatus = finalStatus === "completed" || finalStatus === "failed" || finalStatus === "cancelled"
        ? finalStatus
        : "orphaned";
      const record: JobRecord = {
        jobId,
        sessionId,
        workspaceRoot: eventWorkspace ?? workspaceRoot ?? ".",
        cwd: typeof payload["cwd"] === "string" ? payload["cwd"] : ".",
        command: typeof payload["command"] === "string" ? payload["command"] : "<recovered job>",
        executable: typeof payload["executable"] === "string" ? payload["executable"] : "",
        args: Array.isArray(payload["args"]) ? payload["args"].filter((value): value is string => typeof value === "string") : [],
        status,
        startedAt: event.createdAt,
        endedAt: typeof finalPayload?.["endedAt"] === "string" ? finalPayload["endedAt"] : undefined,
        exitCode: typeof finalPayload?.["exitCode"] === "number" ? finalPayload["exitCode"] : undefined,
        signal: typeof finalPayload?.["signal"] === "string" ? finalPayload["signal"] : undefined,
        output: output.get(jobId) ?? "",
        readOffset: 0,
        readOffsetBytes: 0,
        totalBytes: typeof finalPayload?.["totalBytes"] === "number" ? finalPayload["totalBytes"] : Buffer.byteLength(output.get(jobId) ?? "", "utf8"),
        spillPath: path.join(path.resolve(eventWorkspace ?? workspaceRoot ?? "."), ".agent-artifacts", "jobs", `${jobId}.log`),
        spillWrite: Promise.resolve(),
        spillError: undefined,
        killed: false,
        endedNotified: true,
        error: undefined,
        attempt: typeof payload["attempt"] === "number" ? payload["attempt"] : 1,
        maxAttempts: typeof payload["maxAttempts"] === "number" ? payload["maxAttempts"] : 1,
        deadlineAt: typeof payload["deadlineAt"] === "string" ? payload["deadlineAt"] : undefined,
        deadlineTimer: undefined,
        retryTimer: undefined,
        retryRequested: false,
        workspaceGuarded: payload["workspaceGuarded"] === true,
      };
      this.jobs.set(jobId, record);
    }
  }

  private summary(record: JobRecord): JobSummary {
    return { jobId: record.jobId, sessionId: record.sessionId, workspaceRoot: record.workspaceRoot, cwd: record.cwd, command: record.command, status: record.status, startedAt: record.startedAt, ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }), ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }), ...(record.signal === undefined ? {} : { signal: record.signal }), bufferedBytes: Buffer.byteLength(record.output, "utf8"), truncated: record.totalBytes > MAX_JOB_OUTPUT_BYTES, totalBytes: record.totalBytes, spillPath: relativeSpillPath(record), ...(record.executable.length === 0 ? {} : { executable: record.executable, args: record.args }), attempt: record.attempt, maxAttempts: record.maxAttempts, ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt }), retryable: record.status !== "running" && record.attempt < record.maxAttempts && record.executable.length > 0, ...(record.error === undefined ? {} : { lastError: record.error }) };
  }

  private notifyEnded(record: JobRecord): void {
    if (record.endedNotified) return;
    record.endedNotified = true;
    void record.appendEvent?.("job/ended", { ...this.summary(record), ...(record.error === undefined ? {} : { error: record.error }) });
  }
}

function normalizeAttempts(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) throw new Error("retry.maxAttempts must be a positive integer");
  return Math.min(MAX_JOB_ATTEMPTS, value);
}

function normalizeBackoff(value: number | undefined): number {
  if (value === undefined) return 250;
  if (!Number.isFinite(value) || value < 0) throw new Error("retry.backoffMs must be a non-negative number");
  return Math.min(MAX_RETRY_BACKOFF_MS, Math.floor(value));
}

function normalizeDeadline(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new Error("deadlineMs must be a positive number");
  return new Date(Date.now() + Math.min(24 * 60 * 60 * 1000, Math.floor(value))).toISOString();
}

async function waitForJobEnd(record: JobRecord, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (record.status === "running" && Date.now() - started < timeoutMs) await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

function relativeSpillPath(record: Pick<JobRecord, "workspaceRoot" | "spillPath">): string { return path.relative(record.workspaceRoot, record.spillPath).replaceAll("\\", "/"); }

async function readSpill(record: JobRecord, maxBytes: number): Promise<{ readonly text: string; readonly bytesRead: number } | undefined> {
  try {
    const handle = await open(record.spillPath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const result = await handle.read(buffer, 0, maxBytes, record.readOffsetBytes);
      return { text: buffer.subarray(0, result.bytesRead).toString("utf8"), bytesRead: result.bytesRead };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) { child.kill(); return; }
  if (process.platform === "win32") { const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false }); killer.unref(); try { child.kill(); } catch { /* taskkill is the process-tree fallback */ } }
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } }
}

function fail(code: string, message: string): ToolResult { return { ok: false, error: { code, message, remedy: code === "WORKDIR_INVALID" ? "Use an existing workspace-bound directory." : code === "COMMAND_NOT_FOUND" ? "Check the executable and installed toolchain." : code === "JOB_SPILL_FAILED" || code === "JOB_SPILL_UNAVAILABLE" ? "Inspect the durable artifact path and preserve the job metadata before retrying." : "Inspect the structured job error before retrying." }, presentation: { kind: "terminal", title: code, text: message } }; }
