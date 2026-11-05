import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** A menu closes as its command runs, so the app root renders the dialog once. */
export type TotDialogTarget =
  | { readonly kind: "pick-thread" }
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef };

export const totDialogTargetAtom = Atom.make<TotDialogTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("tots:dialog-target"),
);

export function openTotDialog(target: TotDialogTarget): void {
  appAtomRegistry.set(totDialogTargetAtom, target);
}

export function closeTotDialog(): void {
  appAtomRegistry.set(totDialogTargetAtom, null);
}
