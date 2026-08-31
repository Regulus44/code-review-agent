import { describe, expect, it } from "vitest";
import { presentComposerSubmit } from "./composer-presenter.js";

const turn = (status: string) => ({ id: "turn_1", status });

describe("presentComposerSubmit", () => {
  it("renders a disabled send control when the composer is empty", () => {
    expect(presentComposerSubmit({ bootReady: true, inputHasContent: false })).toMatchObject({ mode: "send", icon: "↑", disabled: true });
  });

  it("renders stop for queued and running turns", () => {
    expect(presentComposerSubmit({ bootReady: true, inputHasContent: true, turn: turn("queued") })).toMatchObject({ mode: "stop", ariaLabel: "停止排队中的回合" });
    expect(presentComposerSubmit({ bootReady: true, inputHasContent: true, turn: turn("running") })).toMatchObject({ mode: "stop", ariaLabel: "停止正在运行的回合" });
  });

  it("keeps stopping state until the durable turn terminal event removes it", () => {
    expect(presentComposerSubmit({ bootReady: true, inputHasContent: true, turn: turn("running"), stoppingTurnId: "turn_1" })).toMatchObject({ mode: "stopping", icon: "…", disabled: true });
  });

  it("returns to Send when the durable projection contains only a terminal turn", () => {
    expect(presentComposerSubmit({ bootReady: true, inputHasContent: true, turn: turn("completed"), stoppingTurnId: "turn_1" })).toMatchObject({ mode: "send", icon: "↑", disabled: false });
  });

  it("renders an explicit submitting phase while host admission is pending", () => {
    expect(presentComposerSubmit({ bootReady: true, inputHasContent: true, pendingSubmit: true })).toMatchObject({ mode: "submitting", disabled: true, ariaLabel: "正在发送消息" });
  });
});
