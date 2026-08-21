import path from "node:path";

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
}
