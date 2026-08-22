import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { JobManager } from "./jobs.js";

describe("JobManager", () => {
  it("starts a scoped job, records output events, and reads bounded output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-job-"));
    try {
      const events: string[] = [];
      const jobs = new JobManager();
      const started = await jobs.start({ sessionId: "ses_job", workspaceRoot: root, cwd: root, executable: process.execPath, args: ["-e", "process.stdout.write('job-output')"], command: "node fixture", appendEvent: async (type) => { events.push(type); } });
      const jobId = (started.output as { jobId: string }).jobId;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const output = await jobs.read("ses_job", jobId, 100);
      expect((output.output as { output: string }).output).toContain("job-output");
      expect(events).toContain("job/started");
      expect(events).toContain("job/output");
      expect(jobs.list("ses_job", root)[0]).toMatchObject({ jobId, command: "node fixture" });
      for (let attempt = 0; attempt < 20 && jobs.list("ses_job", root)[0]?.status === "running"; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("kills only a job owned by the current session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-job-kill-"));
    try {
      const jobs = new JobManager();
      const started = await jobs.start({ sessionId: "ses_job_kill", workspaceRoot: root, cwd: root, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], command: "node long" });
      const jobId = (started.output as { jobId: string }).jobId;
      await expect(jobs.kill("other_session", jobId)).rejects.toThrow("JOB_NOT_FOUND");
      await jobs.kill("ses_job_kill", jobId);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(jobs.list("ses_job_kill", root)[0]?.status).toBe("cancelled");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recovers completed metadata and buffered output from durable job events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-job-recovery-"));
    try {
      const sessionId = "ses_job_recovery";
      await mkdir(path.join(root, ".agent-artifacts", "jobs"), { recursive: true });
      await writeFile(path.join(root, ".agent-artifacts", "jobs", "job_recovered.log"), "durable-output", "utf8");
      const events = [
        { sessionId, type: "job/started", sequence: 1, createdAt: new Date().toISOString(), payload: { jobId: "job_recovered", sessionId, workspaceRoot: root, cwd: root, command: "node long", spillPath: ".agent-artifacts/jobs/job_recovered.log" } },
        { sessionId, type: "job/output", sequence: 2, createdAt: new Date().toISOString(), payload: { jobId: "job_recovered", text: "bounded-event-output", spillPath: ".agent-artifacts/jobs/job_recovered.log" } },
        { sessionId, type: "job/ended", sequence: 3, createdAt: new Date().toISOString(), payload: { jobId: "job_recovered", status: "completed", endedAt: new Date().toISOString(), exitCode: 0, totalBytes: 14, spillPath: ".agent-artifacts/jobs/job_recovered.log" } },
      ] as const;
      const jobs = new JobManager({ eventStore: { list: async () => events as never } });
      expect(await jobs.listForSession(sessionId, root)).toMatchObject([{ jobId: "job_recovered", status: "completed" }]);
      const output = await jobs.read(sessionId, "job_recovered", 100);
      expect(output.output).toMatchObject({ output: "durable-output", status: "completed", exitCode: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves the event store receiver while recovering job metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-job-store-receiver-"));
    try {
      const sessionId = "ses_job_store_receiver";
      const events = [{ sessionId, type: "job/started", sequence: 1, createdAt: new Date().toISOString(), payload: { jobId: "job_receiver", sessionId, workspaceRoot: root, cwd: root, command: "node fixture" } }] as const;
      const store = {
        db: true,
        async list(this: { db: boolean }) {
          if (!this.db) throw new Error("receiver lost");
          return events as never;
        },
      };
      const jobs = new JobManager({ eventStore: store });
      expect(await jobs.listForSession(sessionId, root)).toMatchObject([{ jobId: "job_receiver", status: "orphaned" }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("captures output from the Windows PowerShell background adapter", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "cra-job-pwsh-"));
    try {
      const jobs = new JobManager();
      const started = await jobs.start({ sessionId: "ses_job_pwsh", workspaceRoot: root, cwd: root, executable: process.env["CODE_REVIEW_AGENT_PWSH"] ?? "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output 'job-pwsh-output'"], command: "pwsh fixture" });
      const jobId = (started.output as { jobId: string }).jobId;
      for (let attempt = 0; attempt < 40 && jobs.list("ses_job_pwsh", root)[0]?.status === "running"; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const output = await jobs.read("ses_job_pwsh", jobId, 100);
      expect((output.output as { output: string }).output).toContain("job-pwsh-output");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("spills complete output to a workspace artifact while bounding output events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-job-spill-"));
    try {
      const eventPayloads: Readonly<Record<string, unknown>>[] = [];
      const jobs = new JobManager();
      const started = await jobs.start({ sessionId: "ses_job_spill", workspaceRoot: root, cwd: root, executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(20000))"], command: "node spill", appendEvent: async (type, payload) => { if (type === "job/output") eventPayloads.push(payload); } });
      const jobId = (started.output as { jobId: string }).jobId;
      for (let attempt = 0; attempt < 40 && jobs.list("ses_job_spill", root)[0]?.status === "running"; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const output = await jobs.read("ses_job_spill", jobId, 25_000);
      expect((output.output as { output: string }).output).toHaveLength(20_000);
      expect(eventPayloads.length).toBeGreaterThan(0);
      expect(eventPayloads.every((payload) => typeof payload["text"] === "string" && (payload["text"] as string).length <= 8 * 1024)).toBe(true);
      const spillPath = (jobs.list("ses_job_spill", root)[0] as { spillPath?: string }).spillPath;
      expect(spillPath).toContain(".agent-artifacts/jobs/");
      expect((await readFile(path.join(root, spillPath!), "utf8"))).toHaveLength(20_000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
