import {
  ProjectId,
  ScheduledTaskId,
  TotWakeSettings,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TotService from "./TotService.ts";
import { ensureTotsTable } from "./totsTable.ts";

export type TotWakeDecision =
  | { readonly _tag: "run"; readonly prompt: string }
  | { readonly _tag: "held" }
  | { readonly _tag: "skipped" };

const CHECK_TIMEOUT = "60 seconds";
const RELEASE_EVERY = "1 minute";
const SKIP_EXIT_CODE = 1;

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(TotWakeSettings));

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export function isWithinQuietHours(
  minuteOfDay: number,
  quietHours: TotWakeSettings["quietHours"],
): boolean {
  if (quietHours === null) return false;
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
  if (start === end) return false;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

interface HeldWake {
  readonly held_id: string;
  readonly thread_id: string;
  readonly scheduled_task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly held_at: string;
}

/** Repeats of one schedule collapse to its latest prompt, so waiting doesn't multiply the work. */
function mergeHeldWakes(wakes: ReadonlyArray<HeldWake>): string {
  const byTask = new Map<string, { latest: HeldWake; times: number }>();
  for (const wake of wakes) {
    const seen = byTask.get(wake.scheduled_task_id);
    byTask.set(wake.scheduled_task_id, { latest: wake, times: (seen?.times ?? 0) + 1 });
  }
  const groups = [...byTask.values()];
  if (groups.length === 1 && groups[0]!.times === 1) return groups[0]!.latest.prompt;
  const sections = groups.map(
    ({ latest, times }) =>
      `## ${latest.title} (held ${times === 1 ? "once" : `${times} times`}, last at ${latest.held_at})\n\n${latest.prompt}`,
  );
  return `These scheduled wakes waited for quiet hours or the daily limit to end. Handle them together in this one turn.\n\n${sections.join("\n\n")}`;
}

const localClock = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone).pipe(
  Effect.map((now) => {
    const parts = DateTime.toParts(now);
    return {
      iso: DateTime.formatIso(now),
      minuteOfDay: parts.hour * 60 + parts.minute,
      day: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    };
  }),
);

export interface TotWakesShape {
  /** Decides what a schedule's wake does on a Tot's thread. Anything unreadable just runs it. */
  readonly admit: (input: {
    readonly threadId: ThreadId;
    readonly heldId: string;
    readonly scheduledTaskId: ScheduledTaskId;
    readonly title: string;
    readonly prompt: string;
    readonly runCheck: boolean;
  }) => Effect.Effect<TotWakeDecision>;
  readonly releaseDue: Effect.Effect<void>;
}

/** A reference so that the scheduled task service's many test layers need nothing. */
export class TotWakes extends Context.Reference<TotWakesShape>("t3/tots/TotWakes", {
  defaultValue: () => ({
    admit: (input) => Effect.succeed({ _tag: "run", prompt: input.prompt }),
    releaseDue: Effect.void,
  }),
}) {}

interface TotWakeRow {
  readonly wake_settings: string;
  readonly wake_day: string | null;
  readonly wake_count: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureTotsTable;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const tots = yield* TotService.TotService;

  const readTot = (threadId: string) =>
    sql<TotWakeRow>`
      SELECT wake_settings, wake_day, wake_count FROM tots WHERE thread_id = ${threadId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(null)
          : decodeSettings(rows[0].wake_settings).pipe(
              Effect.map((settings) => ({ row: rows[0]!, settings })),
            ),
      ),
    );

  const isOpen = (
    tot: { readonly row: TotWakeRow; readonly settings: TotWakeSettings },
    clock: { readonly minuteOfDay: number; readonly day: string },
  ) => {
    if (isWithinQuietHours(clock.minuteOfDay, tot.settings.quietHours)) return false;
    const limit = tot.settings.dailyWakeLimit;
    const used = tot.row.wake_day === clock.day ? tot.row.wake_count : 0;
    return limit === null || used < limit;
  };

  const countWake = (threadId: string, day: string) => sql`
    UPDATE tots SET
      wake_count = CASE WHEN wake_day = ${day} THEN wake_count + 1 ELSE 1 END,
      wake_day = ${day}
    WHERE thread_id = ${threadId}
  `;

  /** A check that can't give a clear answer shouldn't silence the Tot, so it says so and wakes. */
  const runWakeCheck = Effect.fn("TotWakes.runWakeCheck")(function* (
    threadId: ThreadId,
    command: string,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    const project =
      shell === null || shell.worktreePath !== null
        ? Option.none()
        : yield* projects.getById(shell.projectId);
    const cwd = shell?.worktreePath ?? Option.getOrNull(project)?.workspaceRoot ?? null;
    if (cwd === null) return { skip: false, note: "its folder could not be found" };
    const windows = (yield* HostProcess.Platform) === "win32";
    const output = yield* runner.run({
      command: windows ? "cmd.exe" : "sh",
      args: windows ? ["/d", "/s", "/c", command] : ["-c", command],
      cwd,
      timeout: Duration.fromInputUnsafe(CHECK_TIMEOUT),
      timeoutBehavior: "timedOutResult",
      outputMode: "truncate",
      maxOutputBytes: 64 * 1024,
    });
    if (output.timedOut) return { skip: false, note: `it timed out after ${CHECK_TIMEOUT}` };
    if (output.code === 0) return { skip: false, note: null };
    if (output.code === SKIP_EXIT_CODE) return { skip: true, note: null };
    return { skip: false, note: `it exited with code ${output.code ?? "unknown"}` };
  });

  const admit: TotWakesShape["admit"] = Effect.fn("TotWakes.admit")(
    function* (input) {
      const tot = yield* readTot(input.threadId);
      if (tot === null) return { _tag: "run" as const, prompt: input.prompt };
      const check = input.runCheck
        ? tot.settings.wakeChecks.find((c) => c.scheduledTaskId === input.scheduledTaskId)
        : undefined;
      const checked =
        check === undefined ? null : yield* runWakeCheck(input.threadId, check.command);
      if (checked?.skip === true) return { _tag: "skipped" as const };
      const prompt =
        checked?.note == null
          ? input.prompt
          : `This wake's check couldn't decide because ${checked.note}, so it ran anyway.\n\n${input.prompt}`;
      const clock = yield* localClock;
      if (!isOpen(tot, clock)) {
        yield* sql`
          INSERT INTO tot_held_wakes (
            held_id, thread_id, scheduled_task_id, title, prompt, held_at
          ) VALUES (
            ${input.heldId}, ${input.threadId}, ${input.scheduledTaskId}, ${input.title},
            ${prompt}, ${clock.iso}
          )
          ON CONFLICT (held_id) DO NOTHING
        `;
        yield* tots.notifyChanged;
        return { _tag: "held" as const };
      }
      yield* countWake(input.threadId, clock.day);
      return { _tag: "run" as const, prompt };
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not screen a Tot's wake, so it will run", { cause }).pipe(
            Effect.as({ _tag: "run" as const, prompt: input.prompt }),
          ),
        ),
      ),
  );

  const releaseThread = Effect.fn("TotWakes.releaseThread")(function* (threadId: string) {
    const id = ThreadId.make(threadId);
    const shell = yield* threads.getThreadShell(id);
    if (shell === null || shell.deletedAt !== null) {
      yield* sql`DELETE FROM tot_held_wakes WHERE thread_id = ${threadId}`;
      return;
    }
    const clock = yield* localClock;
    const tot = yield* readTot(threadId);
    // Turning the Tot back into a thread leaves no window to wait for.
    if (tot !== null && !isOpen(tot, clock)) return;
    const wakes = yield* sql<HeldWake>`
      SELECT * FROM tot_held_wakes WHERE thread_id = ${threadId} ORDER BY held_at, held_id
    `;
    const first = wakes[0];
    if (first === undefined) return;
    yield* threads.sendToThread({
      projectId: ProjectId.make(shell.projectId),
      // Named after the first wake, so a crash before the delete below replays safely.
      commandId: CommandId.make(`tot-wake:${first.held_id}`),
      messageId: MessageId.make(`tot-wake-message:${first.held_id}`),
      threadId: id,
      ...(wakes.every((wake) => wake.scheduled_task_id === first.scheduled_task_id)
        ? { scheduledTaskId: ScheduledTaskId.make(first.scheduled_task_id) }
        : {}),
      text: mergeHeldWakes(wakes),
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "web",
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const wake of wakes) {
          yield* sql`DELETE FROM tot_held_wakes WHERE held_id = ${wake.held_id}`;
        }
        if (tot !== null) yield* countWake(threadId, clock.day);
      }),
    );
    yield* tots.notifyChanged;
  });

  const releaseDue: TotWakesShape["releaseDue"] = Effect.gen(function* () {
    const held = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM tot_held_wakes
    `;
    for (const { thread_id } of held) {
      yield* releaseThread(thread_id).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not release a Tot's held wakes; trying again", { cause }),
        ),
      );
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Could not read held Tot wakes", { cause })),
    Effect.withSpan("TotWakes.releaseDue"),
  );

  yield* releaseDue.pipe(Effect.repeat(Schedule.spaced(RELEASE_EVERY)), Effect.forkScoped);
  return { admit, releaseDue } satisfies TotWakesShape;
});

export const layer = Layer.effect(TotWakes, make);
