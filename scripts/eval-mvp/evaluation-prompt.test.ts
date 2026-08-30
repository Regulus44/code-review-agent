import { describe, expect, it } from "vitest";
import { buildEvaluationPrompt } from "./evaluation-prompt.ts";

describe("evaluation prompt contract", () => {
  it("keeps the policy text stable while substituting task and workspace", () => {
    const prompt = buildEvaluationPrompt({ problemStatement: "修复示例问题。", workspaceRoot: "D:\\eval\\workspace" });
    expect(prompt).toContain("修复示例问题。");
    expect(prompt).toContain("当前 workspace：D:\\eval\\workspace");
    expect(prompt).toContain("拥有完整权限");
    expect(prompt).toContain("所有操作必须留在当前 workspace 内");
    expect(prompt).toContain("不得读取、枚举或使用其父目录");
  });

  it("does not add benchmark-specific step, timeout, grader, or command constraints", () => {
    const prompt = buildEvaluationPrompt({ problemStatement: "task", workspaceRoot: "D:\\eval\\workspace" });
    expect(prompt).not.toMatch(/(?:32|128)\s*步|step|超时|timeout|grader|白名单/iu);
  });
});
