import { assert, collectSse, withFixture } from "./fixture.mjs";

export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession();
    const turn = `turn_terminal_${Date.now()}`;
    await fixture.append(created.id, "turn/started", {}, turn);
    await fixture.append(created.id, "assistant/message", { content: "terminal response" }, turn);
    await fixture.append(created.id, "turn/ended", { status: "completed" }, turn);
    const settled = await fixture.session(created.id);
    assert(settled.status === "idle", `terminal projection status is ${settled.status}`);
    assert(settled.turns.every((item) => item.status !== "running" && item.status !== "queued"), "active turn remained after terminal event");
    const current = settled;

    const dropped = collectSse(`${fixture.baseUrl}/v1/sessions/${created.id}/events?after_sequence=${current.lastSequence}`, 1);
    await dropped.ready;
    const firstLive = await fixture.append(created.id, "assistant/chunk", { text: "dropped frame one" }, turn);
    const secondLive = await fixture.append(created.id, "assistant/chunk", { text: "replayed frame two" }, turn);
    const firstRead = await dropped.result;
    assert(firstRead.length === 1 && firstRead[0].event.sequence === firstLive.sequence, "SSE drop fixture did not receive the first live frame");

    const replay = collectSse(`${fixture.baseUrl}/v1/sessions/${created.id}/events?after_sequence=${current.lastSequence}`, 2);
    await replay.ready;
    const replayed = await replay.result;
    const replaySequences = replayed.map((item) => item.event.sequence);
    assert(JSON.stringify(replaySequences) === JSON.stringify([firstLive.sequence, secondLive.sequence]), "SSE reconnect replay contains a gap or wrong order");
    assert(new Set(replaySequences).size === replaySequences.length, "SSE reconnect replay contains duplicates");
    return { terminalStatus: settled.status, replaySequences };
  });
}
