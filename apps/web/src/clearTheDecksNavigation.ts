import type { ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  effectiveSnoozed,
  threadRaisedHandWhileSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";

export function nextClearTheDecksThread(
  currentKey: string,
  orderedKeys: ReadonlyArray<string>,
  threads: ReadonlyMap<string, EnvironmentThreadShell>,
  now: string,
): ScopedThreadRef | null {
  const index = orderedKeys.indexOf(currentKey);
  const keys =
    index === -1 ? orderedKeys : [...orderedKeys.slice(index + 1), ...orderedKeys.slice(0, index)];
  for (const key of keys) {
    const thread = threads.get(key);
    if (
      key !== currentKey &&
      thread &&
      !thread.archivedAt &&
      thread.settledOverride !== "settled" &&
      (!threadRuntimeIsActive(thread.runtime) || threadRaisedHandWhileSnoozed(thread)) &&
      !effectiveSnoozed(thread, { now })
    ) {
      return scopeThreadRef(thread.environmentId, thread.id);
    }
  }
  return null;
}

type NavigationPlanner = (threadKey: string) => ScopedThreadRef | null;
let planner: NavigationPlanner | null = null;

export function registerClearTheDecksNavigation(next: NavigationPlanner): () => void {
  planner = next;
  return () => {
    if (planner === next) planner = null;
  };
}

export function planClearTheDecksAdvance(threadKey: string): ScopedThreadRef | null {
  return planner?.(threadKey) ?? null;
}
