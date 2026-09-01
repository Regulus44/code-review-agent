import path from "node:path";
import { access, mkdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { WorktreeProjection, WorktreeStatus } from "@coding-agent/contracts";

const execFileAsync = promisify(execFile);

export class WorkspaceViolation extends Error {
  readonly code = "WORKSPACE_OUTSIDE_ROOT";
}

/** Resolves user-provided paths without permitting traversal outside the workspace root. */
export class WorkspaceResolver {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(relativePath: string): string {
    const candidate = path.resolve(this.root, relativePath);
    const relative = path.relative(this.root, candidate);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return candidate;
    }
    throw new WorkspaceViolation(`Path is outside workspace: ${relativePath}`);
  }

  /** Resolves an existing path and rejects symlinks that escape the workspace root. */
  async resolveExisting(relativePath: string): Promise<string> {
    const candidate = this.resolve(relativePath);
    try {
      await access(candidate);
      const [rootReal, candidateReal] = await Promise.all([realpath(this.root), realpath(candidate)]);
      if (!this.isInside(rootReal, candidateReal)) throw new WorkspaceViolation(`Path resolves outside workspace: ${relativePath}`);
      return candidateReal;
    } catch (error) {
      if (error instanceof WorkspaceViolation) throw error;
      throw new WorkspaceViolation(`Path does not exist: ${relativePath}`);
    }
  }

  /** Resolves a path for creation/update while checking the real parent directory. */
  async resolveForWrite(relativePath: string): Promise<string> {
    const candidate = this.resolve(relativePath);
    const parent = path.dirname(candidate);
    try {
      const [rootReal, parentReal] = await Promise.all([realpath(this.root), realpath(parent)]);
      if (!this.isInside(rootReal, parentReal)) throw new WorkspaceViolation(`Path parent resolves outside workspace: ${relativePath}`);
    } catch (error) {
      if (error instanceof WorkspaceViolation) throw error;
      throw new WorkspaceViolation(`Path parent does not exist: ${relativePath}`);
    }
    return candidate;
  }

  get rootPath(): string {
    return this.root;
  }

  private isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }
}

export class WorktreeViolation extends Error {
  readonly code: string = "WORKTREE_INVALID";
}

export class WorktreeDirtyError extends WorktreeViolation {
  override readonly code = "WORKTREE_DIRTY";
}

export interface WorktreeCreateInput {
  readonly id?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
}

export interface GitWorktreeManagerOptions {
  readonly gitExecutable?: string;
  readonly defaultDirectoryName?: string;
}

/**
 * Executes a bounded subset of `git worktree` without a shell. The manager
 * discovers actual Git state; Session/Task ownership remains in EventStore
 * projections owned by the runtime.
 */
export class GitWorktreeManager {
  readonly repoRoot: string;
  private readonly gitExecutable: string;
  private readonly defaultDirectoryName: string;

  constructor(repoRoot: string, options: GitWorktreeManagerOptions = {}) {
    this.repoRoot = path.resolve(repoRoot);
    this.gitExecutable = options.gitExecutable ?? "git";
    this.defaultDirectoryName = options.defaultDirectoryName ?? ".agent-worktrees";
  }

  async assertRepository(): Promise<string> {
    const result = await this.git(["rev-parse", "--show-toplevel"], this.repoRoot);
    const root = path.resolve(result.stdout.trim());
    // A linked worktree has its own top-level path but shares the main
    // repository's git common directory. Resolve that common directory so
    // callers can inspect/create sibling worktrees after switching.
    const common = (await this.git(["rev-parse", "--git-common-dir"], this.repoRoot)).stdout.trim();
    const commonPath = path.resolve(this.repoRoot, common);
    const mainRoot = path.basename(commonPath).toLowerCase() === ".git" ? path.dirname(commonPath) : root;
    if (path.basename(commonPath).toLowerCase() !== ".git") throw new WorktreeViolation(`Git root does not match workspace repository: ${root}`);
    return path.resolve(mainRoot);
  }

  async list(): Promise<readonly WorktreeProjection[]> {
    const repositoryRoot = await this.assertRepository();
    const result = await this.git(["worktree", "list", "--porcelain"], repositoryRoot);
    const blocks = result.stdout.split(/\r?\n\r?\n/gu).map((block) => block.trim()).filter(Boolean);
    const records: WorktreeProjection[] = [];
    for (const block of blocks) {
      const lines = block.split(/\r?\n/gu);
      const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length).trim();
      if (worktreePath === undefined) continue;
      const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//u, "").trim();
      const commit = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length).trim();
      const status = await this.inspectStatus(worktreePath);
      records.push({ id: idForPath(worktreePath), repoRoot: repositoryRoot, path: path.resolve(worktreePath), status, ...(branch === undefined ? {} : { branch }), ...(commit === undefined ? {} : { commit }), createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), lastSequence: 0 });
    }
    return records;
  }

  async create(input: WorktreeCreateInput = {}): Promise<WorktreeProjection> {
    const repositoryRoot = await this.assertRepository();
    const worktreePath = await this.resolveCreatePath(input.path, input.id ?? input.branch ?? `worktree-${Date.now()}`);
    const branch = input.branch === undefined ? undefined : validateBranch(input.branch);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const args = ["worktree", "add"];
    if (branch === undefined) args.push("--detach", worktreePath, "HEAD");
    else args.push("-b", branch, worktreePath, "HEAD");
    try {
      await this.git(args, repositoryRoot);
    } catch (error) {
      throw new WorktreeViolation(error instanceof Error ? error.message : String(error));
    }
    const record = await this.inspect(worktreePath);
    return { ...record, ...(input.id === undefined ? {} : { id: validateId(input.id) }), ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId as NonNullable<WorktreeProjection["sessionId"]> }), ...(input.taskId === undefined ? {} : { taskId: input.taskId as NonNullable<WorktreeProjection["taskId"]> }), status: "clean" };
  }

  async inspect(worktreePath: string): Promise<WorktreeProjection> {
    const repositoryRoot = await this.assertRepository();
    const resolved = path.resolve(worktreePath);
    const status = await this.inspectStatus(resolved);
    let branch: string | undefined;
    let commit: string | undefined;
    try { branch = (await this.git(["branch", "--show-current"], resolved)).stdout.trim() || undefined; } catch { /* removed path */ }
    try { commit = (await this.git(["rev-parse", "HEAD"], resolved)).stdout.trim() || undefined; } catch { /* removed path */ }
    return { id: idForPath(resolved), repoRoot: repositoryRoot, path: resolved, status, ...(branch === undefined ? {} : { branch }), ...(commit === undefined ? {} : { commit }), createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), lastSequence: 0 };
  }

  async cleanup(worktreePath: string, force = false): Promise<WorktreeProjection> {
    const repositoryRoot = await this.assertRepository();
    const record = await this.inspect(worktreePath);
    if (path.resolve(record.path) === path.resolve(record.repoRoot)) throw new WorktreeViolation("The main repository worktree cannot be cleaned up");
    const live = (await this.list()).some((item) => path.resolve(item.path) === path.resolve(record.path));
    if (!live || record.status === "removed") return { ...record, repoRoot: repositoryRoot, status: "removed", updatedAt: new Date().toISOString() };
    if (record.status === "dirty" || record.status === "conflicted") {
      if (!force) throw new WorktreeDirtyError(`Worktree has uncommitted changes: ${record.path}`);
    }
    await this.git(["worktree", "remove", ...(force ? ["--force"] : []), record.path], repositoryRoot);
    return { ...record, repoRoot: repositoryRoot, status: "removed", updatedAt: new Date().toISOString() };
  }

  private async resolveCreatePath(requested: string | undefined, name: string): Promise<string> {
    const repositoryRoot = await this.assertRepository();
    const candidate = requested === undefined ? path.join(path.dirname(repositoryRoot), this.defaultDirectoryName, safeName(name)) : path.resolve(requested);
    if (candidate === repositoryRoot) throw new WorktreeViolation("Worktree path cannot equal the main repository root");
    const parent = path.dirname(candidate);
    await mkdir(parent, { recursive: true });
    const parentReal = await realpath(parent);
    const rootParent = await realpath(path.dirname(repositoryRoot));
    const relative = path.relative(rootParent, parentReal);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WorktreeViolation("Worktree path must remain under the repository parent boundary");
    return candidate;
  }

  private async inspectStatus(worktreePath: string): Promise<WorktreeStatus> {
    try {
      const result = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath);
      const lines = result.stdout.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
      if (lines.some((line) => /^(?:UU|AA|DD|AU|UA|DU|UD)/u.test(line))) return "conflicted";
      return lines.length === 0 ? "clean" : "dirty";
    } catch {
      return "removed";
    }
  }

  private async git(args: readonly string[], cwd: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
    try {
      return await execFileAsync(this.gitExecutable, [...args], { cwd, windowsHide: true, maxBuffer: 1_000_000 });
    } catch (error) {
      const detail = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      throw new WorktreeViolation(String(detail.stderr ?? detail.message ?? error));
    }
  }
}

function validateBranch(value: string): string {
  const branch = value.trim();
  if (branch.length === 0 || branch.length > 200 || branch.startsWith("-") || branch.includes("..") || branch.includes("~") || branch.includes("^") || branch.includes(":") || branch.includes("?") || branch.includes("*") || branch.includes("[") || branch.includes("]") || branch.includes("\\") || /\s/u.test(branch)) throw new WorktreeViolation("Invalid worktree branch name");
  return branch;
}

function validateId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(id)) throw new WorktreeViolation("Invalid worktree id");
  return id;
}

function safeName(value: string): string {
  return validateId(value.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 100) || `worktree-${Date.now()}`);
}

function idForPath(value: string): string {
  return `wt_${createHash("sha1").update(path.resolve(value)).digest("hex").slice(0, 16)}`;
}
