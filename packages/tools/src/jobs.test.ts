import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
      const events = [
        { sessionId, type: "job/started", sequence: 1, createdAt: new Date().toISOString(), payload: { jobId: "job_recovered", sessionId, workspaceRoot: root, cwd: root, command: "node long" } },
        { sessionId, type: "job/output", sequence: 2, createdAt: new Date().toISOString(), payload: { jobId: "job_recovered", text: "persisted-output" } },
        { sessionId, type: "job/ended", sequence: 3, createdAt: new Date().toISOString(), payload: { jobId: "job_recovered", status: "completed", endedAt: new Date().toISOString(), exitCode: 0 } },
      ] as const;
      const jobs = new JobManager({ eventStore: { list: async () => events as never } });
      expect(await jobs.listForSession(sessionId, root)).toMatchObject([{ jobId: "job_recovered", status: "completed" }]);
      const output = await jobs.read(sessionId, "job_recovered", 100);
      expect(output.output).toMatchObject({ output: "persisted-output", status: "completed", exitCode: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
