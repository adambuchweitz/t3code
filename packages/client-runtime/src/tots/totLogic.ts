import type {
  EnvironmentId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2AppThreadLineage,
  ProjectId,
  ThreadId,
  Tot,
  TotCharterProposal,
  TotJob,
  TotRequest,
  TotVoice,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { TotPose } from "./totCharacter.ts";

/** Every client's thread status, as its thread list shows it. */
export type TotThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "preparing"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export type TotState = "needs" | "working" | "idle" | "offline";

export const TOT_STATE_ORDER: ReadonlyArray<TotState> = ["needs", "working", "idle", "offline"];

export const TOT_STATE_LABEL: Record<TotState, string> = {
  needs: msg("Needs you", { $context: "Tot state" }),
  working: msg("Busy", { $context: "Tot state" }),
  idle: msg("Idle", { $context: "Tot state" }),
  offline: msg("Offline", { $context: "Tot state" }),
};

const TOT_VOICE_STATE_LABEL: Record<TotVoice, Record<TotState, string>> = {
  toddler: {
    needs: msg("Tugging your sleeve", { $context: "Tot state, toddler voice" }),
    working: msg("Playing", { $context: "Tot state, toddler voice" }),
    idle: msg("Just looking", { $context: "Tot state, toddler voice" }),
    offline: msg("Napping", { $context: "Tot state, toddler voice" }),
  },
  polite: {
    needs: msg("Needs you", { $context: "Tot state" }),
    working: msg("Working", { $context: "Tot state" }),
    idle: msg("Watching", { $context: "Tot state" }),
    offline: msg("Offline", { $context: "Tot state" }),
  },
  grown_up: TOT_STATE_LABEL,
};

/** One Tot's own words for its state. Group headings stay in `TOT_STATE_LABEL`, as they mix voices. */
export function totStateLabel(
  state: TotState,
  voice: TotVoice,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(TOT_VOICE_STATE_LABEL[voice][state]);
}

export const TOT_VOICE_OPTIONS: ReadonlyArray<{
  readonly value: TotVoice;
  readonly label: string;
  readonly sample: string;
}> = [
  {
    value: "toddler",
    label: msg("Full toddler", { $context: "Tot voice" }),
    sample: msg("I did it! The checks are all green! Can I merge it? Pleeease?"),
  },
  {
    value: "polite",
    label: msg("Polite", { $context: "Tot voice" }),
    sample: msg("The checks passed. I'll merge it when you're happy."),
  },
  {
    value: "grown_up",
    label: msg("Grown-up", { $context: "Tot voice" }),
    sample: msg("Checks passed. Ready to merge."),
  },
];

export const TOT_JOB_LABEL: Record<TotJob, string> = {
  manager: msg("Project manager"),
  hands_on: msg("Hands-on", { $context: "Tot job, does the work itself" }),
};

export type TotCrewTone = "attention" | "failed" | "active" | "quiet";

/** How a crew thread reads on a Tot's Desk: what needs the user sorts first. */
export interface TotCrewStatus {
  readonly label: string;
  readonly rank: number;
  readonly tone: TotCrewTone;
}

const TOT_CREW_STATUS: Record<TotThreadStatus, TotCrewStatus> = {
  approval: {
    label: msg("Approval", { $context: "crew thread status" }),
    rank: 0,
    tone: "attention",
  },
  input: { label: msg("Question", { $context: "crew thread status" }), rank: 0, tone: "attention" },
  request: {
    label: msg("Request", { $context: "crew thread status" }),
    rank: 0,
    tone: "attention",
  },
  failed: { label: msg("Failed", { $context: "crew thread status" }), rank: 0, tone: "failed" },
  limited: {
    label: msg("Limited", { $context: "crew thread status" }),
    rank: 0,
    tone: "attention",
  },
  preparing: {
    label: msg("Preparing", { $context: "crew thread status" }),
    rank: 1,
    tone: "active",
  },
  working: { label: msg("Working", { $context: "crew thread status" }), rank: 1, tone: "active" },
  waiting: { label: msg("Waiting", { $context: "crew thread status" }), rank: 1, tone: "active" },
  ready: { label: msg("Ready", { $context: "crew thread status" }), rank: 2, tone: "quiet" },
};

export const TOT_STATE_POSE: Record<TotState, TotPose> = {
  needs: "needs",
  working: "working",
  idle: "awake",
  offline: "asleep",
};

/** Failures need the user too: nothing else will restart a Tot that stopped. */
export function resolveTotState(input: {
  readonly connected: boolean;
  readonly threadStatus: TotThreadStatus | null;
  readonly hasCharterProposal: boolean;
  readonly hasOpenRequests: boolean;
}): TotState {
  if (!input.connected) return "offline";
  if (input.hasCharterProposal || input.hasOpenRequests) return "needs";
  switch (input.threadStatus) {
    case "approval":
    case "input":
    case "request":
    case "failed":
    case "limited":
      return "needs";
    case "preparing":
    case "working":
    case "waiting":
      return "working";
    case "ready":
    case null:
      return "idle";
  }
}

export interface ConnectedThreadInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly lineage: OrchestrationV2AppThreadLineage;
  readonly delegatedFrom?: OrchestrationV2DelegatedFrom | null | undefined;
}

export interface ConnectableTot {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}

export type TotConnection = "self" | "launched" | "project";

const MAX_ANCESTORS = 32;

/**
 * Which Tot to show on a thread: the thread's own, else the nearest Tot up its
 * parents (delegated work can cross environments), else its project's first Tot.
 */
export function resolveConnectedTot<T extends ConnectableTot>(input: {
  readonly thread: ConnectedThreadInput;
  readonly tots: ReadonlyArray<T>;
  readonly readThread: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Pick<ConnectedThreadInput, "lineage" | "delegatedFrom"> | null;
}): { readonly tot: T; readonly connection: TotConnection } | null {
  const { thread, tots, readThread } = input;
  const totFor = (environmentId: EnvironmentId, threadId: ThreadId) =>
    tots.find((tot) => tot.environmentId === environmentId && tot.threadId === threadId);

  const own = totFor(thread.environmentId, thread.threadId);
  if (own) return { tot: own, connection: "self" };

  let current: Pick<ConnectedThreadInput, "lineage" | "delegatedFrom"> = thread;
  let environmentId = thread.environmentId;
  for (let hops = 0; hops < MAX_ANCESTORS; hops += 1) {
    const parentEnvironmentId: EnvironmentId = current.lineage.parentThreadId
      ? environmentId
      : (current.delegatedFrom?.environmentId ?? environmentId);
    const parentThreadId: ThreadId | undefined =
      current.lineage.parentThreadId ?? current.delegatedFrom?.threadId;
    if (!parentThreadId) break;
    const parentTot = totFor(parentEnvironmentId, parentThreadId);
    if (parentTot) return { tot: parentTot, connection: "launched" };
    const parent = readThread(parentEnvironmentId, parentThreadId);
    if (parent === null) {
      // Finished subagents can drop out of the shell list, so the root is the best remaining link.
      const rootTot = totFor(environmentId, current.lineage.rootThreadId);
      if (rootTot) return { tot: rootTot, connection: "launched" };
      break;
    }
    environmentId = parentEnvironmentId;
    current = parent;
  }

  const projectTot = tots.find(
    (tot) => tot.environmentId === thread.environmentId && tot.projectId === thread.projectId,
  );
  return projectTot ? { tot: projectTot, connection: "project" } : null;
}

/** A stable first suggestion, so reopening the dialog doesn't reshuffle it. */
export function suggestTotCharacterIndex(threadId: string, characterCount: number): number {
  let hash = 0;
  for (const char of threadId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % characterCount;
}

export interface CharterDiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

/** A longest-common-subsequence line diff. Charters are capped, so the table stays small. */
export function diffCharterLines(before: string, after: string): ReadonlyArray<CharterDiffLine> {
  const left = before === "" ? [] : before.split("\n");
  const right = after === "" ? [] : after.split("\n");
  const widths = right.length + 1;
  const lengths = new Uint16Array((left.length + 1) * widths);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i * widths + j] =
        left[i] === right[j]
          ? lengths[(i + 1) * widths + j + 1]! + 1
          : Math.max(lengths[(i + 1) * widths + j]!, lengths[i * widths + j + 1]!);
    }
  }
  const lines: Array<CharterDiffLine> = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({ kind: "same", text: left[i]! });
      i += 1;
      j += 1;
    } else if (
      j < right.length &&
      (i === left.length || lengths[i * widths + j + 1]! >= lengths[(i + 1) * widths + j]!)
    ) {
      lines.push({ kind: "added", text: right[j]! });
      j += 1;
    } else {
      lines.push({ kind: "removed", text: left[i]! });
      i += 1;
    }
  }
  return lines;
}

export function totRequestsHeading(
  displayName: string,
  voice: TotVoice,
  resolve: MFunctionType = mFallback,
): string {
  return voice === "toddler"
    ? resolve(msg("{name} needs you!", { name: displayName }))
    : resolve(msg("{name} needs you", { name: displayName }));
}

export function totWakeFoldLabel(
  input: {
    readonly voice: TotVoice;
    readonly checkIns: number;
    readonly updates: number;
  },
  resolve: MFunctionType = mFallback,
): string {
  const { checkIns, updates } = input;
  const total = checkIns + updates;
  const headline =
    input.voice === "toddler"
      ? resolve(
          msg(
            "{count, plural, =1 {I woke up once. Nothing for you!} other {I woke up {count} times. Nothing for you!}}",
            { count: total },
          ),
        )
      : resolve(
          msg(
            "{count, plural, one {{count} wake with nothing for you} other {{count} wakes with nothing for you}}",
            { count: total },
          ),
        );
  const parts =
    checkIns === 0
      ? resolve(
          msg("{count, plural, one {{count} thread update} other {{count} thread updates}}", {
            count: updates,
          }),
        )
      : updates === 0
        ? resolve(
            msg("{count, plural, one {{count} check-in} other {{count} check-ins}}", {
              count: checkIns,
            }),
          )
        : resolve(
            msg(
              "{checkIns, plural, one {{checkIns} check-in} other {{checkIns} check-ins}}, {updates, plural, one {{updates} thread update} other {{updates} thread updates}}",
              { checkIns, updates },
            ),
          );
  return `${headline} · ${parts}`;
}

function totCharterProposalTitle(
  displayName: string,
  voice: TotVoice,
  resolve: MFunctionType,
): string {
  return voice === "toddler"
    ? resolve(msg("{name} wants new house rules!", { name: displayName }))
    : resolve(msg("{name} proposes a charter change", { name: displayName }));
}

export type TotWaitingItem =
  | { readonly kind: "charter"; readonly id: string; readonly proposal: TotCharterProposal }
  | { readonly kind: "request"; readonly id: string; readonly request: TotRequest };

/** What's waiting on the user, oldest first. A charter change sorts by when it was proposed. */
export function totWaitingItems(
  tot: Pick<Tot, "charterProposal" | "requests">,
): ReadonlyArray<TotWaitingItem> {
  const items: Array<TotWaitingItem & { readonly at: string }> = tot.requests.map((request) => ({
    kind: "request",
    id: request.id,
    request,
    at: request.askedAt,
  }));
  if (tot.charterProposal !== null) {
    items.push({
      kind: "charter",
      id: tot.charterProposal.id,
      proposal: tot.charterProposal,
      at: tot.charterProposal.proposedAt,
    });
  }
  return [...items].sort((left, right) => left.at.localeCompare(right.at));
}

export function totWaitingItemTitle(
  item: TotWaitingItem,
  displayName: string,
  voice: TotVoice,
  resolve: MFunctionType = mFallback,
): string {
  return item.kind === "request"
    ? item.request.question
    : totCharterProposalTitle(displayName, voice, resolve);
}

/** The recommendation leads, so the quickest answer is also the one the Tot thinks is right. */
export function orderTotRequestOptions(request: TotRequest): ReadonlyArray<string> {
  return [...request.options].sort(
    (left, right) =>
      Number(right === request.recommendedOption) - Number(left === request.recommendedOption),
  );
}

/** Threads a Tot started or watches, while they're still open. */
export interface TotCrewThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly lineage: { readonly parentThreadId: ThreadId | null };
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
}

function isTotCrewThread(
  tot: Pick<Tot, "threadId" | "watchedThreadIds">,
  totEnvironmentId: EnvironmentId,
  thread: TotCrewThread,
): boolean {
  return (
    thread.environmentId === totEnvironmentId &&
    (thread.lineage.parentThreadId === tot.threadId || tot.watchedThreadIds.includes(thread.id)) &&
    thread.archivedAt === null &&
    thread.settledAt === null
  );
}

/** A Tot's open crew: who's working or needs the user, and the finished runs nobody settled yet. */
export function totCrew<T extends TotCrewThread>(input: {
  readonly tot: Pick<Tot, "threadId" | "watchedThreadIds">;
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<T>;
  readonly threadStatus: (thread: T) => TotThreadStatus;
}) {
  const active: Array<{ readonly thread: T; readonly status: TotCrewStatus }> = [];
  const finished: Array<T> = [];
  for (const thread of input.threads) {
    if (!isTotCrewThread(input.tot, input.environmentId, thread)) continue;
    const status = input.threadStatus(thread);
    if (status === "ready") finished.push(thread);
    else active.push({ thread, status: TOT_CREW_STATUS[status] });
  }
  active.sort(
    (left, right) =>
      left.status.rank - right.status.rank || left.thread.title.localeCompare(right.thread.title),
  );
  finished.sort((left, right) => left.title.localeCompare(right.title));
  return { active, finished };
}
