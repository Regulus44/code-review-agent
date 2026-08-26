import { assert, withFixture } from "./fixture.mjs";

export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession();
    const firstTurn = "queue_first";
    const secondTurn = "queue_second";
    await fixture.append(created.id, "user/message", { content: "first queued prompt" }, firstTurn);
    await fixture.append(created.id, "turn/queued", {}, firstTurn);
    await fixture.append(created.id, "user/message", { content: "second queued prompt" }, secondTurn);
    await fixture.append(created.id, "turn/queued", {}, secondTurn);
    await fixture.append(created.id, "queue/changed", { queuedTurnIds: [secondTurn, firstTurn] });

    const queued = await fixture.session(created.id);
    const positions = queued.turns.filter((turn) => turn.status === "queued").map((turn) => [turn.id, turn.queuePosition]);
    assert(JSON.stringify(positions) === JSON.stringify([[firstTurn, 2], [secondTurn, 1]]), "queue snapshot did not preserve host order");

    // The terminal queue snapshot is authoritative. A reconnect/cold start
    // must not resurrect the old local queue mirror.
    await fixture.append(created.id, "queue/changed", { queuedTurnIds: [] });
    await fixture.restart();
    const restored = await fixture.session(created.id);
    assert(restored.turns.every((turn) => turn.queuePosition === undefined), "reconnect restored a stale queue position");
    assert(restored.turns.filter((turn) => turn.status === "queued").length === 2, "reconnect changed durable queued-turn status without a terminal event");
    return { queuedBeforeReconnect: positions, queuedAfterReconnect: restored.turns.filter((turn) => turn.status === "queued").length, queuePositionsCleared: true };
  });
}
