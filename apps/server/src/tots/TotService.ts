import {
  isListedThreadLineage,
  Tot,
  TotError,
  TotId,
  type ProjectId,
  type TotAdoptInput,
  type TotAnswerCharterProposalInput,
  type TotListResult,
  type TotMutationResult,
  type TotProposeCharterInput,
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
import { ensureTotsTable } from "./totsTable.ts";

interface TotRow {
  readonly tot_id: string;
  readonly thread_id: string;
  readonly name: string;
  readonly name_enabled: number;
  readonly character_id: string;
  readonly job: string;
  readonly charter: string;
  readonly voice: string;
  readonly proposed_charter: string | null;
  readonly proposal_reason: string | null;
  readonly proposed_at: string | null;
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
    charter: row.charter,
    voice: row.voice,
    charterProposal:
      row.proposed_charter === null
        ? null
        : {
            charter: row.proposed_charter,
            reason: row.proposal_reason,
            proposedAt: row.proposed_at,
          },
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
    readonly proposeCharter: (
      threadId: ThreadId,
      input: TotProposeCharterInput,
    ) => Effect.Effect<TotMutationResult, TotError>;
    readonly answerCharterProposal: (
      input: TotAnswerCharterProposalInput,
    ) => Effect.Effect<TotMutationResult, TotError>;
  }
>()("t3/tots/TotService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureTotsTable;
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
        tot_id, thread_id, name, name_enabled, character_id, job, charter, voice,
        created_at, updated_at
      ) VALUES (
        ${id}, ${input.threadId}, ${input.name}, ${input.nameEnabled ? 1 : 0},
        ${input.character}, ${input.job}, ${input.charter ?? ""}, ${input.voice ?? "toddler"},
        ${createdAt}, ${createdAt}
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

  const mutated = Effect.fnUntraced(function* (row: TotRow | undefined, missing: string) {
    if (row === undefined) return yield* new TotError({ message: missing });
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

  const update: TotService["Service"]["update"] = Effect.fn("TotService.update")(function* (input) {
    const updatedAt = yield* now;
    const charter = input.charter ?? null;
    // Editing the charter settles a pending proposal, which was written against the old text.
    const keepsProposal = sql`(${charter} IS NULL OR ${charter} = charter)`;
    const rows = yield* sql<TotRow>`
        UPDATE tots SET
          name = COALESCE(${input.name ?? null}, name),
          name_enabled = COALESCE(
            ${input.nameEnabled === undefined ? null : input.nameEnabled ? 1 : 0},
            name_enabled
          ),
          character_id = COALESCE(${input.character ?? null}, character_id),
          job = COALESCE(${input.job ?? null}, job),
          voice = COALESCE(${input.voice ?? null}, voice),
          charter = COALESCE(${charter}, charter),
          proposed_charter = CASE WHEN ${keepsProposal} THEN proposed_charter END,
          proposal_reason = CASE WHEN ${keepsProposal} THEN proposal_reason END,
          proposed_at = CASE WHEN ${keepsProposal} THEN proposed_at END,
          updated_at = ${updatedAt}
        WHERE tot_id = ${input.id}
        RETURNING *
      `.pipe(Effect.mapError(storageError("Could not save the Tot.")));
    return yield* mutated(rows[0], "That Tot no longer exists.");
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

  const proposeCharter: TotService["Service"]["proposeCharter"] = Effect.fn(
    "TotService.proposeCharter",
  )(function* (threadId, input) {
    const proposedAt = yield* now;
    const rows = yield* sql<TotRow>`
      UPDATE tots SET
        proposed_charter = ${input.charter},
        proposal_reason = ${input.reason},
        proposed_at = ${proposedAt},
        updated_at = ${proposedAt}
      WHERE thread_id = ${threadId}
      RETURNING *
    `.pipe(Effect.mapError(storageError("Could not save the proposal.")));
    return yield* mutated(rows[0], "Only a Tot's own thread can propose a charter.");
  });

  const answerCharterProposal: TotService["Service"]["answerCharterProposal"] = Effect.fn(
    "TotService.answerCharterProposal",
  )(function* (input) {
    const updatedAt = yield* now;
    const rows = yield* sql<TotRow>`
      UPDATE tots SET
        charter = CASE WHEN ${input.approve ? 1 : 0} = 1 THEN proposed_charter ELSE charter END,
        proposed_charter = NULL,
        proposal_reason = NULL,
        proposed_at = NULL,
        updated_at = ${updatedAt}
      WHERE tot_id = ${input.id} AND proposed_at = ${input.proposedAt}
      RETURNING *
    `.pipe(Effect.mapError(storageError("Could not save your answer.")));
    return yield* mutated(rows[0], "That proposal has changed. Check the newest one.");
  });

  return TotService.of({
    list,
    subscribeList,
    adopt,
    update,
    release,
    deleteForThread,
    proposeCharter,
    answerCharterProposal,
  });
});

export const layer = Layer.effect(TotService, make);
