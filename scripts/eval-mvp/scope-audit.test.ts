import { describe, expect, it } from "vitest";
import { auditScope, parseGitStatusPorcelain } from "./scope-audit.ts";

describe("evaluation scope audit", () => {
  it("parses tracked, deleted, untracked, and rename status records", () => {
    const entries = parseGitStatusPorcelain(" M src/changed.ts\0D  src/deleted.ts\0?? .agent-artifacts/tool.txt\0R  src/old.ts\0src/new.ts\0");
    expect(entries.map((entry) => entry.path)).toEqual([
      "src/changed.ts",
      "src/deleted.ts",
      ".agent-artifacts/tool.txt",
      "src/old.ts",
      "src/new.ts",
    ]);
    expect(entries.find((entry) => entry.path === "src/deleted.ts")?.deleted).toBe(true);
  });

  it("excludes runtime artifacts while failing closed for candidate untracked files", () => {
    const audit = auditScope({
      statusPorcelain: " M django/utils/numberformat.py\0?? .agent-artifacts/tool-results/x.txt\0?? unexpected.py\0D  django/tests.py\0",
      allowedPaths: ["django/utils/numberformat.py", "django/tests.py"],
    });
    expect(audit.allChangedFiles).toEqual([".agent-artifacts/tool-results/x.txt", "django/tests.py", "django/utils/numberformat.py", "unexpected.py"]);
    expect(audit.runtimeArtifactFiles).toEqual([".agent-artifacts/tool-results/x.txt"]);
    expect(audit.candidateChangedFiles).toEqual(["django/tests.py", "django/utils/numberformat.py", "unexpected.py"]);
    expect(audit.untrackedCandidateFiles).toEqual(["unexpected.py"]);
    expect(audit.outOfScopeFiles).toEqual(["unexpected.py"]);
    expect(audit.scopeViolation).toBe(true);
  });

  it("allows only the declared tracked paths plus runtime artifacts", () => {
    const audit = auditScope({
      statusPorcelain: " M src/a.ts\0D  src/b.ts\0?? .agent-artifacts/tool.txt\0",
      allowedPaths: ["src/**"],
    });
    expect(audit.scopeViolation).toBe(false);
    expect(audit.candidateChangedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(audit.runtimeArtifactFiles).toEqual([".agent-artifacts/tool.txt"]);
  });

  it("honors explicit forbidden path patterns even when allowed", () => {
    const audit = auditScope({
      statusPorcelain: " M src/generated.py\0",
      allowedPaths: ["src/**"],
      forbiddenPaths: ["src/generated.py"],
    });
    expect(audit.forbiddenFiles).toEqual(["src/generated.py"]);
    expect(audit.scopeViolation).toBe(true);
  });
});
