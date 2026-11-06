import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

interface TotDockState {
  /** Null shows the oldest item, so the dock always opens on something to answer. */
  readonly openItemId: string | null;
  readonly minimized: boolean;
}

const totDockAtom = Atom.family((threadKey: string) =>
  Atom.make<TotDockState>({ openItemId: null, minimized: false }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`tots:dock:${threadKey}`),
  ),
);

const dockKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

export const useTotDock = (ref: ScopedThreadRef) => useAtomValue(totDockAtom(dockKey(ref)));

export function setTotDockMinimized(ref: ScopedThreadRef, minimized: boolean) {
  const atom = totDockAtom(dockKey(ref));
  appAtomRegistry.set(atom, { ...appAtomRegistry.get(atom), minimized });
}

export function openTotDockItem(ref: ScopedThreadRef, openItemId: string) {
  appAtomRegistry.set(totDockAtom(dockKey(ref)), { openItemId, minimized: false });
}
