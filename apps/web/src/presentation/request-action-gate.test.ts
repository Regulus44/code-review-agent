import { describe, expect, it } from "vitest";
import { RequestActionGate } from "./request-action-gate.js";

describe("RequestActionGate", () => {
  it("accepts one click and rejects a duplicate while submitting", () => {
    const gate = new RequestActionGate();
    expect(gate.begin("permission:1")).toBe(true);
    expect(gate.begin("permission:1")).toBe(false);
    expect(gate.state("permission:1")).toEqual({ status: "submitting" });
  });

  it("re-arms a failed request and clears settled identities", () => {
    const gate = new RequestActionGate();
    gate.begin("question:1");
    gate.fail("question:1", "network failed");
    expect(gate.begin("question:1")).toBe(true);
    gate.retain(new Set(["other"]));
    expect(gate.state("question:1")).toEqual({ status: "idle" });
  });
});
