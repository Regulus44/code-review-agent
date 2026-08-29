export const DEFAULT_RUNTIME_ARTIFACT_PATTERNS = [".agent-artifacts/**"] as const;

export type GitStatusEntry = {
  readonly status: string;
  readonly path: string;
  readonly untracked: boolean;
  readonly deleted: boolean;
  readonly runtimeArtifact: boolean;
};

export type ScopeViolation = {
  readonly path: string;
  readonly kind: "out_of_scope" | "forbidden" | "untracked_candidate";
};

export type ScopeAudit = {
  readonly schemaVersion: 1;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly runtimeArtifactPaths: readonly string[];
  readonly entries: readonly GitStatusEntry[];
  readonly allChangedFiles: readonly string[];
  readonly candidateChangedFiles: readonly string[];
  readonly runtimeArtifactFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly untrackedCandidateFiles: readonly string[];
  readonly outOfScopeFiles: readonly string[];
  readonly forbiddenFiles: readonly string[];
  readonly violations: readonly ScopeViolation[];
  readonly scopeViolation: boolean;
};

export function parseGitStatusPorcelain(raw: string): readonly Omit<GitStatusEntry, "runtimeArtifact">[] {
  const records = raw.split("\0").filter((record) => record.length > 0);
  const entries: Array<Omit<GitStatusEntry, "runtimeArtifact">> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const status = record.slice(0, 2);
    const firstPath = normalizeWorkspacePath(record.slice(3));
    const untracked = status === "??";
    const deleted = status.includes("D");
    entries.push({ status, path: firstPath, untracked, deleted });

    // Porcelain -z emits the source and destination as consecutive records
    // for renames/copies. Audit both paths so a rename cannot hide a deleted
    // or newly-created path outside the task boundary.
    if (status[0] === "R" || status[0] === "C") {
      const destination = records[index + 1];
      if (destination !== undefined) {
        index += 1;
        entries.push({ status, path: normalizeWorkspacePath(destination), untracked: false, deleted: false });
      }
    }
  }
  return entries;
}

export function auditScope(input: {
  readonly statusPorcelain: string;
  readonly allowedPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly runtimeArtifactPaths?: readonly string[];
}): ScopeAudit {
  const allowedPaths = normalizePatterns(input.allowedPaths);
  const forbiddenPaths = normalizePatterns(input.forbiddenPaths);
  const runtimeArtifactPaths = normalizePatterns(input.runtimeArtifactPaths ?? DEFAULT_RUNTIME_ARTIFACT_PATTERNS);
  const parsed = parseGitStatusPorcelain(input.statusPorcelain);
  const entries = parsed.map((entry) => ({
    ...entry,
    runtimeArtifact: matchesAny(entry.path, runtimeArtifactPaths),
  }));
  const allChangedFiles = uniqueSorted(entries.map((entry) => entry.path));
  const runtimeArtifactFiles = uniqueSorted(entries.filter((entry) => entry.runtimeArtifact).map((entry) => entry.path));
  const candidateEntries = entries.filter((entry) => !entry.runtimeArtifact);
  const candidateChangedFiles = uniqueSorted(candidateEntries.map((entry) => entry.path));
  const untrackedFiles = uniqueSorted(entries.filter((entry) => entry.untracked).map((entry) => entry.path));
  const deletedFiles = uniqueSorted(entries.filter((entry) => entry.deleted).map((entry) => entry.path));
  const untrackedCandidateFiles = uniqueSorted(candidateEntries.filter((entry) => entry.untracked).map((entry) => entry.path));
  const outOfScopeFiles = uniqueSorted(candidateEntries
    .filter((entry) => allowedPaths.length > 0 && !matchesAny(entry.path, allowedPaths))
    .map((entry) => entry.path));
  const forbiddenFiles = uniqueSorted(entries
    .filter((entry) => matchesAny(entry.path, forbiddenPaths))
    .map((entry) => entry.path));
  const violations: ScopeViolation[] = [
    ...outOfScopeFiles.map((path) => ({ path, kind: "out_of_scope" as const })),
    ...forbiddenFiles.map((path) => ({ path, kind: "forbidden" as const })),
    ...untrackedCandidateFiles.map((path) => ({ path, kind: "untracked_candidate" as const })),
  ];
  return {
    schemaVersion: 1,
    allowedPaths,
    forbiddenPaths,
    runtimeArtifactPaths,
    entries,
    allChangedFiles,
    candidateChangedFiles,
    runtimeArtifactFiles,
    untrackedFiles,
    deletedFiles,
    untrackedCandidateFiles,
    outOfScopeFiles,
    forbiddenFiles,
    violations,
    scopeViolation: violations.length > 0,
  };
}

function normalizeWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizePatterns(patterns: readonly string[] | undefined): readonly string[] {
  return uniqueSorted((patterns ?? []).map((pattern) => normalizeWorkspacePath(pattern.trim())).filter(Boolean));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += /[\\^$+?.()|{}[\]]/u.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${source}$`, "u");
}
