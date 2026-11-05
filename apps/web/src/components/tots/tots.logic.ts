import type {
  EnvironmentId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2AppThreadLineage,
  ProjectId,
  ThreadId,
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

export const TOT_STATE_POSE: Record<TotState, TotPose> = {
  needs: "needs",
  working: "working",
  idle: "awake",
  offline: "asleep",
};

/** Failures need the user too: nothing else will restart a Tot that stopped. */
export function resolveTotState(input: {
  readonly connected: boolean;
  readonly threadStatus: SidebarThreadStatus | null;
}): TotState {
  if (!input.connected) return "offline";
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
