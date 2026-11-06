import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  isListedThreadLineage,
  TotListResult,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
  type Tot,
  type TotJob,
  type TotVoice,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { resolveTotState, type TotState } from "../components/tots/tots.logic";
import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export interface TotEntry {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  readonly tot: Tot;
  readonly thread: EnvironmentThreadShell | null;
  readonly displayName: string;
  readonly projectName: string | null;
  readonly machineLabel: string | null;
  readonly state: TotState;
}

const EMPTY_TOTS: ReadonlyArray<Tot> = Object.freeze([]);

const cacheKey = (environmentId: EnvironmentId) => `t3code:tots:${environmentId}`;

const readCachedTots = (environmentId: EnvironmentId): ReadonlyArray<Tot> => {
  try {
    return getLocalStorageItem(cacheKey(environmentId), TotListResult)?.tots ?? EMPTY_TOTS;
  } catch {
    return EMPTY_TOTS;
  }
};

const writeCachedTots = (environmentId: EnvironmentId, result: TotListResult) => {
  try {
    setLocalStorageItem(cacheKey(environmentId), result, TotListResult);
  } catch {
    // Only the offline view depends on this, and it falls back to showing nothing.
  }
};

/** Cached so a Tot on a machine that's off still shows up as offline after a reload. */
const environmentTotsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<Tot> => {
    const live = AsyncResult.value(get(serverEnvironment.totsLive({ environmentId, input: {} })));
    if (Option.isNone(live)) return readCachedTots(environmentId);
    writeCachedTots(environmentId, live.value);
    return live.value.tots;
  }).pipe(Atom.withLabel(`web-tots:${environmentId}`)),
);

/** Only depends on the Tots' own threads, so busy threads elsewhere don't recompute it. */
export const totEntriesAtom = Atom.make((get): ReadonlyArray<TotEntry> => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const presentations = get(environmentPresentations.presentationsAtom);
  const entries: Array<TotEntry> = [];
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const presentation = presentations.get(environmentId);
    for (const tot of get(environmentTotsAtom(environmentId))) {
      const threadRef = scopeThreadRef(environmentId, tot.threadId);
      const thread = get(environmentThreadShells.quietThreadShellAtom(threadRef));
      const project = get(
        environmentProjects.projectAtom(scopeProjectRef(environmentId, tot.projectId)),
      );
      const projectName = project?.title ?? null;
      entries.push({
        environmentId,
        threadId: tot.threadId,
        projectId: tot.projectId,
        threadRef,
        tot,
        thread,
        displayName: tot.nameEnabled ? tot.name : (projectName ?? tot.name),
        projectName,
        machineLabel: presentation?.entry.target.label ?? null,
        state: resolveTotState({
          connected: presentation?.connection.phase === "connected",
          threadStatus: thread === null ? null : resolveSidebarThreadStatus(thread),
          hasCharterProposal: tot.charterProposal !== null,
          hasOpenRequests: tot.requests.length > 0,
        }),
      });
    }
  }
  return entries;
}).pipe(Atom.withLabel("web-tot-entries"));

export function useTotEntries(): ReadonlyArray<TotEntry> {
  return useAtomValue(totEntriesAtom);
}

const EMPTY_TOT_ATOM = Atom.make<TotEntry | null>(null);

const totForThreadAtom = Atom.family((key: string) =>
  Atom.make(
    (get) =>
      get(totEntriesAtom).find((entry) => `${entry.environmentId}:${entry.threadId}` === key) ??
      null,
  ).pipe(Atom.withLabel(`web-tot-for-thread:${key}`)),
);

export function useTotForThread(threadRef: ScopedThreadRef | null): TotEntry | null {
  return useAtomValue(
    threadRef === null
      ? EMPTY_TOT_ATOM
      : totForThreadAtom(`${threadRef.environmentId}:${threadRef.threadId}`),
  );
}

/** What a thread needs to look like its Tot, without changing every time the Tot's thread does. */
export interface TotIdentity {
  readonly character: string;
  readonly displayName: string;
  readonly job: TotJob;
  readonly voice: TotVoice;
  readonly state: TotState;
  readonly createdAt: string;
}

// A string, because atoms compare by value and a rebuilt object would re-render every sidebar row.
const totIdentityJsonAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const entry = get(totForThreadAtom(key));
    return entry === null
      ? null
      : JSON.stringify({
          character: entry.tot.character,
          displayName: entry.displayName,
          job: entry.tot.job,
          voice: entry.tot.voice,
          state: entry.state,
          createdAt: entry.tot.createdAt,
        } satisfies TotIdentity);
  }).pipe(Atom.withLabel(`web-tot-identity:${key}`)),
);

const EMPTY_IDENTITY_ATOM = Atom.make<string | null>(null);

export function useTotIdentity(threadRef: ScopedThreadRef | null): TotIdentity | null {
  const json = useAtomValue(
    threadRef === null
      ? EMPTY_IDENTITY_ATOM
      : totIdentityJsonAtom(`${threadRef.environmentId}:${threadRef.threadId}`),
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
