import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./rpc/atomRegistry";

/**
 * Threads whose new responses are read aloud automatically. In memory only:
 * the choice follows the user between threads and ends on reload, so a
 * reopened app never starts talking on its own.
 *
 * @module web/readAloudAutoStore
 */
const autoReadThreadsAtom = Atom.make<ReadonlyMap<string, ScopedThreadRef>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("read-aloud:auto-threads"),
);

const autoReadThreadAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => get(autoReadThreadsAtom).has(threadKey)).pipe(
    Atom.withLabel(`read-aloud:auto:${threadKey}`),
  ),
);

const NO_THREAD_ATOM = Atom.make(false).pipe(Atom.withLabel("read-aloud:auto:none"));

export function useAutoReadAloud(ref: ScopedThreadRef | null): boolean {
  return useAtomValue(ref === null ? NO_THREAD_ATOM : autoReadThreadAtom(scopedThreadKey(ref)));
}

export function useAutoReadAloudThreads(): ReadonlyMap<string, ScopedThreadRef> {
  return useAtomValue(autoReadThreadsAtom);
}

export function setAutoReadAloud(ref: ScopedThreadRef, enabled: boolean): void {
  const key = scopedThreadKey(ref);
  appAtomRegistry.update(autoReadThreadsAtom, (current) => {
    if (current.has(key) === enabled) return current;
    const next = new Map(current);
    if (enabled) next.set(key, ref);
    else next.delete(key);
    return next;
  });
}
