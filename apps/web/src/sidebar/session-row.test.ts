import { describe, expect, it } from "vitest";
import { brand, type SessionSummary } from "@code-review-agent/contracts";
import { presentSessionRow } from "./session-row.js";

function fixture(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: brand<string, "SessionId">("ses_row"),
    title: "Review API",
    workspaceRoot: "D:/repo",
    permissionPreset: "ask-on-write",
    archived: false,
    deleted: false,
    createdAt: "2026-08-31T09:00:00.000Z",
    updatedAt: "2026-08-31T09:59:00.000Z",
    status: "running",
    lastSequence: 4,
    ...overrides,
  };
}

describe("presentSessionRow", () => {
  it("exposes only title/time as the visual summary and keeps rich metadata in details", () => {
    const view = presentSessionRow({ session: fixture({ childMode: "one-shot", childProvider: "fixture-provider" }), now: Date.parse("2026-08-31T09:59:30.000Z") });
    expect(view).toMatchObject({ label: "Review API", relativeTime: "now", status: { status: "running" } });
    expect(view.details).toContain("ask-on-write");
    expect(view.details).toContain("one-shot");
    expect(view.details).toContain("fixture-provider");
    expect(view.ariaLabel).toContain("Session status: Running");
  });

  it("uses a stable status label when permission is pending", () => {
    const view = presentSessionRow({ session: fixture(), pendingPermission: true });
    expect(view.status).toMatchObject({ status: "pending", cssClass: "queued", label: "Needs attention" });
  });
});
