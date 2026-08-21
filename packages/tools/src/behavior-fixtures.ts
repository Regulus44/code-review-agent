import type { ToolApprovalMode, ToolExecutionMode, ToolRiskLevel } from "@code-review-agent/contracts";

/**
 * Provider-independent P0 contract fixtures. They intentionally describe
 * input/output shapes rather than filesystem-specific golden bytes so the
 * same safety assertions can run on Windows and POSIX hosts.
 */
export const P0_TOOL_FIXTURES: readonly {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expectedOutput: string;
  readonly riskLevel: ToolRiskLevel;
  readonly executionMode: ToolExecutionMode;
  readonly approvalMode: ToolApprovalMode;
  readonly safety: readonly string[];
}[] = [
  { name: "read_file", input: { path: "fixture.txt" }, expectedOutput: "utf8 text", riskLevel: "read", executionMode: "parallel", approvalMode: "auto", safety: ["workspace-boundary", "file-size"] },
  { name: "glob", input: { pattern: "**/*.ts", maxResults: 20 }, expectedOutput: "relative path list", riskLevel: "read", executionMode: "parallel", approvalMode: "auto", safety: ["workspace-boundary", "result-limit"] },
  { name: "grep", input: { pattern: "TODO", path: ".", maxResults: 20 }, expectedOutput: "file:line:match list", riskLevel: "read", executionMode: "parallel", approvalMode: "auto", safety: ["workspace-boundary", "file-size", "result-limit"] },
  { name: "edit_file", input: { path: "fixture.txt", oldText: "before", newText: "after" }, expectedOutput: "path and diff", riskLevel: "write", executionMode: "exclusive", approvalMode: "ask", safety: ["workspace-boundary", "unique-match", "permission"] },
  { name: "write_file", input: { path: "new.txt", content: "content" }, expectedOutput: "path and byte count", riskLevel: "write", executionMode: "exclusive", approvalMode: "ask", safety: ["workspace-boundary", "no-implicit-overwrite", "permission"] },
  { name: "git_status", input: {}, expectedOutput: "branch and entry objects", riskLevel: "read", executionMode: "parallel", approvalMode: "auto", safety: ["workspace-cwd", "output-budget"] },
  { name: "git_diff", input: { path: "fixture.txt" }, expectedOutput: "bounded diff text", riskLevel: "read", executionMode: "parallel", approvalMode: "auto", safety: ["workspace-cwd", "path-boundary", "output-budget"] },
  { name: "run_command", input: { executable: "node", args: ["fixture.js"] }, expectedOutput: "stdout/stderr/exit metadata", riskLevel: "execute", executionMode: "exclusive", approvalMode: "ask", safety: ["argv-allowlist", "timeout", "process-tree", "permission"] },
  { name: "run_tests", input: { command: "node", args: ["fixture.js"] }, expectedOutput: "test command audit", riskLevel: "execute", executionMode: "exclusive", approvalMode: "ask", safety: ["argv-allowlist", "timeout", "process-tree", "permission"] },
];
