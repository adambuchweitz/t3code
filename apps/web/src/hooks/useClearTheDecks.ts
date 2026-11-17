import * as Schema from "effect/Schema";
import { resolveSnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

import { useLocalStorage } from "./useLocalStorage";

export const CLEAR_THE_DECKS_DURATIONS = {
  hour: { label: "1 hour", shortLabel: "1h", sendLabel: "Snooze for 1 hour" },
  "three-hours": { label: "3 hours", shortLabel: "3h", sendLabel: "Snooze for 3 hours" },
  tomorrow: {
    label: "Tomorrow morning",
    shortLabel: "Tomorrow",
    sendLabel: "Snooze until tomorrow morning",
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
