import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createTotEntryAtoms,
  totThreadKey,
  type TotEntry,
  type TotIdentity,
} from "@t3tools/client-runtime/tots/entries";
import {
  isListedThreadLineage,
  TotListResult,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export type { TotEntry, TotIdentity };

const cacheKey = (environmentId: EnvironmentId) => `t3code:tots:${environmentId}`;

const totEntryAtoms = createTotEntryAtoms({
  label: "web",
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationsAtom: environmentPresentations.presentationsAtom,
  totsLiveAtom: (environmentId) => serverEnvironment.totsLive({ environmentId, input: {} }),
  threadShellAtom: environmentThreadShells.quietThreadShellAtom,
  projectAtom: environmentProjects.projectAtom,
  threadStatus: resolveSidebarThreadStatus,
  cache: {
    read: (environmentId) => {
      try {
        return getLocalStorageItem(cacheKey(environmentId), TotListResult)?.tots ?? [];
      } catch {
        return [];
      }
    },
    write: (environmentId, result) => {
      try {
        setLocalStorageItem(cacheKey(environmentId), result, TotListResult);
      } catch {
        // Only the offline view depends on this, and it falls back to showing nothing.
      }
    },
  },
});

export const totEntriesAtom = totEntryAtoms.entriesAtom;

export function useTotEntries(): ReadonlyArray<TotEntry> {
  return useAtomValue(totEntriesAtom);
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

/** Spread into a thread menu's state: a Tot edits, a listed thread can adopt, others show nothing. */
export function totMenuState(
  threadRef: ScopedThreadRef,
  thread: Pick<EnvironmentThreadShell, "lineage" | "archivedAt">,
): { readonly tot?: "adopt" | "edit" } {
  if (readTotForThread(threadRef) !== null) return { tot: "edit" };
  return thread.archivedAt === null && isListedThreadLineage(thread.lineage)
    ? { tot: "adopt" }
    : {};
}

export function readTotForThread(threadRef: ScopedThreadRef): TotEntry | null {
  return (
    appAtomRegistry
      .get(totEntriesAtom)
      .find(
        (entry) =>
          entry.environmentId === threadRef.environmentId && entry.threadId === threadRef.threadId,
      ) ?? null
  );
}
