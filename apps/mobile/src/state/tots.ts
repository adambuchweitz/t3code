import { useAtomValue } from "@effect/atom-react";
import {
  createTotEntryAtoms,
  totThreadKey,
  type TotEntry,
  type TotIdentity,
} from "@t3tools/client-runtime/tots/entries";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { resolveThreadListV2Status } from "../features/threads/threadListV2";
import { environmentPresentations } from "./presentation";
import { environmentProjects } from "./projects";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const totEntryAtoms = createTotEntryAtoms({
  label: "mobile",
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationsAtom: environmentPresentations.presentationsAtom,
  totsLiveAtom: (environmentId) => serverEnvironment.totsLive({ environmentId, input: {} }),
  threadShellAtom: environmentThreadShells.quietThreadShellAtom,
  projectAtom: environmentProjects.projectAtom,
  threadStatus: resolveThreadListV2Status,
});

export function useTotEntries(): ReadonlyArray<TotEntry> {
  return useAtomValue(totEntryAtoms.entriesAtom);
}

const EMPTY_TOT_ATOM = Atom.make<TotEntry | null>(null);

export function useTotForThread(threadRef: ScopedThreadRef | null): TotEntry | null {
  return useAtomValue(
    threadRef === null ? EMPTY_TOT_ATOM : totEntryAtoms.entryForThreadAtom(totThreadKey(threadRef)),
  );
}

const EMPTY_IDENTITY_ATOM = Atom.make<string | null>(null);

export function useTotIdentity(threadRef: ScopedThreadRef | null): TotIdentity | null {
  const json = useAtomValue(
    threadRef === null
      ? EMPTY_IDENTITY_ATOM
      : totEntryAtoms.identityJsonAtom(totThreadKey(threadRef)),
  );
  return json === null ? null : (JSON.parse(json) as TotIdentity);
}
