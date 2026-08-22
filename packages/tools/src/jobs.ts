import type { ToolResult } from "@code-review-agent/contracts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

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
  readonly child: ChildProcessWithoutNullStreams;
  output: string;
  readOffset: number;
  totalBytes: number;
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

/** Session/workspace-scoped background process registry with durable event hooks. */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();

  async start(input: StartJobInput): Promise<ToolResult> {
    try { if (!(await stat(input.cwd)).isDirectory()) return fail("WORKDIR_INVALID", `Job cwd is not a directory: ${input.cwd}`); }
    catch { return fail("WORKDIR_INVALID", `Job cwd does not exist: ${input.cwd}`); }
    if (input.signal?.aborted) return fail("COMMAND_CANCELLED", "Background job was cancelled before start");
    const jobId = `job_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(input.executable, [...input.args], { cwd: input.cwd, detached: true, shell: false, windowsHide: true, env: { ...process.env, ...(input.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) { return fail("COMMAND_FAILED", error instanceof Error ? error.message : String(error)); }
    const record: JobRecord = { jobId, sessionId: input.sessionId, workspaceRoot: input.workspaceRoot, cwd: input.cwd, command: input.command, status: "running", startedAt, endedAt: undefined, exitCode: undefined, signal: undefined, child, output: "", readOffset: 0, totalBytes: 0, killed: false, endedNotified: false, error: undefined, ...(input.appendEvent === undefined ? {} : { appendEvent: input.appendEvent }) };
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
      void record.appendEvent?.("job/output", { jobId, stream, text, bufferedBytes: Buffer.byteLength(record.output, "utf8"), truncated: record.totalBytes > MAX_JOB_OUTPUT_BYTES });
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "COMMAND_NOT_FOUND" : "COMMAND_FAILED";
      record.error = { code, message: error.message };
      record.status = "failed";
    });
    child.once("close", (exitCode, signalName) => {
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
    const record = this.get(sessionId, jobId);
    const bounded = Math.min(Math.max(maxBytes, 1), MAX_JOB_OUTPUT_BYTES);
    const available = record.output.slice(record.readOffset);
    const text = available.slice(0, bounded);
    record.readOffset += text.length;
    return { ok: true, output: { jobId, status: record.status, output: text, hasMore: record.readOffset < record.output.length, exitCode: record.exitCode, signal: record.signal, truncated: record.totalBytes > MAX_JOB_OUTPUT_BYTES }, usage: { bytes: Buffer.byteLength(available, "utf8"), truncated: Buffer.byteLength(available, "utf8") > Buffer.byteLength(text, "utf8") }, presentation: { kind: "terminal", title: `Job ${record.status}`, text, data: this.summary(record) } };
  }

  async kill(sessionId: string, jobId: string): Promise<ToolResult> {
    const record = this.get(sessionId, jobId);
    if (record.status !== "running") return { ok: true, output: this.summary(record), presentation: { kind: "terminal", title: `Job ${record.status}`, data: this.summary(record) } };
    record.killed = true;
    terminateProcessTree(record.child);
    return { ok: true, output: { jobId, status: "cancelling" }, presentation: { kind: "terminal", title: `Stopping job ${jobId}`, data: this.summary(record) } };
  }

  list(sessionId: string, workspaceRoot: string): readonly JobSummary[] {
    return [...this.jobs.values()].filter((job) => job.sessionId === sessionId && job.workspaceRoot === workspaceRoot).map((job) => this.summary(job));
  }

  private get(sessionId: string, jobId: string): JobRecord {
    const record = this.jobs.get(jobId);
    if (record === undefined || record.sessionId !== sessionId) throw new Error("JOB_NOT_FOUND: job does not belong to this session");
    return record;
  }

  private summary(record: JobRecord): JobSummary {
    return { jobId: record.jobId, sessionId: record.sessionId, workspaceRoot: record.workspaceRoot, cwd: record.cwd, command: record.command, status: record.status, startedAt: record.startedAt, ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }), ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }), ...(record.signal === undefined ? {} : { signal: record.signal }), bufferedBytes: Buffer.byteLength(record.output, "utf8"), truncated: record.totalBytes > MAX_JOB_OUTPUT_BYTES };
  }

  private notifyEnded(record: JobRecord): void {
    if (record.endedNotified) return;
    record.endedNotified = true;
    void record.appendEvent?.("job/ended", { ...this.summary(record), ...(record.error === undefined ? {} : { error: record.error }) });
  }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) { child.kill(); return; }
  if (process.platform === "win32") { const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false }); killer.unref(); try { child.kill(); } catch { /* taskkill is the process-tree fallback */ } }
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } }
}

function fail(code: string, message: string): ToolResult { return { ok: false, error: { code, message, remedy: code === "WORKDIR_INVALID" ? "Use an existing workspace-bound directory." : code === "COMMAND_NOT_FOUND" ? "Check the executable and installed toolchain." : "Inspect the structured job error before retrying." }, presentation: { kind: "terminal", title: code, text: message } }; }
