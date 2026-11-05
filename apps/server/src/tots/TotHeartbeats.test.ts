import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TotHeartbeats from "./TotHeartbeats.ts";
import * as TotService from "./TotService.ts";
import { totHeartbeatTaskId } from "./totHeartbeat.ts";

const threadId = ThreadId.make("thread-lang");
const shell = {
  id: threadId,
  projectId: ProjectId.make("project-lang"),
  deletedAt: null,
  archivedAt: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  modelSelection: { instanceId: "claude", model: "haiku" },
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
} as unknown as OrchestrationV2ThreadShell;

interface Stored {
  readonly id: ScheduledTaskId;
  readonly enabled: boolean;
}

const makeLayer = (stored: Ref.Ref<ReadonlyArray<Stored>>) =>
  TotHeartbeats.layer.pipe(
    Layer.provideMerge(TotService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () =>
            Ref.get(stored).pipe(
              Effect.map((tasks) => ({ tasks: tasks as unknown as ReadonlyArray<ScheduledTask> })),
            ),
          upsert: (input) =>
            Ref.update(stored, (tasks) => [
              ...tasks.filter((task) => task.id !== input.id),
              { id: input.id!, enabled: input.enabled },
            ]).pipe(Effect.as({} as never)),
          delete: (input) =>
            Ref.update(stored, (tasks) => tasks.filter((task) => task.id !== input.id)).pipe(
              Effect.as({} as never),
            ),
        }),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const settle = TestClock.adjust("1 second");

const brace = {
  threadId,
  name: "Brace",
  nameEnabled: true,
  character: "brace",
  job: "manager",
} as const;

it.effect("a new Tot gets one running heartbeat, and turning it back removes it", () => {
  const stored = Ref.makeUnsafe<ReadonlyArray<Stored>>([]);
  return Effect.gen(function* () {
    const tots = yield* TotService.TotService;
    const { tot } = yield* tots.adopt(brace);
    yield* settle;
    assert.deepStrictEqual(yield* Ref.get(stored), [
      { id: totHeartbeatTaskId(tot.id), enabled: true },
    ]);

    yield* tots.update({ id: tot.id, name: "Bracer" });
    yield* settle;
    assert.strictEqual((yield* Ref.get(stored)).length, 1);

    yield* tots.release({ id: tot.id });
    yield* settle;
    assert.deepStrictEqual(yield* Ref.get(stored), []);
  }).pipe(Effect.provide(makeLayer(stored)));
});

it.effect("a heartbeat the user deleted comes back paused", () => {
  const stored = Ref.makeUnsafe<ReadonlyArray<Stored>>([]);
  return Effect.gen(function* () {
    const tots = yield* TotService.TotService;
    const { tot } = yield* tots.adopt(brace);
    yield* settle;
    yield* Ref.set(stored, []);

    yield* tots.update({ id: tot.id, name: "Bracer" });
    yield* settle;
    assert.deepStrictEqual(yield* Ref.get(stored), [
      { id: totHeartbeatTaskId(tot.id), enabled: false },
    ]);
  }).pipe(Effect.provide(makeLayer(stored)));
});

it.effect("gives existing Tots a heartbeat when the server starts", () => {
  const stored = Ref.makeUnsafe<ReadonlyArray<Stored>>([]);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tots = yield* TotService.TotService;
    const { tot } = yield* tots.adopt(brace);
    yield* settle;
    yield* sql`UPDATE tots SET heartbeat_created = 0`;
    yield* Ref.set(stored, []);
    yield* tots.notifyChanged;
    yield* settle;
    assert.deepStrictEqual(yield* Ref.get(stored), [
      { id: totHeartbeatTaskId(tot.id), enabled: true },
    ]);
  }).pipe(Effect.provide(makeLayer(stored)));
});
