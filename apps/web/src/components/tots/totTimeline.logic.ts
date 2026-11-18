import type { TotVoice } from "@t3tools/contracts";

import { m, type MessageResolver } from "../../i18n/messages";
import type { TurnDiffSummary } from "../../types";
import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import { totWakeFoldLabel } from "@t3tools/client-runtime/tots/logic";

type MessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;

const isUserMessage = (row: MessagesTimelineRow): row is MessageRow =>
  row.kind === "message" && row.message.role === "user";

/** Anything but the user's own message: a schedule, a watch report, another thread writing in. */
const isWake = (row: MessageRow) =>
  row.message.createdBy !== undefined && row.message.createdBy !== "user";

/** A wake that left something to look at keeps its place in the conversation. */
function isNoteworthy(
  row: MessagesTimelineRow,
  changedFilesMessageIds: ReadonlySet<string | null>,
): boolean {
  switch (row.kind) {
    case "event":
    case "proposed-plan":
    case "html-render":
    case "mcp-app":
    case "working":
    case "thinking":
    case "work-live":
    case "worktree-setup":
      return true;
    case "message":
      return row.message.streaming || changedFilesMessageIds.has(row.message.id);
    default:
      return false;
  }
}

/**
 * Condenses a Tot's thread for reading: runs of wakes with nothing to show fold into one row, and
 * each reply since it became a Tot is marked to carry its face. The newest turn stays out of any
 * fold, so the Tot's latest word is always in view and nothing folds while you read it.
 */
export function foldTotWakes(
  rows: ReadonlyArray<MessagesTimelineRow>,
  options: {
    readonly voice: TotVoice;
    readonly becameTotAt: string;
    readonly expandedFoldIds: ReadonlySet<string>;
    readonly expandAll: boolean;
    readonly turnDiffSummaries: ReadonlyArray<
      Pick<TurnDiffSummary, "assistantMessageId" | "files">
    >;
  },
  resolve: MessageResolver = m,
): MessagesTimelineRow[] {
  const changedFilesMessageIds = new Set(
    options.turnDiffSummaries.flatMap((summary) =>
      summary.files.length > 0 ? [summary.assistantMessageId] : [],
    ),
  );
  const turns: Array<Array<MessagesTimelineRow>> = [[]];
  for (const row of rows) {
    if (isUserMessage(row)) turns.push([]);
    turns.at(-1)!.push(row);
  }

  const result: MessagesTimelineRow[] = [];
  let pending: Array<Array<MessagesTimelineRow>> = [];
  const flush = () => {
    if (pending.length === 0) return;
    const opener = (turn: ReadonlyArray<MessagesTimelineRow>) => turn[0] as MessageRow;
    const id = `tot-wake-fold:${opener(pending[0]!).id}`;
    const expanded = options.expandAll || options.expandedFoldIds.has(id);
    const checkIns = pending.filter(
      (turn) => opener(turn).message.scheduledTaskId !== undefined,
    ).length;
    result.push({
      kind: "tot-wake-fold",
      id,
      createdAt: opener(pending.at(-1)!).createdAt,
      label: totWakeFoldLabel(
        { voice: options.voice, checkIns, updates: pending.length - checkIns },
        resolve,
      ),
      expanded,
    });
    if (expanded) result.push(...pending.flat());
    pending = [];
  };

  turns.forEach((turn, index) => {
    const first = turn[0];
    const marked = markFirstReply(turn, options.becameTotAt);
    const quietWake =
      first !== undefined &&
      isUserMessage(first) &&
      isWake(first) &&
      index < turns.length - 1 &&
      !turn.some((row) => isNoteworthy(row, changedFilesMessageIds));
    if (quietWake) {
      pending.push(marked);
      return;
    }
    flush();
    result.push(...marked);
  });
  flush();
  return result;
}

function markFirstReply(
  turn: ReadonlyArray<MessagesTimelineRow>,
  becameTotAt: string,
): Array<MessagesTimelineRow> {
  const index = turn.findIndex((row) => row.kind === "message" && row.message.role === "assistant");
  const reply = turn[index];
  if (reply === undefined || reply.kind !== "message" || reply.createdAt < becameTotAt) {
    return [...turn];
  }
  return turn.map((row, rowIndex) =>
    rowIndex === index ? { ...reply, startsTotTurn: true } : row,
  );
}
