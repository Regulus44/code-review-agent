import { describe, expect, it } from "vitest";
import { RepeatToolReminder } from "./repeat-tool-reminder.js";

describe("RepeatToolReminder", () => {
  it("canonicalizes deep object key order and escalates at DSH thresholds", () => {
    const reminder = new RepeatToolReminder();
    const first = reminder.observe("session", "edit_file", '{"b":{"d":2,"c":1},"a":1}');
    const second = reminder.observe("session", "edit_file", '{"a":1,"b":{"c":1,"d":2}}');
    const third = reminder.observe("session", "edit_file", '{"a":1,"b":{"c":1,"d":2}}');
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(third?.content).toContain("repeating the exact same tool call");

    reminder.observe("session", "edit_file", '{"a":1,"b":{"c":1,"d":2}}');
    const fifth = reminder.observe("session", "edit_file", '{"a":1,"b":{"c":1,"d":2}}');
    expect(fifth?.content).toContain("consecutive_calls: 5");
  });

  it("counts denied-equivalent attempts, resets on user input, and keeps exclusions transparent", () => {
    const reminder = new RepeatToolReminder({ thresholds: [2], exclude: ["todo_*"] });
    expect(reminder.observe("session", "todo_write", "{}")).toBeUndefined();
    expect(reminder.observe("session", "probe", "{}")).toBeUndefined();
    expect(reminder.observe("session", "probe", "{}")?.content).toContain("repeating the exact same tool call");
    reminder.reset("session");
    expect(reminder.observe("session", "probe", "{}")).toBeUndefined();
  });

  it("fails loudly for invalid configuration and bounds detailed argument previews", () => {
    expect(() => new RepeatToolReminder({ thresholds: [] })).toThrow(/must not be empty/);
    expect(() => new RepeatToolReminder({ thresholds: [2, 2] })).toThrow(/duplicates/);
    expect(() => new RepeatToolReminder({ thresholds: [1] })).toThrow(/integer >= 2/);
    const reminder = new RepeatToolReminder({ thresholds: [2, 3], argumentsPreviewChars: 5 });
    reminder.observe("session", "probe", '{"long":"1234567890"}');
    reminder.observe("session", "probe", '{"long":"1234567890"}');
    const notice = reminder.observe("session", "probe", '{"long":"1234567890"}');
    expect(notice?.content).toContain("… (+");
  });
});
