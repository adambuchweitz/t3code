import { MessageId, ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import { foldTotWakes } from "./totTimeline.logic";

type Row = MessagesTimelineRow;

const message = (
  id: string,
  role: "user" | "assistant",
  extra: Record<string, unknown> = {},
  rowExtra: Record<string, unknown> = {},
): Row =>
  ({
    kind: "message",
    id,
    createdAt: "2026-11-06T10:00:00.000Z",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      runId: null,
      streaming: false,
      createdAt: "2026-11-06T10:00:00.000Z",
      updatedAt: "2026-11-06T10:00:00.000Z",
      createdBy: role === "user" ? "user" : "agent",
      ...extra,
    },
    ...rowExtra,
  }) as Row;

const heartbeat = (id: string) =>
  message(id, "user", { createdBy: "system", scheduledTaskId: ScheduledTaskId.make("task") });
const report = (id: string) => message(id, "user", { createdBy: "agent" });
const reply = (id: string) => message(id, "assistant");

const fold = (rows: ReadonlyArray<Row>, expanded: ReadonlyArray<string> = [], expandAll = false) =>
  foldTotWakes(rows, {
    voice: "grown_up",
    becameTotAt: "2026-11-06T00:00:00.000Z",
    expandedFoldIds: new Set(expanded),
    expandAll,
  });

const shape = (rows: ReadonlyArray<Row>) =>
  rows.map((row) => (row.kind === "tot-wake-fold" ? row.label : row.id));

describe("foldTotWakes", () => {
  const quiet = [
    message("you", "user"),
    reply("r0"),
    heartbeat("h1"),
    reply("r1"),
    report("w2"),
    reply("r2"),
    heartbeat("h3"),
    reply("r3"),
  ];

  it("folds a run of quiet wakes but keeps the newest turn in view", () => {
    expect(shape(fold(quiet))).toEqual([
      "you",
      "r0",
      "2 wakes with nothing for you · 1 check-in, 1 thread update",
      "h3",
      "r3",
    ]);
  });

  it("shows a fold's turns once it's opened, or while searching", () => {
    const opened = ["you", "r0", expect.any(String), "h1", "r1", "w2", "r2", "h3", "r3"];
    expect(shape(fold(quiet, ["tot-wake-fold:h1"]))).toEqual(opened);
    expect(shape(fold(quiet, [], true))).toEqual(opened);
  });

  it.each<[string, Row]>([
    [
      "changed files",
      message("r1", "assistant", {}, { assistantTurnDiffSummary: { files: [{}] } }),
    ],
    ["started a thread", { kind: "event", id: "e1", createdAt: "x" } as unknown as Row],
    ["is still running", { kind: "working", id: "live", createdAt: "x" } as unknown as Row],
  ])("keeps a wake that %s in the conversation", (_name, row) => {
    const rows = [heartbeat("h1"), row, heartbeat("h2"), reply("r2"), message("you", "user")];
    expect(shape(fold(rows))[0]).toBe("h1");
  });

  it("never folds the user's own turns", () => {
    const rows = [message("a", "user"), reply("r1"), message("b", "user"), reply("r2")];
    expect(shape(fold(rows))).toEqual(["a", "r1", "b", "r2"]);
  });

  it("gives only each turn's first reply since adoption the Tot's face", () => {
    const earlier = { ...reply("old"), createdAt: "2026-11-05T00:00:00.000Z" } as Row;
    const rows = [
      message("before", "user"),
      earlier,
      message("you", "user"),
      reply("r1"),
      reply("r2"),
    ];
    const marked = fold(rows).flatMap((row) =>
      row.kind === "message" && row.startsTotTurn ? [row.id] : [],
    );
    expect(marked).toEqual(["r1"]);
  });
});
