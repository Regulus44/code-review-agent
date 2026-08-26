import { assert, withFixture } from "./fixture.mjs";

export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession();
    const prompts = Array.from({ length: 12 }, (_, index) => `continuous prompt ${index + 1}`);
    for (const content of prompts) {
      const sent = await fixture.request(`/v1/sessions/${created.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      }, 202);
      assert(typeof sent.body.turnId === "string", "send admission did not return a turn id");
      await fixture.waitFor(`turn ${content}`, () => fixture.session(created.id), (session) => session.status === "idle" && session.messages.some((message) => message.role === "assistant" && message.content === `Echo: ${content}`));
    }

    const projection = await fixture.session(created.id);
    assert(projection.messages.filter((message) => message.role === "user").length === prompts.length, "continuous conversation lost a user message");
    assert(projection.messages.filter((message) => message.role === "assistant").length === prompts.length, "continuous conversation lost an assistant message");
    assert(projection.turns.every((turn) => turn.status !== "running" && turn.status !== "queued"), "Composer would still see an active turn after the terminal event");
    return { turns: prompts.length, status: projection.status, messages: projection.messages.length };
  });
}
