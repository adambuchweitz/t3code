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
import { formatTotBriefing, totHeartbeatTaskId } from "./totHeartbeat.ts";
import { ensureTotsTable } from "./totsTable.ts";

export type TotWakeDecision =
  | { readonly _tag: "run"; readonly prompt: string }
  | { readonly _tag: "held" }
  | { readonly _tag: "skipped" };

const CHECK_TIMEOUT = "60 seconds";
const RELEASE_EVERY = "1 minute";
const SKIP_EXIT_CODE = 1;
// Far beyond any restart, because a pending webhook has no expiry of its own to match.
const FORGET_RELEASED_AFTER_DAYS = 90;

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
    /** The user asked for this wake, so nothing screens it. */
    readonly manual?: boolean;
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
  readonly tot_id: string;
  readonly wake_settings: string;
  readonly wake_day: string | null;
  readonly wake_count: number;
  readonly briefed_at: string | null;
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
      SELECT tot_id, wake_settings, wake_day, wake_count, briefed_at
      FROM tots WHERE thread_id = ${threadId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(null)
          : decodeSettings(rows[0].wake_settings).pipe(
              Effect.map((settings) => ({ row: rows[0]!, settings })),
            ),
      ),
    );

  /** Takes one wake from the day's limit, atomically, so concurrent wakes can't both have the last. */
  const reserveWake = (threadId: string, day: string, limit: TotWakeSettings["dailyWakeLimit"]) =>
    sql<{ readonly thread_id: string }>`
      UPDATE tots SET
        wake_count = CASE WHEN wake_day = ${day} THEN wake_count + 1 ELSE 1 END,
        wake_day = ${day}
      WHERE thread_id = ${threadId}
        AND (${limit} IS NULL OR wake_day IS NOT ${day} OR wake_count < ${limit})
      RETURNING thread_id
    `.pipe(Effect.map((rows) => rows.length > 0));

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

  /** Taken before reading, so a change during the read shows up again rather than never. */
  const withBriefing = Effect.fn("TotWakes.withBriefing")(function* (
    threadId: ThreadId,
    briefedAt: string | null,
    prompt: string,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return prompt;
    const now = yield* DateTime.now;
    const since = briefedAt === null ? null : DateTime.makeUnsafe(briefedAt);
    const entries = yield* threads.listProjectThreads({
      projectId: shell.projectId,
      includeSubagents: false,
    });
    // Listings carry no run state, so the briefing reads full shells.
    const others =
      entries.length === 0
        ? []
        : (yield* threads.getShellSnapshot({
            location: "active",
            threadIds: entries.map(({ id }) => id),
          })).threads;
    const briefing = formatTotBriefing({ threads: others, selfId: threadId, since });
    yield* sql`
      UPDATE tots SET briefed_at = ${DateTime.formatIso(now)} WHERE thread_id = ${threadId}
    `;
    return `${prompt}\n\n${briefing}`;
  });

  const admit: TotWakesShape["admit"] = Effect.fn("TotWakes.admit")(
    function* (input) {
      // A pending webhook retries after a restart. Once its wake was held, it stays that row's job.
      const alreadyHeld = yield* sql`
        SELECT 1 FROM tot_held_wakes WHERE held_id = ${input.heldId}
      `;
      if (alreadyHeld.length > 0) return { _tag: "held" as const };
      const before = yield* readTot(input.threadId);
      if (before === null) return { _tag: "run" as const, prompt: input.prompt };
      const isHeartbeat = input.scheduledTaskId === totHeartbeatTaskId(before.row.tot_id);
      if (input.manual === true) {
        return {
          _tag: "run" as const,
          prompt: isHeartbeat
            ? yield* withBriefing(input.threadId, before.row.briefed_at, input.prompt)
            : input.prompt,
        };
      }
      // Queuing heartbeats behind a long turn would only pile up the same question.
      if (isHeartbeat && (yield* threads.getThreadShell(input.threadId))?.activeRunId != null) {
        return { _tag: "skipped" as const };
      }
      const check = input.runCheck
        ? before.settings.wakeChecks.find((c) => c.scheduledTaskId === input.scheduledTaskId)
        : undefined;
      const checked =
        check === undefined ? null : yield* runWakeCheck(input.threadId, check.command);
      if (checked?.skip === true) return { _tag: "skipped" as const };
      const prompt =
        checked?.note == null
          ? input.prompt
          : `This wake's check couldn't decide because ${checked.note}, so it ran anyway.\n\n${input.prompt}`;
      // The check can take a while, and the settings or the Tot can change during it.
      const tot = yield* readTot(input.threadId);
      if (tot === null) return { _tag: "run" as const, prompt };
      const clock = yield* localClock;
      const open =
        !isWithinQuietHours(clock.minuteOfDay, tot.settings.quietHours) &&
        (yield* reserveWake(input.threadId, clock.day, tot.settings.dailyWakeLimit));
      if (open) {
        return {
          _tag: "run" as const,
          prompt: isHeartbeat
            ? yield* withBriefing(input.threadId, tot.row.briefed_at, prompt)
            : prompt,
        };
      }
      // The next heartbeat brings a newer briefing, so there's nothing here worth keeping.
      if (isHeartbeat) return { _tag: "skipped" as const };
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
    const unfinishedBatch = yield* sql<{ readonly batch_id: string; readonly batch_day: string }>`
      SELECT batch_id, batch_day FROM tot_held_wakes
      WHERE thread_id = ${threadId} AND released_at IS NULL AND batch_id IS NOT NULL
      LIMIT 1
    `;
    const unfinished = unfinishedBatch[0];
    const accepted =
      unfinished !== undefined &&
      (yield* threads.hasReceipt(CommandId.make(`tot-wake:${unfinished.batch_id}`)));
    // Fixing the batch before sending means a crash replays exactly these wakes, and any held
    // later wait for the next batch. A batch orchestration already accepted just finishes; one it
    // never saw is still a new wake, so it waits like one and uses the limit of the day it runs.
    const batchId = yield* sql.withTransaction(
      Effect.gen(function* () {
        if (unfinished !== undefined && accepted) return unfinished.batch_id;
        const tot = yield* readTot(threadId);
        // Turning the Tot back into a thread leaves no window to wait for.
        if (tot !== null && isWithinQuietHours(clock.minuteOfDay, tot.settings.quietHours)) {
          return null;
        }
        const first = yield* sql<{ readonly held_id: string }>`
          SELECT held_id FROM tot_held_wakes
          WHERE thread_id = ${threadId} AND released_at IS NULL
          ORDER BY held_at, held_id
          LIMIT 1
        `;
        if (first[0] === undefined) return null;
        const alreadyReserved = unfinished?.batch_day === clock.day;
        if (tot !== null && !alreadyReserved) {
          const reserved = yield* reserveWake(threadId, clock.day, tot.settings.dailyWakeLimit);
          if (!reserved) return null;
        }
        if (unfinished !== undefined) {
          yield* sql`
            UPDATE tot_held_wakes SET batch_day = ${clock.day}
            WHERE batch_id = ${unfinished.batch_id}
          `;
          return unfinished.batch_id;
        }
        yield* sql`
          UPDATE tot_held_wakes SET batch_id = ${first[0].held_id}, batch_day = ${clock.day}
          WHERE thread_id = ${threadId} AND released_at IS NULL
        `;
        return first[0].held_id;
      }),
    );
    if (batchId === null) return;
    const wakes = yield* sql<HeldWake>`
      SELECT * FROM tot_held_wakes WHERE batch_id = ${batchId} ORDER BY held_at, held_id
    `;
    const first = wakes[0];
    if (first === undefined) return;
    yield* threads.sendToThread({
      projectId: ProjectId.make(shell.projectId),
      commandId: CommandId.make(`tot-wake:${batchId}`),
      messageId: MessageId.make(`tot-wake-message:${batchId}`),
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
    // Kept without its prompt as a record, so a webhook retrying after a restart doesn't resend it.
    yield* sql`
      UPDATE tot_held_wakes SET released_at = ${clock.iso}, prompt = ''
      WHERE batch_id = ${batchId}
    `;
    yield* tots.notifyChanged;
  });

  const releaseDue: TotWakesShape["releaseDue"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const forgetBefore = DateTime.formatIso(
      DateTime.subtract(now, { days: FORGET_RELEASED_AFTER_DAYS }),
    );
    yield* sql`DELETE FROM tot_held_wakes WHERE released_at < ${forgetBefore}`;
    const held = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM tot_held_wakes WHERE released_at IS NULL
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
