import type {
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
  Tot,
  TotJob,
  TotListResult,
  TotVoice,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { scopeProjectRef, scopeThreadRef } from "../environment/index.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "../state/connections.ts";
import type { EnvironmentThreadShell } from "../state/shell.ts";
import {
  resolveTotState,
  totWaitingItems,
  type TotState,
  type TotThreadStatus,
  type TotWaitingItem,
} from "./totLogic.ts";

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

/** What a thread needs to look like its Tot, without changing every time the Tot's thread does. */
export interface TotIdentity {
  readonly character: string;
  readonly displayName: string;
  readonly job: TotJob;
  readonly voice: TotVoice;
  readonly state: TotState;
  readonly createdAt: string;
}

const EMPTY_TOTS: ReadonlyArray<Tot> = Object.freeze([]);

export const totThreadKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

export function createTotEntryAtoms<E>(input: {
  readonly label: string;
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly presentationsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>;
  readonly totsLiveAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<TotListResult, E>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>;
  readonly projectAtom: (
    ref: ScopedProjectRef,
  ) => Atom.Atom<{ readonly title: string } | null | undefined>;
  readonly threadStatus: (thread: EnvironmentThreadShell) => TotThreadStatus;
  /** Keeps a Tot on a machine that's off visible as offline across a reload. */
  readonly cache?: {
    readonly read: (environmentId: EnvironmentId) => ReadonlyArray<Tot>;
    readonly write: (environmentId: EnvironmentId, result: TotListResult) => void;
  };
}) {
  const environmentTotsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyArray<Tot> => {
      const live = AsyncResult.value(get(input.totsLiveAtom(environmentId)));
      if (Option.isNone(live)) return input.cache?.read(environmentId) ?? EMPTY_TOTS;
      input.cache?.write(environmentId, live.value);
      return live.value.tots;
    }).pipe(Atom.withLabel(`${input.label}:tots:${environmentId}`)),
  );

  /** Only depends on the Tots' own threads, so busy threads elsewhere don't recompute it. */
  const entriesAtom = Atom.make((get): ReadonlyArray<TotEntry> => {
    const presentations = get(input.presentationsAtom);
    const entries: Array<TotEntry> = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const presentation = presentations.get(environmentId);
      for (const tot of get(environmentTotsAtom(environmentId))) {
        const threadRef = scopeThreadRef(environmentId, tot.threadId);
        const thread = get(input.threadShellAtom(threadRef));
        const project = get(input.projectAtom(scopeProjectRef(environmentId, tot.projectId)));
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
            threadStatus: thread === null ? null : input.threadStatus(thread),
            hasCharterProposal: tot.charterProposal !== null,
            hasOpenRequests: tot.requests.length > 0,
          }),
        });
      }
    }
    return entries;
  }).pipe(Atom.withLabel(`${input.label}:tot-entries`));

  const entryForThreadAtom = Atom.family((key: string) =>
    Atom.make(
      (get) => get(entriesAtom).find((entry) => totThreadKey(entry.threadRef) === key) ?? null,
    ).pipe(Atom.withLabel(`${input.label}:tot-for-thread:${key}`)),
  );

  // A string, because atoms compare by value and a rebuilt object would re-render every list row.
  const identityJsonAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const entry = get(entryForThreadAtom(key));
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
    }).pipe(Atom.withLabel(`${input.label}:tot-identity:${key}`)),
  );

  return { entriesAtom, entryForThreadAtom, identityJsonAtom };
}

type TotCrewNeed = "approval" | "input" | "request";

const isCrewNeed = (status: TotThreadStatus): status is TotCrewNeed =>
  status === "approval" || status === "input" || status === "request";

function totCrewNeedLabel(title: string, need: TotCrewNeed, resolve: MFunctionType): string {
  switch (need) {
    case "approval":
      return resolve(msg("{title} needs approval", { title }));
    case "input":
      return resolve(msg("{title} has a question", { title }));
    case "request":
      return resolve(msg("{title} needs an answer", { title }));
  }
}

/** "Project on machine", for a Tot's project and the machine it runs on; either may be missing. */
export function totLocationLabel(
  projectName: string | null,
  machineLabel: string | null,
  resolve: MFunctionType = mFallback,
): string {
  if (projectName && machineLabel) {
    return resolve(msg("{project} on {machine}", { project: projectName, machine: machineLabel }));
  }
  return projectName || machineLabel || "";
}

/** Where a Tot lives, for a list that mixes Tots from every project and machine. */
export function totPlaceLabel(entry: TotEntry): string {
  return [entry.displayName, entry.tot.nameEnabled ? entry.projectName : null, entry.machineLabel]
    .filter(Boolean)
    .join(" · ");
}

/** Everything every connected machine's Tots are waiting on, oldest first, then crew who need an answer. */
export function totWaitingQueue<T extends EnvironmentThreadShell>(
  input: {
    readonly entries: ReadonlyArray<TotEntry>;
    readonly threads: ReadonlyArray<T>;
    readonly threadStatus: (thread: T) => TotThreadStatus;
  },
  resolve: MFunctionType = mFallback,
) {
  const items = input.entries
    .flatMap((entry) =>
      totWaitingItems(entry.tot).map((item: TotWaitingItem) => ({
        entry,
        item,
        at: item.kind === "request" ? item.request.askedAt : item.proposal.proposedAt,
      })),
    )
    .sort((left, right) => left.at.localeCompare(right.at));
  const crewNeeds = input.threads.flatMap((thread) => {
    const status = input.threadStatus(thread);
    if (!isCrewNeed(status) || thread.archivedAt !== null) return [];
    const entry = input.entries.find(
      (candidate) =>
        candidate.environmentId === thread.environmentId &&
        candidate.threadId !== thread.id &&
        (thread.lineage.parentThreadId === candidate.threadId ||
          candidate.tot.watchedThreadIds.includes(thread.id)),
    );
    return entry === undefined
      ? []
      : [{ entry, thread, label: totCrewNeedLabel(thread.title, status, resolve) }];
  });
  return { items, crewNeeds, total: items.length + crewNeeds.length };
}
