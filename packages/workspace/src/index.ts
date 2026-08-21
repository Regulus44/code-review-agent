import path from "node:path";
import { access, realpath } from "node:fs/promises";

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
