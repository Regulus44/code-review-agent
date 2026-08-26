import { assert, assertSequence, withFixture } from "./fixture.mjs";

export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession(undefined, "read-only");
    for (let index = 0; index < 130; index += 1) {
      const currentTurn = `trajectory_${index}`;
      await fixture.append(created.id, "turn/started", {}, currentTurn);
      await fixture.append(created.id, "user/message", { content: `searchable prompt ${index}` }, currentTurn);
      await fixture.append(created.id, "tool/call", { toolCallId: `tool_${index}`, name: "read_file", input: { path: `file-${index}.txt` } }, currentTurn);
      await fixture.append(created.id, "tool/result", { toolCallId: `tool_${index}`, status: "completed", result: { ok: true } }, currentTurn);
      await fixture.append(created.id, "turn/ended", { status: "completed" }, currentTurn);
    }
    const page = await fixture.events(created.id, "&limit=200");
    assert(page.events.length === 200, "trajectory page exceeded the bounded row window");
    assert(page.hasMoreBefore === true, "trajectory page did not advertise older history");
    const all = [];
    let before = undefined;
    while (true) {
      const query = before === undefined ? "&limit=200" : `&before_sequence=${before}&limit=200`;
      const next = await fixture.events(created.id, query);
      all.unshift(...next.events);
      if (!next.hasMoreBefore) break;
      before = next.oldestSequence;
    }
    assertSequence(all, "trajectory ledger");
    const keys = all.filter((event) => ["user/message", "tool/call", "tool/result"].includes(event.type)).map((event) => event.eventId);
    assert(new Set(keys).size === keys.length, "trajectory semantic row keys are unstable or duplicated");
    assert(all.some((event) => event.type === "user/message" && event.payload.content === "searchable prompt 0"), "trajectory search cannot find earliest record");
    assert(all.some((event) => event.type === "user/message" && event.payload.content === "searchable prompt 129"), "trajectory search cannot find latest record");
    return { totalEvents: all.length, boundedEvents: page.events.length, searchable: 130 };
  });
}
