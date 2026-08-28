import { describe, expect, it } from "vitest";
import { buildAgentSystemPromptSections } from "./system-prompt.js";

describe("Coding Agent system prompt", () => {
  it("requires fresh context after structured edit failures", () => {
    const prompt = buildAgentSystemPromptSections({ workspaceRoot: "D:/workspace", tools: [] })
      .map((section) => section.content)
      .join("\n");

    expect(prompt).toContain("TEXT_NOT_FOUND");
    expect(prompt).toContain("TEXT_NOT_UNIQUE");
    expect(prompt).toContain("EDIT_STALE");
    expect(prompt).toContain("Read the current target again");
    expect(prompt).toContain("fresh unique context");
  });

  it("separates task scope and repository-native verification from generic tool use", () => {
    const prompt = buildAgentSystemPromptSections({ workspaceRoot: "D:/workspace", tools: [] })
      .map((section) => section.content)
      .join("\n");

    expect(prompt).toContain("allowed-path list as a hard boundary");
    expect(prompt).toContain("repository-native focused test/build/diagnostic command");
    expect(prompt).toContain("exact verification command");
    expect(prompt).toContain("exit status");
    expect(prompt).not.toContain("django__django-16046");
  });
});
