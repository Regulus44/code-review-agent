import { describe, expect, it } from "vitest";
import { groupMessagesByApiRound } from "./api-round.js";

describe("M04 API round grouping", () => {
  it("groups assistant/tool loops by response id instead of user turn", () => {
    const rounds = groupMessagesByApiRound([
      { role: "system", content: "rules" },
      { role: "user", content: "request" },
      { role: "assistant", content: "part 1", responseId: "response_a" },
      { role: "tool", toolCallId: "call_a", content: "result" },
      { role: "assistant", content: "part 2", responseId: "response_a" },
      { role: "assistant", content: "next", responseId: "response_b" },
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds.map((round) => round.responseId)).toEqual(["response_a", "response_b"]);
    expect(rounds[0]?.messages).toHaveLength(5);
  });
});
