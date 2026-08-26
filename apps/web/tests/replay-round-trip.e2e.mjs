import { assert, assertSequence, withFixture } from "./fixture.mjs";

async function readAllPages(fixture, id, pageSize = 37) {
  const pages = [];
  let before;
  while (true) {
    const query = before === undefined ? `&limit=${pageSize}` : `&before_sequence=${before}&limit=${pageSize}`;
    const page = await fixture.events(id, query);
    pages.unshift(page.events);
    if (!page.hasMoreBefore || page.events.length === 0) break;
    before = page.oldestSequence;
  }
  const events = pages.flat();
  assertSequence(events, "round-trip history");
  return events;
}

export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession();
    const first = "first prompt survives reload";
    const second = "second prompt and trajectory survive reload";
    for (const content of [first, second]) {
      await fixture.request(`/v1/sessions/${created.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      }, 202);
      await fixture.waitFor(`assistant response ${content}`, () => fixture.session(created.id), (session) => session.status === "idle" && session.messages.some((message) => message.content === `Echo: ${content}`));
    }
    for (let index = 0; index < 240; index += 1) await fixture.append(created.id, "session/updated", { title: `history filler ${index}` });

    const latest = await fixture.events(created.id, "&limit=200");
    assert(latest.events.length === 200, "bounded refresh page did not contain 200 events");
    assert(latest.hasMoreBefore === true, "bounded refresh page did not expose older history");
    const beforeRestart = await fixture.session(created.id);
    const beforeSequences = latest.events.map((event) => event.sequence);

    await fixture.restart();
    const afterRestart = await fixture.session(created.id);
    const afterLatest = await fixture.events(created.id, "&limit=200");
    const allEvents = await readAllPages(fixture, created.id);
    const userPrompts = allEvents.filter((event) => event.type === "user/message").map((event) => event.payload.content);
    const trajectoryRows = allEvents.filter((event) => ["user/message", "assistant/chunk", "assistant/message", "turn/started", "turn/ended", "tool/call", "tool/result"].includes(event.type));

    assert(JSON.stringify(afterLatest.events.map((event) => event.sequence)) === JSON.stringify(beforeSequences), "SQLite cold-start latest page changed");
    assert(afterRestart.messages.some((message) => message.content === first), "first prompt missing from Conversation after reload");
    assert(afterRestart.messages.some((message) => message.content === second), "second prompt missing from Conversation after reload");
    assert(userPrompts.includes(first) && userPrompts.includes(second), "prompt events missing from replay source");
    assert(trajectoryRows.some((event) => event.type === "user/message" && event.payload.content === first), "first prompt missing from Trajectory source");
    assert(trajectoryRows.some((event) => event.type === "user/message" && event.payload.content === second), "second prompt missing from Trajectory source");
    assert(afterRestart.lastSequence === beforeRestart.lastSequence, "SQLite cold-start projection sequence changed");
    await fixture.append(created.id, "user/message", { content: "live projection after cold start" }, "turn_live");
    const live = await fixture.session(created.id);
    assert(live.messages.some((message) => message.content === "live projection after cold start"), "live SQLite projection did not update");
    await fixture.restart();
    const liveAfterRestart = await fixture.session(created.id);
    assert(liveAfterRestart.messages.some((message) => message.content === "live projection after cold start"), "live projection was not durable across the next restart");
    return { totalEvents: allEvents.length, boundedEvents: latest.events.length, first, second, statsSourceSequence: afterRestart.stats?.sourceSequence, liveSequence: liveAfterRestart.lastSequence };
  });
}
