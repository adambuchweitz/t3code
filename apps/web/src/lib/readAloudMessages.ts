import type {
  MessageId,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import type { ChatMessage } from "~/types";

/** Selects live assistant text without making the composer subscribe to streamed deltas. */
export function createReadAloudMessagesAtom(threadAtom: Atom.Atom<EnvironmentThread | null>) {
  const response = Atom.make(
    (get) =>
      get(threadAtom)?.projection.visibleTurnItems.findLast(
        ({ item }) =>
          item.type === "assistant_message" && !item.streaming && item.text.trim() !== "",
      )?.item ?? null,
  );
  return response.pipe(
    Atom.map((item): ReadonlyArray<ChatMessage> =>
      item?.type === "assistant_message"
        ? [
            {
              id: item.messageId,
              role: "assistant",
              text: item.text,
              runId: item.runId,
              streaming: item.streaming,
              createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
              updatedAt: DateTime.formatIso(item.updatedAt),
            },
          ]
        : [],
    ),
  );
}

/** The newest finished assistant response in the visible timeline, inherited history included. */
export function latestReadAloudMessage(messages: ReadonlyArray<ChatMessage>): ChatMessage | null {
  return (
    messages.findLast(
      (message) => message.role === "assistant" && !message.streaming && message.text.trim() !== "",
    ) ?? null
  );
}

/**
 * The id of `latest` once its own run has completed. Agents post finished
 * interim messages between tool calls while a run keeps going; those are not
 * responses yet. The thread's newest run is not the test: a follow-up queued
 * during the turn is newer, while this message's run is the one finishing.
 */
export function completedResponseId(
  latest: ChatMessage | null,
  latestRunStatus: OrchestrationV2RunStatus | null,
): MessageId | null {
  return latest !== null && latestRunStatus === "completed" ? latest.id : null;
}

/** The newest response treated as already heard or skipped. */
export interface ResponseMark {
  readonly id: MessageId;
  readonly createdAt: string;
}

/**
 * Whether `message` is newer than `mark`. Rewinding a thread can make an older
 * answer the latest again; it was already heard, so it is not new.
 */
export function isNewerResponse(message: ResponseMark, mark: ResponseMark | null): boolean {
  if (mark === null) return true;
  const difference = Date.parse(message.createdAt) - Date.parse(mark.createdAt);
  return difference > 0 || (difference === 0 && message.id !== mark.id);
}

/** Moves the mark forward to `message`, never back. */
export function advanceResponseMark(
  mark: ResponseMark | null,
  message: ResponseMark,
): ResponseMark {
  return mark !== null && !isNewerResponse(message, mark)
    ? mark
    : { id: message.id, createdAt: message.createdAt };
}

/**
 * The finished response of `runId`, or null until thread detail has caught up
 * with the shell, which can report the run complete first.
 */
export function completedRunResponse(
  projection: {
    readonly runs: ReadonlyArray<
      Pick<OrchestrationV2ThreadProjection["runs"][number], "id" | "status">
    >;
    readonly visibleTurnItems: OrchestrationV2ThreadProjection["visibleTurnItems"];
  },
  runId: RunId,
): string | null {
  if (!projection.runs.some((run) => run.id === runId && run.status === "completed")) return null;
  const row = projection.visibleTurnItems.findLast(
    ({ item }) =>
      item.runId === runId &&
      item.type === "assistant_message" &&
      item.status === "completed" &&
      !item.streaming &&
      item.text.trim() !== "",
  );
  return row?.item.type === "assistant_message" ? row.item.text : null;
}
