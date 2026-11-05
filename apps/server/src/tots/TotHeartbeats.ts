import type { ScheduledTask, Tot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TotService from "./TotService.ts";
import {
  isTotHeartbeatTaskId,
  TOT_HEARTBEAT_EVERY_MS,
  TOT_HEARTBEAT_PROMPT,
  TOT_HEARTBEAT_TITLE,
  totHeartbeatTaskId,
} from "./totHeartbeat.ts";
import { ensureTotsTable } from "./totsTable.ts";

/**
 * Keeps one heartbeat schedule on every Tot. It's an ordinary schedule, so it can be edited,
 * paused and run from the same places as any other. Sits above the scheduled task service,
 * which depends on Tot wakes, so `TotService` can't create it directly.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureTotsTable;
    const tots = yield* TotService.TotService;
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    const threads = yield* ThreadManagementService.ThreadManagementService;

    const ensure = Effect.fn("TotHeartbeats.ensure")(function* (tot: Tot) {
      const shell = yield* threads.getThreadShell(tot.threadId);
      if (shell === null) return;
      const rows = yield* sql<{ readonly heartbeat_created: number }>`
        SELECT heartbeat_created FROM tots WHERE tot_id = ${tot.id}
      `;
      if (rows[0] === undefined) return;
      yield* tasks.upsert({
        id: totHeartbeatTaskId(tot.id),
        title: TOT_HEARTBEAT_TITLE,
        prompt: TOT_HEARTBEAT_PROMPT,
        // One the user deleted comes back paused: still there to turn on, but not waking anything.
        enabled: rows[0].heartbeat_created === 0,
        schedule: { type: "interval", everyMs: TOT_HEARTBEAT_EVERY_MS },
        projectId: shell.projectId,
        threadId: tot.threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdBy: "system",
        creationSource: "server",
      });
      yield* sql`UPDATE tots SET heartbeat_created = 1 WHERE tot_id = ${tot.id}`;
    });

    const reconcile = Effect.fn("TotHeartbeats.reconcile")(function* (current: ReadonlyArray<Tot>) {
      const existing = (yield* tasks.list()).tasks;
      const has = new Set(existing.map((task: ScheduledTask) => task.id));
      for (const tot of current) {
        if (!has.has(totHeartbeatTaskId(tot.id))) yield* ensure(tot);
      }
      const wanted = new Set(current.map((tot) => totHeartbeatTaskId(tot.id) as string));
      for (const task of existing) {
        if (isTotHeartbeatTaskId(task.id) && !wanted.has(task.id)) {
          yield* tasks.delete({ id: task.id });
        }
      }
    });

    yield* tots.subscribeList().pipe(
      Stream.runForEach(({ tots: current }) =>
        reconcile(current).pipe(
          Effect.catch((cause) => Effect.logWarning("Could not update Tot heartbeats", { cause })),
        ),
      ),
      Effect.catch((cause) => Effect.logWarning("Could not read Tots for heartbeats", { cause })),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  }),
);
