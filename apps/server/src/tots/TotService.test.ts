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
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TotService from "./TotService.ts";
import { ensureTotsTable } from "./totsTable.ts";

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

  it.effect("a proposal waits for approval, and only the one on screen can be approved", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const { tot } = yield* tots.adopt({ ...brace, charter: "Old rules." });
      assert.strictEqual(tot.voice, "toddler");

      const first = yield* tots.proposeCharter(threadId, { charter: "First.", reason: "Why one." });
      assert.strictEqual(first.tot.charter, "Old rules.");
      const firstId = first.tot.charterProposal!.id;

      const second = yield* tots.proposeCharter(threadId, {
        charter: "Second.",
        reason: "Why two.",
      });
      const stale = yield* Effect.flip(
        tots.answerCharterProposal({ id: tot.id, proposalId: firstId, approve: true }),
      );
      assert.isTrue(isTotError(stale));

      const approved = yield* tots.answerCharterProposal({
        id: tot.id,
        proposalId: second.tot.charterProposal!.id,
        approve: true,
      });
      assert.strictEqual(approved.tot.charter, "Second.");
      assert.isNull(approved.tot.charterProposal);

      yield* tots.release({ id: tot.id });
    }),
  );

  it.effect("dismissing keeps the charter, and editing it clears a stale proposal", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const { tot } = yield* tots.adopt({ ...brace, charter: "Old rules." });

      const proposed = yield* tots.proposeCharter(threadId, { charter: "New.", reason: "Why." });
      const dismissed = yield* tots.answerCharterProposal({
        id: tot.id,
        proposalId: proposed.tot.charterProposal!.id,
        approve: false,
      });
      assert.strictEqual(dismissed.tot.charter, "Old rules.");
      assert.isNull(dismissed.tot.charterProposal);

      yield* tots.proposeCharter(threadId, { charter: "New.", reason: "Why." });
      const unchanged = yield* tots.update({ id: tot.id, charter: "Old rules.", voice: "polite" });
      assert.isNotNull(unchanged.tot.charterProposal);
      assert.strictEqual(unchanged.tot.voice, "polite");
      const edited = yield* tots.update({ id: tot.id, charter: "Mine." });
      assert.strictEqual(edited.tot.charter, "Mine.");
      assert.isNull(edited.tot.charterProposal);

      yield* tots.release({ id: tot.id });
    }),
  );

  it.effect("refuses a proposal from a thread that isn't a Tot", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const failure = yield* Effect.flip(
        tots.proposeCharter(ThreadId.make("plain"), { charter: "New.", reason: "Why." }),
      );
      assert.isTrue(isTotError(failure));
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

it.layer(SqlitePersistence.layerMemory)("Tots table", (it) => {
  it.effect("adds the charter columns to a table from the first slice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE tots (
          tot_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          name_enabled INTEGER NOT NULL, character_id TEXT NOT NULL, job TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO tots VALUES ('tot:1', 'thread-1', 'Brace', 1, 'brace', 'manager', 'a', 'a')
      `;
      yield* ensureTotsTable;
      yield* ensureTotsTable;
      const rows = yield* sql<{ readonly charter: string; readonly voice: string }>`
        SELECT charter, voice FROM tots
      `;
      assert.deepStrictEqual(rows, [{ charter: "", voice: "toddler" }]);
    }),
  );
});
