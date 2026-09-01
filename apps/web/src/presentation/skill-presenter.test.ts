import { describe, expect, it } from "vitest";
import { presentSkillCatalog } from "./skill-presenter.js";

describe("presentSkillCatalog", () => {
  it("renders bounded rows and marks user-only skills", () => {
    const view = presentSkillCatalog({
      version: 1,
      revision: 3,
      complete: false,
      skills: [
        { name: "review", description: "Review changes", invocation: { modelInvocable: false, userInvocable: true }, source: "project", provider: "filesystem", trust: "local" },
      ],
    });
    expect(view).toMatchObject({ complete: false, revision: 3, rows: [{ name: "review", marker: "仅用户" }], suggestions: [{ name: "review" }] });
  });
});
