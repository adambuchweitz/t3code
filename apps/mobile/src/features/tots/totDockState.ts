import { useAtomValue } from "@effect/atom-react";
import { totThreadKey } from "@t3tools/client-runtime/tots/entries";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

interface TotDockState {
  /** Null shows the oldest item, so the dock always opens on something to answer. */
  readonly openItemId: string | null;
  readonly minimized: boolean;
  readonly deskOpen: boolean;
}

const totDockAtom = Atom.family((threadKey: string) =>
  Atom.make<TotDockState>({ openItemId: null, minimized: false, deskOpen: false }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile-tots:dock:${threadKey}`),
  ),
);

export const useTotDock = (ref: ScopedThreadRef) => useAtomValue(totDockAtom(totThreadKey(ref)));

export function updateTotDock(ref: ScopedThreadRef, patch: Partial<TotDockState>) {
  const atom = totDockAtom(totThreadKey(ref));
  appAtomRegistry.set(atom, { ...appAtomRegistry.get(atom), ...patch });
}
