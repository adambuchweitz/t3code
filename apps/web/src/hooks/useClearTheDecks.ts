import * as Schema from "effect/Schema";
import { resolveSnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import { msg } from "gt-react";

import { useLocalStorage } from "./useLocalStorage";

export const CLEAR_THE_DECKS_DURATIONS = {
  hour: {
    label: msg("1 hour"),
    shortLabel: msg("1h", { $context: "abbreviated snooze duration of one hour" }),
    sendTooltip: msg("Clear the decks: Snooze for 1 hour, then open the next attention thread."),
    sendDescription: msg("Send, snooze for 1 hour, and open the next attention thread."),
  },
  "three-hours": {
    label: msg("3 hours"),
    shortLabel: msg("3h", { $context: "abbreviated snooze duration of three hours" }),
    sendTooltip: msg("Clear the decks: Snooze for 3 hours, then open the next attention thread."),
    sendDescription: msg("Send, snooze for 3 hours, and open the next attention thread."),
  },
  tomorrow: {
    label: msg("Tomorrow morning"),
    shortLabel: msg("Tomorrow", { $context: "snooze until tomorrow morning" }),
    sendTooltip: msg(
      "Clear the decks: Snooze until tomorrow morning, then open the next attention thread.",
    ),
    sendDescription: msg(
      "Send, snooze until tomorrow morning, and open the next attention thread.",
    ),
  },
};

const ClearTheDecksPreset = Schema.Literals(["hour", "three-hours", "tomorrow"]);

export function resolveClearTheDecksSnooze(preset: typeof ClearTheDecksPreset.Type, now: Date) {
  return resolveSnoozePreset(
    preset === "tomorrow"
      ? { kind: "at", day: "tomorrow", time: "09:00" }
      : { kind: "after", minutes: preset === "hour" ? 60 : 180 },
    now,
  )!;
}

export function useClearTheDecks() {
  const [enabled, setEnabled] = useLocalStorage("t3code:clear-the-decks", false, Schema.Boolean);
  const [preset, setPreset] = useLocalStorage(
    "t3code:clear-the-decks-preset",
    "hour",
    ClearTheDecksPreset,
  );
  return { enabled, setEnabled, preset, setPreset };
}
