import type { AgentEvent } from "@code-review-agent/contracts";

export type JobViewStatus = "running" | "completed" | "failed" | "cancelled" | "orphaned";
export type TerminalViewStatus = "running" | "exited" | "closed" | "interrupted";

export interface JobView {
  readonly jobId: string;
  readonly status: JobViewStatus;
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly output: string;
  readonly outputBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly spillPath?: string;
  readonly diagnostics?: string;
  readonly sourceSequence: number;
  readonly lastSequence: number;
  readonly recovery: "live" | "completed" | "failed" | "orphaned";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryable: boolean;
}

export interface TerminalView {
  readonly terminalId: string;
  readonly status: TerminalViewStatus;
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly bufferedBytes: number;
  readonly action: string;
  readonly sourceSequence: number;
  readonly lastSequence: number;
  readonly recovery: "live" | "interrupted" | "closed";
}

export interface RuntimeDiagnosticsView {
  readonly jobs: readonly JobView[];
  readonly terminals: readonly TerminalView[];
  readonly runningJobs: number;
  readonly failedJobs: number;
  readonly orphanedJobs: number;
  readonly interruptedTerminals: number;
  readonly visible: boolean;
}

/**
 * Fold durable job/terminal events into bounded render intents. The browser
 * never treats a missing terminal event as success: a job without a terminal
 * event after an interrupted session is explicitly shown as orphaned.
 */
export function presentRuntimeDiagnostics(events: readonly AgentEvent[], maxOutputChars = 4_096): RuntimeDiagnosticsView {
  const jobs = new Map<string, MutableJob>();
  const terminals = new Map<string, MutableTerminal>();
  const interruptedAt = events
    .filter((event) => event.type === "agent/status" && event.payload["status"] === "interrupted")
    .at(-1)?.sequence ?? 0;

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === "job/started") foldJobStarted(jobs, event, maxOutputChars);
    else if (event.type === "job/output") foldJobOutput(jobs, event, maxOutputChars);
    else if (event.type === "job/ended") foldJobEnded(jobs, event, maxOutputChars);
    else if (event.type === "terminal/session") foldTerminal(terminals, event);
  }

  const jobViews = [...jobs.values()]
    .map((job) => finalizeJob(job, interruptedAt))
    .sort((left, right) => right.lastSequence - left.lastSequence);
  const terminalViews = [...terminals.values()]
    .map((terminal) => finalizeTerminal(terminal))
    .sort((left, right) => right.lastSequence - left.lastSequence);
  return {
    jobs: jobViews,
    terminals: terminalViews,
    runningJobs: jobViews.filter((job) => job.status === "running").length,
    failedJobs: jobViews.filter((job) => job.status === "failed").length,
    orphanedJobs: jobViews.filter((job) => job.status === "orphaned").length,
    interruptedTerminals: terminalViews.filter((terminal) => terminal.status === "interrupted").length,
    visible: jobViews.length > 0 || terminalViews.length > 0,
  };
}

interface MutableJob {
  readonly jobId: string;
  status: JobViewStatus;
  command: string;
  cwd: string;
  workspaceRoot: string;
  startedAt: string;
  endedAt: string | undefined;
  exitCode: number | undefined;
  signal: string | undefined;
  output: string;
  totalBytes: number;
  truncated: boolean;
  spillPath: string | undefined;
  diagnostics: string | undefined;
  sourceSequence: number;
  lastSequence: number;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
}

interface MutableTerminal {
  readonly terminalId: string;
  status: TerminalViewStatus;
  command: string;
  cwd: string;
  workspaceRoot: string;
  exitCode: number | undefined;
  signal: string | undefined;
  bufferedBytes: number;
  action: string;
  sourceSequence: number;
  lastSequence: number;
}

function foldJobStarted(jobs: Map<string, MutableJob>, event: AgentEvent, maxOutputChars: number): void {
  const jobId = stringValue(event.payload["jobId"]);
  if (jobId === undefined) return;
  const existing = jobs.get(jobId);
  const job = existing ?? {
    jobId,
    status: "running" as const,
    command: "<job>",
    cwd: ".",
    workspaceRoot: ".",
    startedAt: event.createdAt,
    endedAt: undefined,
    exitCode: undefined,
    signal: undefined,
    output: "",
    totalBytes: 0,
    truncated: false,
    spillPath: undefined,
    diagnostics: undefined,
    sourceSequence: event.sequence,
    lastSequence: event.sequence,
    attempt: 1,
    maxAttempts: 1,
    retryable: false,
  } satisfies MutableJob;
  job.status = jobStatus(event.payload["status"], "running");
  job.command = bounded(stringValue(event.payload["command"]) ?? job.command, 400);
  job.cwd = bounded(stringValue(event.payload["cwd"]) ?? job.cwd, 260);
  job.workspaceRoot = bounded(stringValue(event.payload["workspaceRoot"]) ?? job.workspaceRoot, 260);
  job.startedAt = stringValue(event.payload["startedAt"]) ?? job.startedAt;
  job.totalBytes = numberValue(event.payload["totalBytes"]) ?? job.totalBytes;
  job.spillPath = stringValue(event.payload["spillPath"]) ?? job.spillPath;
  job.attempt = numberValue(event.payload["attempt"]) ?? job.attempt;
  job.maxAttempts = numberValue(event.payload["maxAttempts"]) ?? job.maxAttempts;
  job.retryable = event.payload["retryable"] === true || (job.status !== "running" && job.attempt < job.maxAttempts);
  job.lastSequence = event.sequence;
  jobs.set(jobId, job);
  if (job.output.length > maxOutputChars) job.output = job.output.slice(-maxOutputChars);
}

function foldJobOutput(jobs: Map<string, MutableJob>, event: AgentEvent, maxOutputChars: number): void {
  const jobId = stringValue(event.payload["jobId"]);
  if (jobId === undefined) return;
  const job = jobs.get(jobId);
  if (job === undefined) return;
  const text = stringValue(event.payload["text"]);
  if (text !== undefined) {
    job.output = `${job.output}${redact(text)}`;
    if (job.output.length > maxOutputChars) {
      job.output = job.output.slice(-maxOutputChars);
      job.truncated = true;
    }
  }
  job.totalBytes = numberValue(event.payload["totalBytes"]) ?? job.totalBytes;
  job.truncated = job.truncated || event.payload["truncated"] === true;
  job.spillPath = stringValue(event.payload["spillPath"]) ?? job.spillPath;
  job.lastSequence = event.sequence;
}

function foldJobEnded(jobs: Map<string, MutableJob>, event: AgentEvent, maxOutputChars: number): void {
  const jobId = stringValue(event.payload["jobId"]);
  if (jobId === undefined) return;
  const job = jobs.get(jobId);
  if (job === undefined) {
    foldJobStarted(jobs, event, maxOutputChars);
  }
  const target = jobs.get(jobId);
  if (target === undefined) return;
  target.status = jobStatus(event.payload["status"], "failed");
  target.endedAt = stringValue(event.payload["endedAt"]) ?? event.createdAt;
  target.exitCode = numberValue(event.payload["exitCode"]);
  target.signal = stringValue(event.payload["signal"]);
  target.totalBytes = numberValue(event.payload["totalBytes"]) ?? target.totalBytes;
  target.truncated = target.truncated || event.payload["truncated"] === true;
  target.spillPath = stringValue(event.payload["spillPath"]) ?? target.spillPath;
  target.diagnostics = diagnosticText(event.payload["error"] ?? event.payload["message"]);
  target.attempt = numberValue(event.payload["attempt"]) ?? target.attempt;
  target.maxAttempts = numberValue(event.payload["maxAttempts"]) ?? target.maxAttempts;
  target.retryable = event.payload["retryable"] === true || (target.attempt < target.maxAttempts && target.status !== "running");
  target.lastSequence = event.sequence;
}

function foldTerminal(terminals: Map<string, MutableTerminal>, event: AgentEvent): void {
  const terminalId = stringValue(event.payload["terminalId"]);
  if (terminalId === undefined) return;
  const existing = terminals.get(terminalId);
  const terminal = existing ?? {
    terminalId,
    status: terminalStatus(event.payload["status"], "running"),
    command: "<terminal>",
    cwd: ".",
    workspaceRoot: ".",
    exitCode: undefined,
    signal: undefined,
    bufferedBytes: 0,
    action: "updated",
    sourceSequence: event.sequence,
    lastSequence: event.sequence,
  } satisfies MutableTerminal;
  terminal.status = terminalStatus(event.payload["status"], terminal.status);
  terminal.command = bounded(stringValue(event.payload["command"]) ?? terminal.command, 400);
  terminal.cwd = bounded(stringValue(event.payload["cwd"]) ?? terminal.cwd, 260);
  terminal.workspaceRoot = bounded(stringValue(event.payload["workspaceRoot"]) ?? terminal.workspaceRoot, 260);
  terminal.exitCode = numberValue(event.payload["exitCode"]) ?? terminal.exitCode;
  terminal.signal = stringValue(event.payload["signal"]) ?? terminal.signal;
  terminal.bufferedBytes = numberValue(event.payload["bufferedBytes"]) ?? terminal.bufferedBytes;
  terminal.action = stringValue(event.payload["action"]) ?? terminal.action;
  terminal.lastSequence = event.sequence;
  terminals.set(terminalId, terminal);
}

function finalizeJob(job: MutableJob, interruptedAt: number): JobView {
  const orphaned = job.status === "running" && interruptedAt > job.lastSequence;
  const status = orphaned ? "orphaned" : job.status;
  const recovery = orphaned ? "orphaned" : status === "running" ? "live" : status === "failed" ? "failed" : "completed";
  const durationMs = job.endedAt === undefined ? undefined : duration(job.startedAt, job.endedAt);
  return {
    jobId: job.jobId,
    status,
    command: redact(job.command),
    cwd: job.cwd,
    workspaceRoot: job.workspaceRoot,
    startedAt: job.startedAt,
    ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    ...(job.signal === undefined ? {} : { signal: job.signal }),
    output: job.output,
    outputBytes: new TextEncoder().encode(job.output).byteLength,
    totalBytes: job.totalBytes,
    truncated: job.truncated,
    ...(job.spillPath === undefined ? {} : { spillPath: job.spillPath }),
    ...(orphaned ? { diagnostics: "主机在作业发出终止事件前重启。" } : job.diagnostics === undefined ? {} : { diagnostics: job.diagnostics }),
    sourceSequence: job.sourceSequence,
    lastSequence: job.lastSequence,
    recovery,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    retryable: job.retryable,
  };
}

function finalizeTerminal(terminal: MutableTerminal): TerminalView {
  const recovery = terminal.status === "interrupted" ? "interrupted" : terminal.status === "closed" || terminal.status === "exited" ? "closed" : "live";
  return {
    terminalId: terminal.terminalId,
    status: terminal.status,
    command: redact(terminal.command),
    cwd: terminal.cwd,
    workspaceRoot: terminal.workspaceRoot,
    ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
    ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
    bufferedBytes: terminal.bufferedBytes,
    action: terminal.action,
    sourceSequence: terminal.sourceSequence,
    lastSequence: terminal.lastSequence,
    recovery,
  };
}

function jobStatus(value: unknown, fallback: JobViewStatus): JobViewStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "orphaned" ? value : fallback;
}

function terminalStatus(value: unknown, fallback: TerminalViewStatus): TerminalViewStatus {
  return value === "running" || value === "exited" || value === "closed" || value === "interrupted" ? value : fallback;
}

function diagnosticText(value: unknown): string | undefined {
  if (typeof value === "string") return bounded(redact(value), 500);
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;
  if (code === undefined && message === undefined) return undefined;
  return bounded(redact([code, message].filter(Boolean).join(": ")), 500);
}

function redact(value: string): string {
  return value
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [redacted]");
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const limit = Math.max(1, Math.floor(maxChars));
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function duration(startedAt: string, endedAt: string): number | undefined {
  const value = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
