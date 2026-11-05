import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  TotError,
  TotId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TotService from "./TotService.ts";

const isTotError = Schema.is(TotError);

const threadId = ThreadId.make("thread-lang");

const shell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: threadId,
    projectId: ProjectId.make("project-lang"),
    deletedAt: null,
    archivedAt: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const layerWith = (found: OrchestrationV2ThreadShell | null) =>
  TotService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(found),
        }),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const brace = {
  threadId,
  name: "Brace",
  nameEnabled: true,
  character: "brace",
  job: "manager",
} as const;

it.layer(layerWith(shell()))("TotService", (it) => {
  it.effect("adopts a thread once, then edits and releases it", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;

      const { tot } = yield* tots.adopt(brace);
      assert.strictEqual(tot.threadId, threadId);
      assert.strictEqual(tot.projectId, "project-lang");
      assert.strictEqual(tot.nameEnabled, true);

      const duplicate = yield* Effect.flip(tots.adopt({ ...brace, name: "Other" }));
      assert.isTrue(isTotError(duplicate));
      assert.strictEqual(duplicate.message, "That thread is already a Tot.");

      // Turning the name off keeps it, so turning it back on restores it.
      const { tot: nameless } = yield* tots.update({ id: tot.id, nameEnabled: false });
      assert.strictEqual(nameless.nameEnabled, false);
      assert.strictEqual(nameless.name, "Brace");
      assert.strictEqual(nameless.character, "brace");

      const { tot: renamed } = yield* tots.update({
        id: tot.id,
        name: "Curly",
        nameEnabled: true,
        job: "hands_on",
      });
      assert.deepStrictEqual(
        [renamed.name, renamed.nameEnabled, renamed.job],
        ["Curly", true, "hands_on"],
      );

      yield* tots.release({ id: tot.id });
      assert.deepStrictEqual((yield* tots.list()).tots, []);

      // A released thread can be adopted again.
      const { tot: again } = yield* tots.adopt(brace);
      yield* tots.release({ id: again.id });
    }),
  );

  it.effect("refuses to update a Tot that is gone", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const error = yield* Effect.flip(tots.update({ id: TotId.make("tot:gone"), name: "Nope" }));
      assert.strictEqual(error.message, "That Tot no longer exists.");
    }),
  );

  it.effect("removes the Tot when its thread is deleted, and tells subscribers", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const { tot } = yield* tots.adopt(brace);

      const subscribed = yield* Deferred.make<void>();
      const fiber = yield* tots.subscribeList().pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* tots.deleteForThread(threadId);
      const emitted = Array.from(yield* Fiber.join(fiber));

      assert.deepStrictEqual(
        emitted.map((result) => result.tots.map((entry) => entry.id)),
        [[tot.id], []],
      );
    }),
  );
});

it.effect.each([
  { title: "a missing thread", found: null, message: "That thread no longer exists." },
  {
    title: "a deleted thread",
    found: shell({ deletedAt: "2026-11-04T00:00:00.000Z" as never }),
    message: "That thread no longer exists.",
  },
  {
    title: "an archived thread",
    found: shell({ archivedAt: "2026-11-04T00:00:00.000Z" as never }),
    message: "Unarchive the thread before making it a Tot.",
  },
  {
    title: "a subagent",
    found: shell({
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent",
        rootThreadId: ThreadId.make("parent"),
      },
    }),
    message: "Subagents and side chats can't become Tots.",
  },
])("refuses to adopt $title", ({ found, message }) =>
  Effect.gen(function* () {
    const tots = yield* TotService.TotService;
    const error = yield* Effect.flip(tots.adopt(brace));
    assert.strictEqual(error.message, message);
    assert.deepStrictEqual((yield* tots.list()).tots, []);
  }).pipe(Effect.provide(layerWith(found))),
);
