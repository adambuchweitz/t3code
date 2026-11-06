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

  it.effect("keeps several requests open, and doesn't ask the same one twice", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const { tot } = yield* tots.adopt(brace);
      const first = yield* tots.askUser(threadId, {
        question: "Regions or arenas?",
        options: ["Regions", "Arenas"],
        recommendedOption: "Regions",
      });
      const second = yield* tots.askUser(threadId, { question: "Which license?" });
      assert.notStrictEqual(first, second);

      const same = yield* tots.askUser(threadId, {
        question: "Regions or arenas?",
        options: ["Regions"],
        recommendedOption: "Not an option",
      });
      assert.strictEqual(same, first);
      yield* tots.askUser(threadId, { requestId: second, question: "Which license, MIT or GPL?" });

      const requests = (yield* tots.list()).tots[0]?.requests ?? [];
      assert.deepStrictEqual(
        requests.map((request) => [request.question, request.recommendedOption]),
        [
          ["Regions or arenas?", null],
          ["Which license, MIT or GPL?", null],
        ],
      );

      const gone = yield* Effect.flip(
        tots.askUser(threadId, { requestId: "request-gone", question: "Hello?" }),
      );
      assert.include(gone.message, "isn't open");
      for (const index of [3, 4, 5, 6, 7, 8]) {
        yield* tots.askUser(threadId, { question: `Question ${index}?` });
      }
      const full = yield* Effect.flip(tots.askUser(threadId, { question: "One too many?" }));
      assert.include(full.message, "8 open requests");

      assert.isTrue(yield* tots.closeRequest(threadId, first));
      assert.isFalse(yield* tots.closeRequest(threadId, first));
      yield* tots.release({ id: tot.id });
    }),
  );

  it.effect("approving can use the user's edit instead of what the Tot wrote", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const { tot } = yield* tots.adopt({ ...brace, charter: "Old." });
      const proposed = yield* tots.proposeCharter(threadId, { charter: "New.", reason: "Why." });
      const { tot: approved } = yield* tots.answerCharterProposal({
        id: tot.id,
        proposalId: proposed.tot.charterProposal!.id,
        approve: true,
        charter: "New, edited.",
      });
      assert.strictEqual(approved.charter, "New, edited.");
      assert.strictEqual(approved.charterProposal, null);
      yield* tots.release({ id: tot.id });
    }),
  );

  it.effect("only starting a thread grants authority over it, not watching it", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const { tot } = yield* tots.adopt(brace);
      const watched = ThreadId.make("thread-watched");
      const launched = ThreadId.make("thread-launched");

      yield* tots.watchThread({ totThreadId: threadId, threadId: watched, reason: "requested" });
      yield* tots.watchThread({ totThreadId: threadId, threadId: launched, reason: "launched" });
      assert.isFalse(yield* tots.startedBy(threadId, watched));
      assert.isTrue(yield* tots.startedBy(threadId, launched));

      // Asking to watch a thread it started keeps its authority.
      yield* tots.watchThread({ totThreadId: threadId, threadId: launched, reason: "requested" });
      assert.isTrue(yield* tots.startedBy(threadId, launched));

      assert.deepStrictEqual(yield* tots.watchersOf(watched), [
        { totThreadId: threadId, via: "watch" },
      ]);
      const { tot: updated } = yield* tots.update({ id: tot.id, unwatchThreadIds: [watched] });
      assert.deepStrictEqual(updated.watchedThreadIds, [launched]);
      assert.deepStrictEqual(yield* tots.watchersOf(watched), []);

      yield* tots.release({ id: tot.id });
      assert.isFalse(yield* tots.startedBy(threadId, launched));
      assert.deepStrictEqual(yield* tots.watchersOf(launched), []);
    }),
  );

  it.effect("a thread that isn't a Tot can't watch or claim anything", () =>
    Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      const other = ThreadId.make("thread-other");
      assert.isFalse(
        yield* tots.watchThread({ totThreadId: threadId, threadId: other, reason: "launched" }),
      );
      assert.isFalse(yield* tots.startedBy(threadId, other));
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

const layerSending = (
  send: ThreadManagementService.ThreadManagementService["Service"]["sendToThread"],
) =>
  TotService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell()),
          sendToThread: send,
        }),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

it.effect.each([
  { answer: "Regions", text: 'My answer to your request "Regions or arenas?":\n\nRegions' },
  {
    answer: null,
    text: 'I dismissed your request "Regions or arenas?". Don\'t ask again unless something changes.',
  },
])("settling a request with $answer tells the Tot as the user", ({ answer, text }) => {
  const sent: Array<{ readonly text: string; readonly createdBy: string | undefined }> = [];
  return Effect.gen(function* () {
    const tots = yield* TotService.TotService;
    const { tot } = yield* tots.adopt(brace);
    const requestId = yield* tots.askUser(threadId, { question: "Regions or arenas?" });
    const settled = yield* tots.answerRequest({ id: tot.id, requestId, answer });
    assert.deepStrictEqual(settled.tot.requests, []);
    assert.deepStrictEqual(sent, [{ text, createdBy: "user" }]);
    const again = yield* Effect.flip(tots.answerRequest({ id: tot.id, requestId, answer }));
    assert.include(again.message, "already been settled");
  }).pipe(
    Effect.provide(
      layerSending((input) => {
        sent.push({ text: input.text, createdBy: input.createdBy });
        return Effect.succeed({ threadId } as never);
      }),
    ),
  );
});

it.effect("a request stays open when its answer can't be sent", () =>
  Effect.gen(function* () {
    const tots = yield* TotService.TotService;
    const { tot } = yield* tots.adopt(brace);
    const requestId = yield* tots.askUser(threadId, { question: "Regions or arenas?" });
    yield* Effect.flip(tots.answerRequest({ id: tot.id, requestId, answer: "Regions" }));
    assert.lengthOf((yield* tots.list()).tots[0]?.requests ?? [], 1);
  }).pipe(
    Effect.provide(
      layerSending(() =>
        Effect.fail(new ThreadManagementService.ThreadManagementThreadArchivedError({ threadId })),
      ),
    ),
  ),
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

      yield* sql`UPDATE tots SET proposed_charter = 'New', proposal_id = NULL`;
      yield* ensureTotsTable;
      const proposals = yield* sql<{ readonly proposal_id: string | null }>`
        SELECT proposal_id FROM tots
      `;
      assert.isNotNull(proposals[0]?.proposal_id);

      yield* sql`UPDATE tots SET talk_topic = 'Old topic', talk_asked_at = '2026-11-05T00:00:00.000Z'`;
      yield* ensureTotsTable;
      yield* ensureTotsTable;
      const carried = yield* sql<{ readonly question: string }>`SELECT question FROM tot_requests`;
      assert.deepStrictEqual(carried, [{ question: "Old topic" }]);
    }),
  );
});
