import {
  isListedThreadLineage,
  Tot,
  TotError,
  TotId,
  type ProjectId,
  type TotAdoptInput,
  type TotListResult,
  type TotMutationResult,
  type TotReleaseInput,
  type TotReleaseResult,
  type TotUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

interface TotRow {
  readonly tot_id: string;
  readonly thread_id: string;
  readonly name: string;
  readonly name_enabled: number;
  readonly character_id: string;
  readonly job: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeTot = Schema.decodeUnknownEffect(Tot);

const totFromRow = (row: TotRow, projectId: ProjectId) =>
  decodeTot({
    id: row.tot_id,
    threadId: row.thread_id,
    projectId,
    name: row.name,
    nameEnabled: row.name_enabled !== 0,
    character: row.character_id,
    job: row.job,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }).pipe(
    Effect.mapError(
      (cause) => new TotError({ message: `Could not read Tot ${row.tot_id}.`, cause }),
    ),
  );

const storageError = (message: string) => (cause: unknown) => new TotError({ message, cause });

export class TotService extends Context.Service<
  TotService,
  {
    readonly list: () => Effect.Effect<TotListResult, TotError>;
    readonly subscribeList: () => Stream.Stream<TotListResult, TotError>;
    readonly adopt: (input: TotAdoptInput) => Effect.Effect<TotMutationResult, TotError>;
    readonly update: (input: TotUpdateInput) => Effect.Effect<TotMutationResult, TotError>;
    readonly release: (input: TotReleaseInput) => Effect.Effect<TotReleaseResult, TotError>;
    readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<void, TotError>;
  }
>()("t3/tots/TotService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  // Each change re-emits the whole list, so slow subscribers need only the newest signal.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const list: TotService["Service"]["list"] = Effect.fn("TotService.list")(function* () {
    const rows = yield* sql<TotRow>`SELECT * FROM tots ORDER BY created_at, tot_id`.pipe(
      Effect.mapError(storageError("Could not list Tots.")),
    );
    const tots = yield* Effect.forEach(rows, (row) =>
      threads.getThreadShell(ThreadId.make(row.thread_id)).pipe(
        Effect.mapError(storageError("Could not read a Tot's thread.")),
        Effect.flatMap((shell) =>
          shell === null || shell.deletedAt !== null
            ? Effect.succeed(null)
            : totFromRow(row, shell.projectId),
        ),
      ),
    );
    return { tots: tots.filter((tot) => tot !== null) };
  });

  const subscribeList: TotService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the read still arrives.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  const adopt: TotService["Service"]["adopt"] = Effect.fn("TotService.adopt")(function* (input) {
    const shell = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(storageError("Could not read that thread.")));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new TotError({ message: "That thread no longer exists." });
    }
    if (shell.archivedAt !== null) {
      return yield* new TotError({ message: "Unarchive the thread before making it a Tot." });
    }
    if (!isListedThreadLineage(shell.lineage)) {
      return yield* new TotError({ message: "Subagents and side chats can't become Tots." });
    }
    const uuid = yield* random
      .uuidV4()
      .pipe(Effect.mapError(storageError("Could not create the Tot.")));
    const id = TotId.make(`tot:${uuid}`);
    const createdAt = yield* now;
    const rows = yield* sql<TotRow>`
      INSERT INTO tots (
        tot_id, thread_id, name, name_enabled, character_id, job, created_at, updated_at
      ) VALUES (
        ${id}, ${input.threadId}, ${input.name}, ${input.nameEnabled ? 1 : 0},
        ${input.character}, ${input.job}, ${createdAt}, ${createdAt}
      )
      ON CONFLICT (thread_id) DO NOTHING
      RETURNING *
    `.pipe(Effect.mapError(storageError("Could not save the Tot.")));
    const row = rows[0];
    if (row === undefined) {
      return yield* new TotError({ message: "That thread is already a Tot." });
    }
    const tot = yield* totFromRow(row, shell.projectId);
    yield* notifyChanged;
    return { tot };
  });

  const update: TotService["Service"]["update"] = Effect.fn("TotService.update")(function* (input) {
    const updatedAt = yield* now;
    const rows = yield* sql<TotRow>`
        UPDATE tots SET
          name = COALESCE(${input.name ?? null}, name),
          name_enabled = COALESCE(
            ${input.nameEnabled === undefined ? null : input.nameEnabled ? 1 : 0},
            name_enabled
          ),
          character_id = COALESCE(${input.character ?? null}, character_id),
          job = COALESCE(${input.job ?? null}, job),
          updated_at = ${updatedAt}
        WHERE tot_id = ${input.id}
        RETURNING *
      `.pipe(Effect.mapError(storageError("Could not save the Tot.")));
    const row = rows[0];
    if (row === undefined) {
      return yield* new TotError({ message: "That Tot no longer exists." });
    }
    const shell = yield* threads
      .getThreadShell(ThreadId.make(row.thread_id))
      .pipe(Effect.mapError(storageError("Could not read the Tot's thread.")));
    if (shell === null) {
      return yield* new TotError({ message: "That Tot's thread no longer exists." });
    }
    const tot = yield* totFromRow(row, shell.projectId);
    yield* notifyChanged;
    return { tot };
  });

  const release: TotService["Service"]["release"] = Effect.fn("TotService.release")(
    function* (input) {
      yield* sql`DELETE FROM tots WHERE tot_id = ${input.id}`.pipe(
        Effect.mapError(storageError("Could not turn the Tot back into a thread.")),
      );
      yield* notifyChanged;
      return { id: input.id };
    },
  );

  const deleteForThread: TotService["Service"]["deleteForThread"] = Effect.fn(
    "TotService.deleteForThread",
  )(function* (threadId) {
    yield* sql`DELETE FROM tots WHERE thread_id = ${threadId}`.pipe(
      Effect.mapError(storageError("Could not remove the deleted thread's Tot.")),
    );
    yield* notifyChanged;
  });

  return TotService.of({ list, subscribeList, adopt, update, release, deleteForThread });
});

export const layer = Layer.effect(TotService, make);
