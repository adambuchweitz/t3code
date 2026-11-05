import type {
  EnvironmentId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2AppThreadLineage,
  ProjectId,
  ThreadId,
  TotTalkRequest,
  TotVoice,
} from "@t3tools/contracts";

import type { SidebarThreadStatus } from "../Sidebar.logic";
import type { TotPose } from "./TotCharacter";

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

export const TOT_STATE_POSE: Record<TotState, TotPose> = {
  needs: "needs",
  working: "working",
  idle: "awake",
  offline: "asleep",
};

/** Writing in the thread answers it. Wakes and agent messages don't count as the user writing. */
export function openTalkRequest(
  request: TotTalkRequest | null,
  latestUserAuthoredMessageAt: string | null | undefined,
): TotTalkRequest | null {
  if (request === null) return null;
  return latestUserAuthoredMessageAt != null &&
    Date.parse(latestUserAuthoredMessageAt) > Date.parse(request.askedAt)
    ? null
    : request;
}

/** Failures need the user too: nothing else will restart a Tot that stopped. */
export function resolveTotState(input: {
  readonly connected: boolean;
  readonly threadStatus: SidebarThreadStatus | null;
  readonly hasCharterProposal: boolean;
  readonly wantsToTalk: boolean;
}): TotState {
  if (!input.connected) return "offline";
  if (input.hasCharterProposal || input.wantsToTalk) return "needs";
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
