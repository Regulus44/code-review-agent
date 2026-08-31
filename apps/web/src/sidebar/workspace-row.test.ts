import { describe, expect, it } from "vitest";
import { presentWorkspaceRow } from "./workspace-row.js";

describe("presentWorkspaceRow", () => {
  it("keeps the label visual while retaining path/count in details", () => {
    const view = presentWorkspaceRow({ group: { key: "d:/repo", root: "D:/repo", label: "Review" }, sessionCount: 3, active: true, expanded: true });
    expect(view).toMatchObject({ key: "d:/repo", label: "Review", root: "D:/repo", active: true, expanded: true });
    expect(view.title).toContain("D:/repo");
    expect(view.title).toContain("3 个会话");
    expect(view.ariaLabel).toContain("工作区 Review");
  });

  it("derives a readable label for unlabeled roots", () => {
    expect(presentWorkspaceRow({ group: { key: ".", root: "." } }).label).toBe(".");
  });
});
