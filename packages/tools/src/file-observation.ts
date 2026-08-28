import path from "node:path";

export type FileObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly hash: string };

/**
 * DSH fs-observation-policy equivalent for the built-in file tools.
 *
 * The policy stores only the last authoritative observation per session and
 * workspace-relative target. It never reads the filesystem and never stores
 * file contents; the read/edit tools remain responsible for I/O and CAS.
 */
export class FileObservationPolicy {
  private readonly observations = new Map<string, Map<string, FileObservation>>();

  observe(sessionId: string, workspaceRoot: string, filePath: string, observation: FileObservation): void {
    const session = this.observations.get(sessionId) ?? new Map<string, FileObservation>();
    session.set(this.targetKey(workspaceRoot, filePath), observation);
    this.observations.set(sessionId, session);
  }

  get(sessionId: string, workspaceRoot: string, filePath: string): FileObservation | undefined {
    return this.observations.get(sessionId)?.get(this.targetKey(workspaceRoot, filePath));
  }

  clearSession(sessionId: string): void {
    this.observations.delete(sessionId);
  }

  clear(): void {
    this.observations.clear();
  }

  private targetKey(workspaceRoot: string, filePath: string): string {
    const root = path.resolve(workspaceRoot);
    const absolute = path.resolve(root, filePath);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    return `${root}\u0000${relative}`;
  }
}
