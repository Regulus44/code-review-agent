import { assert, assertSequence, withFixture } from "./fixture.mjs";

export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession();
    for (let index = 0; index < 18; index += 1) {
      await fixture.append(created.id, "user/message", { content: `history prompt ${index}` }, `turn_${index}`);
      await fixture.append(created.id, "assistant/message", { content: `history answer ${index}` }, `turn_${index}`);
    }
    const latest = await fixture.events(created.id, "&limit=8");
    const selected = latest.events[2]?.eventId;
    assert(typeof selected === "string", "scroll anchor fixture did not select a row");
    const older = await fixture.events(created.id, `&before_sequence=${latest.oldestSequence}&limit=8`);
    assertSequence(older.events, "older page");
    const prepended = [...older.events, ...latest.events];
    assertSequence(prepended, "prepended page");
    const beforeIndex = latest.events.findIndex((event) => event.eventId === selected);
    const afterIndex = prepended.findIndex((event) => event.eventId === selected);
    assert(afterIndex === beforeIndex + older.events.length, "prepend changed the selected row anchor");
    assert(new Set(prepended.map((event) => event.eventId)).size === prepended.length, "prepend duplicated an event row");
    return { selected, olderRows: older.events.length, anchorDelta: afterIndex - beforeIndex };
  });
}
