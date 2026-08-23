import { describe, expect, it } from "vitest";
import { buildToolCallTree } from "./tool-call-tree.js";
import type { ToolCallView } from "./conversation.js";

function tool(id: string, sequence: number, parentCallId?: string): ToolCallView {
  return {
    id: id as never,
    name: id,
    status: "completed",
    riskLevel: "read",
    ...(parentCallId === undefined ? {} : { parentCallId }),
    sequence,
    lastSequence: sequence,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("ToolCallTree", () => {
  it("builds stable parent/child roots regardless of event order", () => {
    const tree = buildToolCallTree([tool("child", 2, "parent"), tool("parent", 1)]);
    expect(tree.roots.map((node) => node.call.id)).toEqual(["parent"]);
    expect(tree.roots[0]?.children[0]).toMatchObject({ depth: 1, call: { id: "child" } });
  });

  it("promotes orphan and cycle calls with inspectable warnings", () => {
    const tree = buildToolCallTree([tool("orphan", 1, "missing"), tool("cycle", 2, "cycle")]);
    expect(tree.roots.map((node) => node.call.id)).toEqual(["orphan", "cycle"]);
    expect(tree.warnings).toEqual([
      { callId: "orphan", warning: "orphan" },
      { callId: "cycle", warning: "cycle" },
    ]);
  });

  it("caps hostile lineage depth", () => {
    const calls = [tool("a", 1), tool("b", 2, "a"), tool("c", 3, "b"), tool("d", 4, "c")];
    const tree = buildToolCallTree(calls, { maxDepth: 2 });
    expect(tree.warnings).toContainEqual({ callId: "d", warning: "depth-limit" });
  });
});
