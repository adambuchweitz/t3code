import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./rpc/atomRegistry";

/**
 * Per-thread "auto read aloud" mode.
 *
 * In-memory only: the mode survives navigating between threads but resets on
 * reload. The aggregate map lets the background watcher find every thread that
 * has asked for automatic preparation.
 *
 * @module web/readAloudAutoStore
 */

const autoThreadsAtom = Atom.make<ReadonlyMap<string, ScopedThreadRef>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("readAloud:auto-threads"),
);

const emptyAutoReadAloudAtom = Atom.make(false).pipe(Atom.withLabel("readAloud:auto:empty"));

const autoReadAloudAtom = Atom.family((threadKey: string) =>
  Atom.make(false).pipe(Atom.keepAlive, Atom.withLabel(`readAloud:auto:${threadKey}`)),
);

export function useAutoReadAloud(threadKey: string | null): boolean {
  return useAtomValue(threadKey ? autoReadAloudAtom(threadKey) : emptyAutoReadAloudAtom);
}

export function isAutoReadAloudEnabled(ref: ScopedThreadRef): boolean {
  return appAtomRegistry.get(autoReadAloudAtom(scopedThreadKey(ref)));
}

export function setAutoReadAloud(ref: ScopedThreadRef, enabled: boolean): void {
  const key = scopedThreadKey(ref);
  appAtomRegistry.set(autoReadAloudAtom(key), enabled);
  appAtomRegistry.update(autoThreadsAtom, (current) => {
    const next = new Map(current);
    if (enabled) {
      next.set(key, ref);
    } else {
      next.delete(key);
    }
    return next;
  });
}

export function useAutoReadAloudThreads(): ReadonlyMap<string, ScopedThreadRef> {
  return useAtomValue(autoThreadsAtom);
}

export function resetAutoReadAloudForTests(): void {
  for (const key of appAtomRegistry.get(autoThreadsAtom).keys()) {
    appAtomRegistry.set(autoReadAloudAtom(key), false);
  }
  appAtomRegistry.set(autoThreadsAtom, new Map());
}

export const __testing = { autoThreadsAtom };
