import { describe, expect, it } from "vitest";
import { presentSidebarAttention } from "./sidebar-attention.js";

describe("sidebar attention projection", () => {
  it("keeps the sidebar quiet when no low-frequency state needs attention", () => {
    expect(presentSidebarAttention()).toEqual({
      visible: false,
      count: 0,
      label: "",
      ariaLabel: "没有待处理事项",
    });
  });

  it("targets the Requests details group for pending interactions and permissions", () => {
    const intent = presentSidebarAttention({ pendingInteractions: 1, pendingPermissions: 2 });
    expect(intent.visible).toBe(true);
    expect(intent.targetGroup).toBe("requests");
    expect(intent.count).toBe(3);
    expect(intent.ariaLabel).toContain("3 个待处理请求");
  });

  it("targets Planning for a running child task", () => {
    const intent = presentSidebarAttention({ runningChildren: 1 });
    expect(intent.targetGroup).toBe("planning");
    expect(intent.count).toBe(1);
    expect(intent.ariaLabel).toContain("1 个子任务正在运行");
  });

  it("targets Integrations for MCP failures", () => {
    const intent = presentSidebarAttention({ mcpFailures: 2 });
    expect(intent.targetGroup).toBe("integrations");
    expect(intent.count).toBe(2);
    expect(intent.ariaLabel).toContain("2 个 MCP 集成需要处理");
  });

  it("uses request priority when multiple groups need attention", () => {
    const intent = presentSidebarAttention({ pendingInteractions: 1, runningChildren: 4, mcpFailures: 3 });
    expect(intent.targetGroup).toBe("requests");
    expect(intent.count).toBe(1);
  });

  it("normalizes negative and fractional counters", () => {
    expect(presentSidebarAttention({ pendingInteractions: -2, runningChildren: 1.9 })).toMatchObject({
      targetGroup: "planning",
      count: 1,
    });
  });
});
