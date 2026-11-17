import { describe, expect, it } from "vite-plus/test";
import { resolveClearTheDecksSnooze } from "./useClearTheDecks";

describe("Clear the decks snooze duration", () => {
  it.each([
    ["hour", 1],
    ["three-hours", 3],
  ] as const)("resolves %s from the send time", (preset, hours) => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    expect(Date.parse(resolveClearTheDecksSnooze(preset, now).snoozedUntil)).toBe(
      now.getTime() + hours * 60 * 60 * 1000,
    );
  });

  it("resolves tomorrow morning in local time", () => {
    const now = new Date(2026, 9, 25, 23, 30);
    const until = new Date(resolveClearTheDecksSnooze("tomorrow", now).snoozedUntil);
    expect([until.getFullYear(), until.getMonth(), until.getDate(), until.getHours()]).toEqual([
      2026, 9, 26, 9,
    ]);
  });
});
