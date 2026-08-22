import { brand, type AgentEvent, type EventStore, type ToolResult } from "@code-review-agent/contracts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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
}

interface JobRecord {
  readonly jobId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly command: string;
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
  readonly signal?: AbortSignal;
  readonly appendEvent?: (type: "job/started" | "job/output" | "job/ended", payload: Readonly<Record<string, unknown>>) => Promise<void>;
}

const MAX_JOB_OUTPUT_BYTES = 512 * 1024;
const MAX_EVENT_OUTPUT_BYTES = 8 * 1024;

/** Session/workspace-scoped background process registry with durable event hooks. */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly options: { readonly eventStore?: Pick<EventStore, "list"> } = {}) {}

  async start(input: StartJobInput): Promise<ToolResult> {
    try { if (!(await stat(input.cwd)).isDirectory()) return fail("WORKDIR_INVALID", `Job cwd is not a directory: ${input.cwd}`); }
    catch { return fail("WORKDIR_INVALID", `Job cwd does not exist: ${input.cwd}`); }
    if (input.signal?.aborted) return fail("COMMAND_CANCELLED", "Background job was cancelled before start");
    const jobId = `job_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const spillPath = path.join(path.resolve(input.workspaceRoot), ".agent-artifacts", "jobs", `${jobId}.log`);
    try { await mkdir(path.dirname(spillPath), { recursive: true }); await writeFile(spillPath, "", "utf8"); }
    catch (error) { return fail("JOB_SPILL_FAILED", `Unable to create the durable job output artifact: ${error instanceof Error ? error.message : String(error)}`); }
    let child: ChildProcessWithoutNullStreams;
    try {
      // The bundled PowerShell runtime on Windows loses redirected stdout/stderr
      // when launched detached. Jobs are already owned by this host and are
      // marked orphaned from durable events after a restart, so keep the child
      // attached on Windows to preserve output capture and spill semantics.
      child = spawn(input.executable, [...input.args], { cwd: input.cwd, detached: process.platform !== "win32", shell: false, windowsHide: true, env: { ...process.env, ...(input.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) { return fail("COMMAND_FAILED", error instanceof Error ? error.message : String(error)); }
    const record: JobRecord = { jobId, sessionId: input.sessionId, workspaceRoot: input.workspaceRoot, cwd: input.cwd, command: input.command, status: "running", startedAt, endedAt: undefined, exitCode: undefined, signal: undefined, child, output: "", readOffset: 0, readOffsetBytes: 0, totalBytes: 0, spillPath, spillWrite: Promise.resolve(), spillError: undefined, killed: false, endedNotified: false, error: undefined, ...(input.appendEvent === undefined ? {} : { appendEvent: input.appendEvent }) };
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
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      record.exitCode = exitCode === null ? undefined : exitCode;
      record.signal = signalName ?? undefined;
      record.status = record.killed ? "cancelled" : exitCode === 0 ? "completed" : "failed";
      record.endedAt = new Date().toISOString();
      this.notifyEnded(record);
    });
    input.signal?.addEventListener("abort", () => { void this.kill(input.sessionId, jobId); }, { once: true });
    await record.appendEvent?.("job/started", { ...this.summary(record) });
    return { ok: true, output: { jobId, status: record.status, command: record.command, cwd: record.cwd }, presentation: { kind: "terminal", title: `Started job ${jobId}`, text: record.command, data: this.summary(record) } };
  }

  async read(sessionId: string, jobId: string, maxBytes = 64 * 1024): Promise<ToolResult> {
    const record = await this.getOrRecover(sessionId, jobId);
    const bounded = Math.min(Math.max(maxBytes, 1), MAX_JOB_OUTPUT_BYTES);
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
    const record = await this.getOrRecover(sessionId, jobId);
    if (record.status !== "running") return { ok: true, output: this.summary(record), presentation: { kind: "terminal", title: `Job ${record.status}`, data: this.summary(record) } };
    if (record.child === undefined) return fail("JOB_NOT_RUNNING", "The job metadata was recovered after restart, but its process is no longer attached.");
    record.killed = true;
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
      };
      this.jobs.set(jobId, record);
    }
  }

  private summary(record: JobRecord): JobSummary {
    return { jobId: record.jobId, sessionId: record.sessionId, workspaceRoot: record.workspaceRoot, cwd: record.cwd, command: record.command, status: record.status, startedAt: record.startedAt, ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }), ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }), ...(record.signal === undefined ? {} : { signal: record.signal }), bufferedBytes: Buffer.byteLength(record.output, "utf8"), truncated: record.totalBytes > MAX_JOB_OUTPUT_BYTES, totalBytes: record.totalBytes, spillPath: relativeSpillPath(record) };
  }

  private notifyEnded(record: JobRecord): void {
    if (record.endedNotified) return;
    record.endedNotified = true;
    void record.appendEvent?.("job/ended", { ...this.summary(record), ...(record.error === undefined ? {} : { error: record.error }) });
  }
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
