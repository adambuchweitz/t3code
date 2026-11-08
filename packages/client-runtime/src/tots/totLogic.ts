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
  needs: "Needs you",
  working: "Busy",
  idle: "Idle",
  offline: "Offline",
};

const TOT_VOICE_STATE_LABEL: Record<TotVoice, Record<TotState, string>> = {
  toddler: {
    needs: "Tugging your sleeve",
    working: "Playing",
    idle: "Just looking",
    offline: "Napping",
  },
  polite: { needs: "Needs you", working: "Working", idle: "Watching", offline: "Offline" },
  grown_up: TOT_STATE_LABEL,
};

/** One Tot's own words for its state. Group headings stay in `TOT_STATE_LABEL`, as they mix voices. */
export function totStateLabel(state: TotState, voice: TotVoice): string {
  return TOT_VOICE_STATE_LABEL[voice][state];
}

export const TOT_VOICE_OPTIONS: ReadonlyArray<{
  readonly value: TotVoice;
  readonly label: string;
  readonly sample: string;
}> = [
  {
    value: "toddler",
    label: "Full toddler",
    sample: "I did it! The checks are all green! Can I merge it? Pleeease?",
  },
  {
    value: "polite",
    label: "Polite",
    sample: "The checks passed. I'll merge it when you're happy.",
  },
  { value: "grown_up", label: "Grown-up", sample: "Checks passed. Ready to merge." },
];

export const TOT_JOB_LABEL: Record<TotJob, string> = {
  manager: "Project manager",
  hands_on: "Hands-on",
};

export type TotCrewTone = "attention" | "failed" | "active" | "quiet";

/** How a crew thread reads on a Tot's Desk: what needs the user sorts first. */
export interface TotCrewStatus {
  readonly label: string;
  readonly rank: number;
  readonly tone: TotCrewTone;
}

const TOT_CREW_STATUS: Record<TotThreadStatus, TotCrewStatus> = {
  approval: { label: "Approval", rank: 0, tone: "attention" },
  input: { label: "Question", rank: 0, tone: "attention" },
  request: { label: "Request", rank: 0, tone: "attention" },
  failed: { label: "Failed", rank: 0, tone: "failed" },
  limited: { label: "Limited", rank: 0, tone: "attention" },
  preparing: { label: "Preparing", rank: 1, tone: "active" },
  working: { label: "Working", rank: 1, tone: "active" },
  waiting: { label: "Waiting", rank: 1, tone: "active" },
  ready: { label: "Ready", rank: 2, tone: "quiet" },
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

export function totRequestsHeading(displayName: string, voice: TotVoice): string {
  return voice === "toddler" ? `${displayName} needs you!` : `${displayName} needs you`;
}

export function totWakeFoldLabel(input: {
  readonly voice: TotVoice;
  readonly checkIns: number;
  readonly updates: number;
}): string {
  const total = input.checkIns + input.updates;
  const parts = [
    input.checkIns === 0 ? null : `${input.checkIns} check-in${input.checkIns === 1 ? "" : "s"}`,
    input.updates === 0 ? null : `${input.updates} thread update${input.updates === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const headline =
    input.voice === "toddler"
      ? `I woke up ${total === 1 ? "once" : `${total} times`}. Nothing for you!`
      : `${total} wake${total === 1 ? "" : "s"} with nothing for you`;
  return `${headline} · ${parts.join(", ")}`;
}

function totCharterProposalTitle(displayName: string, voice: TotVoice): string {
  return voice === "toddler"
    ? `${displayName} wants new house rules!`
    : `${displayName} proposes a charter change`;
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
): string {
  return item.kind === "request"
    ? item.request.question
    : totCharterProposalTitle(displayName, voice);
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
