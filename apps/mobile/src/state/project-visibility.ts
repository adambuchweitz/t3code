import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "./preferences";

const EMPTY_KEYS: readonly string[] = [];

export function useHiddenSidebarProjectKeys() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.hiddenSidebarProjectKeys ?? EMPTY_KEYS)
    : EMPTY_KEYS;
}
