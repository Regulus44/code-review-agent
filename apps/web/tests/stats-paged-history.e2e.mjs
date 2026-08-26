import { assert, withFixture } from "./fixture.mjs";

export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession();
    for (let index = 0; index < 8; index += 1) {
      await fixture.request(`/v1/sessions/${created.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `stats prompt ${index}` }),
      }, 202);
      await fixture.waitFor(`stats turn ${index}`, () => fixture.session(created.id), (session) => session.status === "idle" && session.messages.some((message) => message.content === `Echo: stats prompt ${index}`));
    }
    for (let index = 0; index < 180; index += 1) await fixture.append(created.id, "session/updated", { title: `stats filler ${index}` });
    const before = await fixture.session(created.id);
    const baseline = JSON.stringify(before.stats);
    let page = await fixture.events(created.id, "&limit=25");
    let pages = 1;
    while (page.hasMoreBefore) {
      page = await fixture.events(created.id, `&before_sequence=${page.oldestSequence}&limit=25`);
      pages += 1;
    }
    const after = await fixture.session(created.id);
    assert(JSON.stringify(after.stats) === baseline, "whole-log stats changed while loading older pages");
    assert(after.stats?.complete === true, "stats projection is not marked complete");
    assert(after.stats?.turnCount === 8, `stats turn count is ${after.stats?.turnCount}`);
    return { pages, turnCount: after.stats?.turnCount, sourceSequence: after.stats?.sourceSequence };
  });
}
