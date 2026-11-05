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

const makeLayer = (input: {
  readonly sent: Ref.Ref<ReadonlyArray<string>>;
  readonly checkCode?: number;
}) =>
  TotWakes.layer.pipe(
    Layer.provideMerge(TotService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          sendToThread: (send) =>
            Ref.update(input.sent, (sent) => [...sent, send.text]).pipe(Effect.as({} as never)),
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
