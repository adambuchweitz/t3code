import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TotService from "./TotService.ts";
import * as TotWakes from "./TotWakes.ts";
import { totHeartbeatTaskId } from "./totHeartbeat.ts";

const threadId = ThreadId.make("thread-lang");
const taskId = ScheduledTaskId.make("task-checkin");

const shell = {
  id: threadId,
  projectId: ProjectId.make("project-lang"),
  deletedAt: null,
  archivedAt: null,
  worktreePath: "/tmp/lang",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
} as unknown as OrchestrationV2ThreadShell;

const accepted = Ref.makeUnsafe<ReadonlySet<string>>(new Set());

const makeLayer = (input: {
  readonly sent: Ref.Ref<ReadonlyArray<string>>;
  readonly checkCode?: number;
  /** "accepted": orchestration took it, then a crash. "unseen": it never got there. */
  readonly failSends?: Ref.Ref<"none" | "accepted" | "unseen">;
  readonly activeRunId?: string | null;
}) =>
  TotWakes.layer.pipe(
    Layer.provideMerge(TotService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              ...shell,
              activeRunId: (input.activeRunId ?? null) as OrchestrationV2ThreadShell["activeRunId"],
            }),
          listProjectThreads: () =>
            Effect.succeed([
              {
                ...shell,
                id: ThreadId.make("thread-crew"),
                title: "Crew work",
                status: "completed",
                activeRunId: null,
                pendingRuntimeRequest: null,
                settledAt: null,
                updatedAt: DateTime.makeUnsafe("1970-01-01T00:00:00Z"),
              },
            ]),
          hasReceipt: (commandId) =>
            Ref.get(accepted).pipe(Effect.map((ids) => ids.has(commandId))),
          sendToThread: (send) =>
            Effect.gen(function* () {
              const failure =
                input.failSends === undefined ? "none" : yield* Ref.get(input.failSends);
              if (failure === "unseen") {
                return yield* Effect.fail({ _tag: "never reached orchestration" } as never);
              }
              yield* Ref.update(accepted, (ids) => new Set([...ids, send.commandId]));
              yield* Ref.update(input.sent, (sent) => [...sent, send.text]);
              if (failure === "accepted") {
                return yield* Effect.fail({ _tag: "crashed after sending" } as never);
              }
              return {} as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: () =>
            Effect.succeed({
              stdout: "",
              stderr: "",
              code: input.checkCode ?? 0,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            } as never),
        }),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const noMessages = () => Ref.makeUnsafe<ReadonlyArray<string>>([]);

const pad = (value: number) => String(value).padStart(2, "0");
const localMinute = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone).pipe(
  Effect.map((now) => {
    const parts = DateTime.toParts(now);
    return parts.hour * 60 + parts.minute;
  }),
);
const clockTime = (minute: number) => {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
};

const adopt = Effect.gen(function* () {
  const tots = yield* TotService.TotService;
  const { tot } = yield* tots.adopt({
    threadId,
    name: "Brace",
    nameEnabled: true,
    character: "brace",
    job: "manager",
  });
  return { tots, tot };
});

const wake = (heldId: string, prompt: string, runCheck = true) => ({
  threadId,
  heldId,
  scheduledTaskId: taskId,
  title: "Check-in",
  prompt,
  runCheck,
});

it.effect.each([
  { start: "23:00", end: "07:00", minute: 23 * 60, within: true },
  { start: "23:00", end: "07:00", minute: 6 * 60 + 59, within: true },
  { start: "23:00", end: "07:00", minute: 7 * 60, within: false },
  { start: "09:00", end: "17:00", minute: 12 * 60, within: true },
  { start: "09:00", end: "17:00", minute: 8 * 60, within: false },
  { start: "09:00", end: "09:00", minute: 9 * 60, within: false },
])("quiet hours from $start to $end at minute $minute", ({ start, end, minute, within }) =>
  Effect.sync(() =>
    assert.strictEqual(TotWakes.isWithinQuietHours(minute, { start, end }), within),
  ),
);

it.effect("a plain thread's wake just runs", () =>
  Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const decision = yield* wakes.admit(wake("a", "Check in"));
    assert.deepStrictEqual(decision, { _tag: "run", prompt: "Check in" });
  }).pipe(Effect.provide(makeLayer({ sent: noMessages() }))),
);

it.effect("quiet hours hold wakes, then one merged turn runs when they end", () => {
  const sent = Ref.makeUnsafe<ReadonlyArray<string>>([]);
  return Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tots, tot } = yield* adopt;
    const minute = yield* localMinute;
    yield* tots.update({
      id: tot.id,
      wakeSettings: {
        quietHours: { start: clockTime(minute), end: clockTime(minute + 60) },
        dailyWakeLimit: null,
        wakeChecks: [],
      },
    });

    assert.deepStrictEqual(yield* wakes.admit(wake("a", "First")), { _tag: "held" });
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* wakes.admit(wake("b", "Second")), { _tag: "held" });
    assert.deepStrictEqual(yield* Ref.get(sent), []);
    const listed = yield* tots.list();
    assert.strictEqual(listed.tots[0]?.wakesHeld, 2);

    yield* TestClock.adjust("2 hours");
    yield* wakes.releaseDue;
    const messages = yield* Ref.get(sent);
    assert.strictEqual(messages.length, 1);
    assert.include(messages[0]!, "held 2 times");
    assert.include(messages[0]!, "Second");
    assert.notInclude(messages[0]!, "First");
    assert.strictEqual((yield* tots.list()).tots[0]?.wakesHeld, 0);

    yield* wakes.releaseDue;
    assert.strictEqual((yield* Ref.get(sent)).length, 1);
  }).pipe(Effect.provide(makeLayer({ sent })));
});

it.effect("the daily limit holds extra wakes until the next day", () => {
  const sent = Ref.makeUnsafe<ReadonlyArray<string>>([]);
  return Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tots, tot } = yield* adopt;
    yield* tots.update({
      id: tot.id,
      wakeSettings: { quietHours: null, dailyWakeLimit: 1, wakeChecks: [] },
    });
    assert.deepStrictEqual(yield* wakes.admit(wake("a", "First")), {
      _tag: "run",
      prompt: "First",
    });
    assert.deepStrictEqual(yield* wakes.admit(wake("b", "Second")), { _tag: "held" });
    yield* wakes.releaseDue;
    assert.deepStrictEqual(yield* Ref.get(sent), []);
    yield* TestClock.adjust("25 hours");
    yield* wakes.releaseDue;
    assert.deepStrictEqual(yield* Ref.get(sent), ["Second"]);
  }).pipe(Effect.provide(makeLayer({ sent })));
});

it.effect("turning the Tot back into a thread releases what it was holding", () => {
  const sent = Ref.makeUnsafe<ReadonlyArray<string>>([]);
  return Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tots, tot } = yield* adopt;
    yield* tots.update({
      id: tot.id,
      wakeSettings: { quietHours: null, dailyWakeLimit: 1, wakeChecks: [] },
    });
    yield* wakes.admit(wake("a", "First"));
    yield* wakes.admit(wake("b", "Second"));
    yield* tots.release({ id: tot.id });
    yield* wakes.releaseDue;
    assert.deepStrictEqual(yield* Ref.get(sent), ["Second"]);
  }).pipe(Effect.provide(makeLayer({ sent })));
});

it.effect.each([
  { code: 0, expected: { _tag: "run", prompt: "Check in" } },
  { code: 1, expected: { _tag: "skipped" } },
] as const)("a check exiting $code decides the wake", ({ code, expected }) =>
  Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tots, tot } = yield* adopt;
    yield* tots.update({
      id: tot.id,
      wakeSettings: {
        quietHours: null,
        dailyWakeLimit: null,
        wakeChecks: [{ scheduledTaskId: taskId, command: "git diff --quiet" }],
      },
    });
    assert.deepStrictEqual(yield* wakes.admit(wake("a", "Check in")), expected);
  }).pipe(Effect.provide(makeLayer({ sent: noMessages(), checkCode: code }))),
);

it.effect("a check that can't decide still wakes the Tot and says so, and webhooks skip it", () =>
  Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tots, tot } = yield* adopt;
    yield* tots.update({
      id: tot.id,
      wakeSettings: {
        quietHours: null,
        dailyWakeLimit: null,
        wakeChecks: [{ scheduledTaskId: taskId, command: "broken" }],
      },
    });
    const decision = yield* wakes.admit(wake("a", "Check in"));
    assert.strictEqual(decision._tag, "run");
    assert.include(decision._tag === "run" ? decision.prompt : "", "exited with code 127");
    assert.deepStrictEqual(yield* wakes.admit(wake("b", "From a webhook", false)), {
      _tag: "run",
      prompt: "From a webhook",
    });
  }).pipe(Effect.provide(makeLayer({ sent: noMessages(), checkCode: 127 }))),
);

it.effect(
  "a release that crashed replays only its own wakes, and later ones wait their turn",
  () => {
    const sent = noMessages();
    const failSends = Ref.makeUnsafe<"none" | "accepted" | "unseen">("accepted");
    return Effect.gen(function* () {
      const wakes = yield* TotWakes.TotWakes;
      const { tots, tot } = yield* adopt;
      const quietFromNow = Effect.gen(function* () {
        const minute = yield* localMinute;
        yield* tots.update({
          id: tot.id,
          wakeSettings: {
            quietHours: { start: clockTime(minute), end: clockTime(minute + 60) },
            dailyWakeLimit: null,
            wakeChecks: [],
          },
        });
      });
      yield* quietFromNow;
      yield* wakes.admit(wake("a", "First"));
      yield* TestClock.adjust("2 hours");
      assert.deepStrictEqual([...new Set(yield* Ref.get(sent))], ["First"]);

      yield* quietFromNow;
      yield* wakes.admit(wake("b", "Second"));
      yield* Ref.set(failSends, "none");
      yield* wakes.releaseDue;
      assert.deepStrictEqual([...new Set(yield* Ref.get(sent))], ["First"]);
      assert.strictEqual((yield* tots.list()).tots[0]?.wakesHeld, 1);

      yield* TestClock.adjust("2 hours");
      assert.deepStrictEqual((yield* Ref.get(sent)).at(-1), "Second");
      assert.strictEqual((yield* tots.list()).tots[0]?.wakesHeld, 0);
    }).pipe(Effect.provide(makeLayer({ sent, failSends })));
  },
);

it.effect("a webhook retrying after a restart doesn't resend a wake it already held", () => {
  const sent = noMessages();
  return Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tots, tot } = yield* adopt;
    yield* tots.update({
      id: tot.id,
      wakeSettings: { quietHours: null, dailyWakeLimit: 1, wakeChecks: [] },
    });
    yield* wakes.admit(wake("a", "Uses the limit", false));
    assert.deepStrictEqual(yield* wakes.admit(wake("delivery", "Webhook", false)), {
      _tag: "held",
    });
    yield* TestClock.adjust("25 hours");
    assert.deepStrictEqual(yield* wakes.admit(wake("delivery", "Webhook", false)), {
      _tag: "held",
    });
    yield* wakes.releaseDue;
    assert.deepStrictEqual(yield* Ref.get(sent), ["Webhook"]);
    assert.deepStrictEqual(yield* wakes.admit(wake("delivery", "Webhook", false)), {
      _tag: "held",
    });
    yield* wakes.releaseDue;
    assert.deepStrictEqual(yield* Ref.get(sent), ["Webhook"]);
  }).pipe(Effect.provide(makeLayer({ sent })));
});

it.effect(
  "a batch that never reached orchestration still obeys the limit of the day it runs",
  () => {
    const sent = noMessages();
    const failSends = Ref.makeUnsafe<"none" | "accepted" | "unseen">("unseen");
    return Effect.gen(function* () {
      yield* Ref.set(accepted, new Set());
      const wakes = yield* TotWakes.TotWakes;
      const { tots, tot } = yield* adopt;
      yield* tots.update({
        id: tot.id,
        wakeSettings: { quietHours: null, dailyWakeLimit: 1, wakeChecks: [] },
      });
      yield* wakes.admit(wake("a", "Uses today"));
      yield* wakes.admit(wake("b", "Held"));
      yield* TestClock.adjust("25 hours");
      assert.deepStrictEqual(yield* Ref.get(sent), []);
      assert.strictEqual((yield* tots.list()).tots[0]?.wakesHeld, 1);

      // The retry already took today's one wake, so a new wake has to wait, and the retry
      // doesn't pay twice when it finally goes through.
      assert.deepStrictEqual(yield* wakes.admit(wake("c", "Waits a day")), { _tag: "held" });
      yield* Ref.set(failSends, "none");
      yield* wakes.releaseDue;
      assert.deepStrictEqual(yield* Ref.get(sent), ["Held"]);
      yield* wakes.releaseDue;
      assert.deepStrictEqual(yield* Ref.get(sent), ["Held"]);

      yield* TestClock.adjust("24 hours");
      assert.deepStrictEqual(yield* Ref.get(sent), ["Held", "Waits a day"]);
    }).pipe(Effect.provide(makeLayer({ sent, failSends })));
  },
);

const heartbeat = (totId: string, heldId: string, manual = false) => ({
  threadId,
  heldId,
  scheduledTaskId: totHeartbeatTaskId(totId),
  title: "Heartbeat",
  prompt: "Beat",
  runCheck: true,
  manual,
});

it.effect("a heartbeat lists all open threads the first time, then only what changed", () =>
  Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tot } = yield* adopt;
    const first = yield* wakes.admit(heartbeat(tot.id, "a"));
    assert.strictEqual(first._tag, "run");
    assert.include(first._tag === "run" ? first.prompt : "", "Crew work");

    yield* TestClock.adjust("1 hour");
    const second = yield* wakes.admit(heartbeat(tot.id, "b"));
    assert.include(second._tag === "run" ? second.prompt : "", "No thread has changed.");
  }).pipe(Effect.provide(makeLayer({ sent: noMessages() }))),
);

it.effect("other schedules on a Tot aren't given a briefing", () =>
  Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    yield* adopt;
    assert.deepStrictEqual(yield* wakes.admit(wake("a", "Check in")), {
      _tag: "run",
      prompt: "Check in",
    });
  }).pipe(Effect.provide(makeLayer({ sent: noMessages() }))),
);

it.effect("a heartbeat is skipped while the Tot is busy, unless the user runs it", () =>
  Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tot } = yield* adopt;
    assert.deepStrictEqual(yield* wakes.admit(heartbeat(tot.id, "a")), { _tag: "skipped" });
    const manual = yield* wakes.admit(heartbeat(tot.id, "b", true));
    assert.include(manual._tag === "run" ? manual.prompt : "", "Crew work");
  }).pipe(Effect.provide(makeLayer({ sent: noMessages(), activeRunId: "run-1" }))),
);

it.effect("a heartbeat in quiet hours is dropped rather than held", () =>
  Effect.gen(function* () {
    const wakes = yield* TotWakes.TotWakes;
    const { tots, tot } = yield* adopt;
    const minute = yield* localMinute;
    yield* tots.update({
      id: tot.id,
      wakeSettings: {
        quietHours: { start: clockTime(minute), end: clockTime(minute + 60) },
        dailyWakeLimit: null,
        wakeChecks: [],
      },
    });
    assert.deepStrictEqual(yield* wakes.admit(heartbeat(tot.id, "a")), { _tag: "skipped" });
    const { tots: listed } = yield* tots.list();
    assert.strictEqual(listed[0]?.wakesHeld, 0);
  }).pipe(Effect.provide(makeLayer({ sent: noMessages() }))),
);
