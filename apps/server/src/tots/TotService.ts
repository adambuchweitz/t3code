import {
  isListedThreadLineage,
  Tot,
  TotCrewModel,
  TotError,
  TotRequest,
  TOT_MAX_OPEN_REQUESTS,
  MessageId,
  TotWakeSettings,
  TotId,
  type ProjectId,
  type TotAdoptInput,
  type TotAnswerCharterProposalInput,
  type TotListResult,
  type TotMutationResult,
  CommandId,
  ProviderRequestKind,
  type ProviderApprovalDecision,
  type TotAnswerRequestInput,
  type TotAskUserInput,
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
  readonly proposal_id: string | null;
  readonly proposed_charter: string | null;
  readonly proposal_reason: string | null;
  readonly proposed_at: string | null;
  readonly wake_settings: string;
  readonly crew_models: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const MAX_ANCESTORS = 32;
const isApprovalKind = Schema.is(ProviderRequestKind);

const decodeTot = Schema.decodeUnknownEffect(Tot);
const WakeSettingsJson = Schema.fromJsonString(TotWakeSettings);
const CrewModelsJson = Schema.fromJsonString(Schema.Array(TotCrewModel));
const decodeTotJson = Schema.decodeUnknownEffect(
  Schema.Struct({ wakeSettings: WakeSettingsJson, crewModels: CrewModelsJson }),
);
const encodeWakeSettings = Schema.encodeEffect(WakeSettingsJson);
const encodeCrewModels = Schema.encodeEffect(CrewModelsJson);

interface TotRequestRow {
  readonly request_id: string;
  readonly tot_thread_id: string;
  readonly question: string;
  readonly summary: string;
  readonly details: string;
  readonly options: string;
  readonly recommended_option: string | null;
  readonly blocks: string | null;
  readonly asked_at: string;
  readonly updated_at: string;
}

const encodeRequestOptions = Schema.encodeEffect(Schema.fromJsonString(TotRequest.fields.options));
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...TotRequest.fields,
    options: Schema.fromJsonString(TotRequest.fields.options),
  }),
);

const requestFromRow = (row: TotRequestRow) =>
  decodeRequest({
    id: row.request_id,
    question: row.question,
    summary: row.summary,
    details: row.details,
    options: row.options,
    recommendedOption: row.recommended_option,
    blocks: row.blocks,
    askedAt: row.asked_at,
    updatedAt: row.updated_at,
  });

const formatRequestAnswer = (question: string, answer: string | null) =>
  answer === null
    ? `I dismissed your request ${JSON.stringify(question)}. Don't ask again unless something changes.`
    : `My answer to your request ${JSON.stringify(question)}:\n\n${answer}`;

const totFromRow = (
  row: TotRow,
  projectId: ProjectId,
  wakesHeld: number,
  watchedThreadIds: ReadonlyArray<string>,
  requests: ReadonlyArray<TotRequest>,
) =>
  decodeTotJson({ wakeSettings: row.wake_settings, crewModels: row.crew_models }).pipe(
    Effect.flatMap((json) =>
      decodeTot({
        ...json,
        wakesHeld,
        watchedThreadIds,
        requests,
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
                id: row.proposal_id,
                charter: row.proposed_charter,
                reason: row.proposal_reason,
                proposedAt: row.proposed_at,
              },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    ),
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
    /** Never downgrades: a thread the Tot started stays started if it also asks to watch it. */
    readonly watchThread: (input: {
      readonly totThreadId: ThreadId;
      readonly threadId: ThreadId;
      readonly reason: "launched" | "requested";
    }) => Effect.Effect<boolean, TotError>;
    readonly unwatchThread: (input: {
      readonly totThreadId: ThreadId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<boolean, TotError>;
    readonly listWatches: (
      totThreadId: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly reason: "launched" | "requested" }>,
      TotError
    >;
    /** Tots to wake for a thread. `crew` means a subagent, whose results already reach its parent. */
    readonly watchersOf: (
      threadId: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly totThreadId: ThreadId; readonly via: "watch" | "crew" }>,
      TotError
    >;
    /** Whether this Tot launched the thread, or the thread is a subagent somewhere below it. */
    readonly startedBy: (
      totThreadId: ThreadId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, TotError>;
    readonly listCrewApprovals: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<string>, TotError>;
    readonly readCrewApproval: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<
      {
        readonly requestKind: string;
        readonly prompt: string | null;
        readonly appName: string | null;
      },
      TotError
    >;
    readonly answerCrewApproval: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly decision: ProviderApprovalDecision;
    }) => Effect.Effect<void, TotError>;
    /** Replaces the open request with the same id or question, rather than asking twice. */
    readonly askUser: (
      threadId: ThreadId,
      input: TotAskUserInput,
    ) => Effect.Effect<string, TotError>;
    /** False when the request was already settled, which is what the caller wanted anyway. */
    readonly closeRequest: (
      threadId: ThreadId,
      requestId: string,
    ) => Effect.Effect<boolean, TotError>;
    /** Sends the answer as the user's message, which wakes the Tot. */
    readonly answerRequest: (
      input: TotAnswerRequestInput,
    ) => Effect.Effect<TotMutationResult, TotError>;
    readonly answerCharterProposal: (
      input: TotAnswerCharterProposalInput,
    ) => Effect.Effect<TotMutationResult, TotError>;
    /** Re-sends the list after something outside this service changes a Tot, like a held wake. */
    readonly notifyChanged: Effect.Effect<void>;
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

  const heldCount = (threadId: string) =>
    sql<{ readonly held: number }>`
      SELECT count(*) AS held FROM tot_held_wakes
      WHERE thread_id = ${threadId} AND released_at IS NULL
    `.pipe(
      Effect.map((rows) => rows[0]?.held ?? 0),
      Effect.mapError(storageError("Could not read a Tot's held wakes.")),
    );

  const watchedIds = (threadId: string) =>
    sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM tot_watches WHERE tot_thread_id = ${threadId} ORDER BY thread_id
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.thread_id)),
      Effect.mapError(storageError("Could not read a Tot's watches.")),
    );

  const openRequests = (threadId: string) =>
    sql<TotRequestRow>`
      SELECT * FROM tot_requests WHERE tot_thread_id = ${threadId}
      ORDER BY asked_at, request_id
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, requestFromRow)),
      Effect.mapError(storageError("Could not read a Tot's requests.")),
    );

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
            : Effect.all([
                heldCount(row.thread_id),
                watchedIds(row.thread_id),
                openRequests(row.thread_id),
              ]).pipe(
                Effect.flatMap(([held, watched, requests]) =>
                  totFromRow(row, shell.projectId, held, watched, requests),
                ),
              ),
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
    const tot = yield* totFromRow(row, shell.projectId, 0, [], []);
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
    const tot = yield* totFromRow(
      row,
      shell.projectId,
      yield* heldCount(row.thread_id),
      yield* watchedIds(row.thread_id),
      yield* openRequests(row.thread_id),
    );
    yield* notifyChanged;
    return { tot };
  });

  const update: TotService["Service"]["update"] = Effect.fn("TotService.update")(function* (input) {
    const updatedAt = yield* now;
    const charter = input.charter ?? null;
    const wakeSettings =
      input.wakeSettings === undefined
        ? null
        : yield* encodeWakeSettings(input.wakeSettings).pipe(
            Effect.mapError(storageError("Could not save the Tot's wake settings.")),
          );
    const crewModels =
      input.crewModels === undefined
        ? null
        : yield* encodeCrewModels(input.crewModels).pipe(
            Effect.mapError(storageError("Could not save the Tot's crew models.")),
          );
    for (const threadId of input.unwatchThreadIds ?? []) {
      yield* sql`
        DELETE FROM tot_watches
        WHERE thread_id = ${threadId}
          AND tot_thread_id = (SELECT thread_id FROM tots WHERE tot_id = ${input.id})
      `.pipe(Effect.mapError(storageError("Could not stop watching that thread.")));
    }
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
          wake_settings = COALESCE(${wakeSettings}, wake_settings),
          crew_models = COALESCE(${crewModels}, crew_models),
          charter = COALESCE(${charter}, charter),
          proposal_id = CASE WHEN ${keepsProposal} THEN proposal_id END,
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
      yield* sql`
        DELETE FROM tot_watches
        WHERE tot_thread_id = (SELECT thread_id FROM tots WHERE tot_id = ${input.id})
      `.pipe(
        Effect.andThen(sql`
          DELETE FROM tot_requests
          WHERE tot_thread_id = (SELECT thread_id FROM tots WHERE tot_id = ${input.id})
        `),
        Effect.andThen(sql`DELETE FROM tots WHERE tot_id = ${input.id}`),
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
      Effect.andThen(sql`DELETE FROM tot_held_wakes WHERE thread_id = ${threadId}`),
      Effect.andThen(
        sql`DELETE FROM tot_watches WHERE tot_thread_id = ${threadId} OR thread_id = ${threadId}`,
      ),
      Effect.andThen(sql`DELETE FROM tot_requests WHERE tot_thread_id = ${threadId}`),
      Effect.mapError(storageError("Could not remove the deleted thread's Tot.")),
    );
    yield* notifyChanged;
  });

  const proposeCharter: TotService["Service"]["proposeCharter"] = Effect.fn(
    "TotService.proposeCharter",
  )(function* (threadId, input) {
    const proposedAt = yield* now;
    const proposalId = yield* random
      .uuidV4()
      .pipe(Effect.mapError(storageError("Could not save the proposal.")));
    const rows = yield* sql<TotRow>`
      UPDATE tots SET
        proposal_id = ${proposalId},
        proposed_charter = ${input.charter},
        proposal_reason = ${input.reason},
        proposed_at = ${proposedAt},
        updated_at = ${proposedAt}
      WHERE thread_id = ${threadId}
      RETURNING *
    `.pipe(Effect.mapError(storageError("Could not save the proposal.")));
    return yield* mutated(rows[0], "Only a Tot's own thread can propose a charter.");
  });

  const isTot = (threadId: string) =>
    sql`SELECT 1 FROM tots WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(storageError("Could not read that Tot.")),
    );

  /** Nearest first, and only through subagents: a user's fork of a Tot isn't the Tot's work. */
  const crewAncestors = Effect.fnUntraced(function* (threadId: ThreadId) {
    const ancestors: Array<ThreadId> = [];
    let current = threadId;
    for (let hop = 0; hop < MAX_ANCESTORS; hop += 1) {
      const shell = yield* threads
        .getThreadShell(current)
        .pipe(Effect.mapError(storageError("Could not read a thread.")));
      const parent = shell?.lineage.parentThreadId;
      if (parent == null || shell?.lineage.relationshipToParent !== "subagent") break;
      ancestors.push(parent);
      current = parent;
    }
    return ancestors;
  });

  const watchThread: TotService["Service"]["watchThread"] = Effect.fn("TotService.watchThread")(
    function* (input) {
      if (!(yield* isTot(input.totThreadId))) return false;
      yield* sql`
        INSERT INTO tot_watches (tot_thread_id, thread_id, reason)
        VALUES (${input.totThreadId}, ${input.threadId}, ${input.reason})
        ON CONFLICT (tot_thread_id, thread_id) DO UPDATE SET
          reason = CASE WHEN reason = 'launched' THEN reason ELSE excluded.reason END
      `.pipe(Effect.mapError(storageError("Could not watch that thread.")));
      yield* notifyChanged;
      return true;
    },
  );

  const unwatchThread: TotService["Service"]["unwatchThread"] = Effect.fn(
    "TotService.unwatchThread",
  )(function* (input) {
    if (!(yield* isTot(input.totThreadId))) return false;
    yield* sql`
      DELETE FROM tot_watches
      WHERE tot_thread_id = ${input.totThreadId} AND thread_id = ${input.threadId}
    `.pipe(Effect.mapError(storageError("Could not stop watching that thread.")));
    yield* notifyChanged;
    return true;
  });

  const listWatches: TotService["Service"]["listWatches"] = Effect.fn("TotService.listWatches")(
    function* (totThreadId) {
      const rows = yield* sql<{ readonly thread_id: ThreadId; readonly reason: string }>`
        SELECT thread_id, reason FROM tot_watches WHERE tot_thread_id = ${totThreadId}
        ORDER BY thread_id
      `.pipe(Effect.mapError(storageError("Could not read a Tot's watches.")));
      return rows.map((row) => ({
        threadId: row.thread_id,
        reason: row.reason === "launched" ? ("launched" as const) : ("requested" as const),
      }));
    },
  );

  const watchersOf: TotService["Service"]["watchersOf"] = Effect.fn("TotService.watchersOf")(
    function* (threadId) {
      const watching = yield* sql<{ readonly tot_thread_id: ThreadId }>`
        SELECT w.tot_thread_id FROM tot_watches w
        JOIN tots t ON t.thread_id = w.tot_thread_id
        WHERE w.thread_id = ${threadId} AND w.tot_thread_id <> ${threadId}
      `.pipe(Effect.mapError(storageError("Could not read who watches a thread.")));
      const watchers = watching.map((row) => ({
        totThreadId: row.tot_thread_id,
        via: "watch" as const,
      }));
      const seen = new Set<string>(watchers.map((watcher) => watcher.totThreadId));
      const crewOf = [];
      for (const ancestor of yield* crewAncestors(threadId)) {
        if (!seen.has(ancestor) && (yield* isTot(ancestor))) {
          crewOf.push({ totThreadId: ancestor, via: "crew" as const });
        }
      }
      return [...watchers, ...crewOf];
    },
  );

  const startedBy: TotService["Service"]["startedBy"] = Effect.fn("TotService.startedBy")(
    function* (totThreadId, threadId) {
      if (!(yield* isTot(totThreadId))) return false;
      const launched = yield* sql`
        SELECT 1 FROM tot_watches
        WHERE tot_thread_id = ${totThreadId} AND thread_id = ${threadId} AND reason = 'launched'
      `.pipe(Effect.mapError(storageError("Could not read a Tot's watches.")));
      return launched.length > 0 || (yield* crewAncestors(threadId)).includes(totThreadId);
    },
  );

  const pendingApprovals = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
        turnItemTypes: ["approval_request"],
      })
      .pipe(
        Effect.map(({ runtimeRequests, turnItems }) => ({
          requests: runtimeRequests.filter(
            (request) => request.status === "pending" && isApprovalKind(request.kind),
          ),
          turnItems,
        })),
        Effect.mapError(storageError("Could not read that thread's requests.")),
      );

  const listCrewApprovals: TotService["Service"]["listCrewApprovals"] = Effect.fn(
    "TotService.listCrewApprovals",
  )(function* (threadId) {
    const { requests } = yield* pendingApprovals(threadId);
    return requests.map((request) => request.id);
  });

  const readCrewApproval: TotService["Service"]["readCrewApproval"] = Effect.fn(
    "TotService.readCrewApproval",
  )(function* (input) {
    const { requests, turnItems } = yield* pendingApprovals(input.threadId);
    const item = turnItems.find(
      (candidate) =>
        candidate.type === "approval_request" && candidate.requestId === input.requestId,
    );
    if (
      item?.type !== "approval_request" ||
      !requests.some((request) => request.id === input.requestId)
    ) {
      return yield* new TotError({ message: "That approval isn't waiting any more." });
    }
    return {
      requestKind: item.requestKind,
      prompt: item.prompt ?? null,
      appName: item.appName ?? null,
    };
  });

  const answerCrewApproval: TotService["Service"]["answerCrewApproval"] = Effect.fn(
    "TotService.answerCrewApproval",
  )(function* (input) {
    const { requests } = yield* pendingApprovals(input.threadId);
    const request = requests.find((candidate) => candidate.id === input.requestId);
    if (request === undefined) {
      return yield* new TotError({ message: "That approval isn't waiting any more." });
    }
    const uuid = yield* random
      .uuidV4()
      .pipe(Effect.mapError(storageError("Could not answer the approval.")));
    yield* threads
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`tot-approval:${uuid}`),
        threadId: input.threadId,
        requestId: request.id,
        decision: input.decision,
      })
      .pipe(Effect.mapError(storageError("Could not answer the approval.")));
  });

  const askUser: TotService["Service"]["askUser"] = Effect.fn("TotService.askUser")(
    function* (threadId, input) {
      if (!(yield* isTot(threadId))) {
        return yield* new TotError({ message: "Only a Tot's own thread can ask the user." });
      }
      const saveFailed = storageError("Could not save the request.");
      const open = yield* sql<{ readonly request_id: string; readonly question: string }>`
        SELECT request_id, question FROM tot_requests WHERE tot_thread_id = ${threadId}
      `.pipe(Effect.mapError(saveFailed));
      const existing =
        input.requestId === undefined
          ? open.find((request) => request.question === input.question)
          : open.find((request) => request.request_id === input.requestId);
      if (input.requestId !== undefined && existing === undefined) {
        return yield* new TotError({
          message: "That request isn't open any more. Ask again without requestId if it's needed.",
        });
      }
      if (existing === undefined && open.length >= TOT_MAX_OPEN_REQUESTS) {
        return yield* new TotError({
          message: `You already have ${TOT_MAX_OPEN_REQUESTS} open requests. Close or replace one first.`,
        });
      }
      const options = input.options ?? [];
      // A recommendation the card can't highlight is only noise, and the summary already says it.
      const recommendedOption =
        input.recommendedOption !== undefined && options.includes(input.recommendedOption)
          ? input.recommendedOption
          : null;
      const encodedOptions = yield* encodeRequestOptions(options).pipe(Effect.mapError(saveFailed));
      const askedAt = yield* now;
      const requestId =
        existing?.request_id ?? (yield* random.uuidV4().pipe(Effect.mapError(saveFailed)));
      yield* sql`
        INSERT INTO tot_requests (
          request_id, tot_thread_id, question, summary, details, options, recommended_option,
          blocks, asked_at, updated_at
        ) VALUES (
          ${requestId}, ${threadId}, ${input.question}, ${input.summary ?? ""},
          ${input.details ?? ""}, ${encodedOptions}, ${recommendedOption},
          ${input.blocks ?? null}, ${askedAt}, ${askedAt}
        )
        ON CONFLICT (request_id) DO UPDATE SET
          question = excluded.question,
          summary = excluded.summary,
          details = excluded.details,
          options = excluded.options,
          recommended_option = excluded.recommended_option,
          blocks = excluded.blocks,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(saveFailed));
      yield* notifyChanged;
      return requestId;
    },
  );

  const closeRequest: TotService["Service"]["closeRequest"] = Effect.fn("TotService.closeRequest")(
    function* (threadId, requestId) {
      const closed = yield* sql`
        DELETE FROM tot_requests
        WHERE request_id = ${requestId} AND tot_thread_id = ${threadId}
        RETURNING request_id
      `.pipe(Effect.mapError(storageError("Could not close the request.")));
      if (closed.length > 0) yield* notifyChanged;
      return closed.length > 0;
    },
  );

  const answerRequest: TotService["Service"]["answerRequest"] = Effect.fn(
    "TotService.answerRequest",
  )(function* (input) {
    const failed = storageError("Could not send your answer.");
    const rows = yield* sql<{ readonly thread_id: ThreadId; readonly question: string }>`
      SELECT t.thread_id, r.question FROM tot_requests r
      JOIN tots t ON t.thread_id = r.tot_thread_id
      WHERE r.request_id = ${input.requestId} AND t.tot_id = ${input.id}
    `.pipe(Effect.mapError(failed));
    const request = rows[0];
    if (request === undefined) {
      return yield* new TotError({ message: "That request has already been settled." });
    }
    const shell = yield* threads.getThreadShell(request.thread_id).pipe(Effect.mapError(failed));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new TotError({ message: "That Tot's thread no longer exists." });
    }
    // Sent first: a retry after a failure repeats the same command, but a request deleted before
    // a failed send would be lost for good.
    yield* threads
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`tot-answer:${input.requestId}`),
        messageId: MessageId.make(`tot-answer-message:${input.requestId}`),
        threadId: request.thread_id,
        text: formatRequestAnswer(request.question, input.answer),
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(failed));
    yield* closeRequest(request.thread_id, input.requestId);
    const updated = yield* sql<TotRow>`
      SELECT * FROM tots WHERE tot_id = ${input.id}
    `.pipe(Effect.mapError(failed));
    return yield* mutated(updated[0], "That Tot no longer exists.");
  });

  const answerCharterProposal: TotService["Service"]["answerCharterProposal"] = Effect.fn(
    "TotService.answerCharterProposal",
  )(function* (input) {
    const updatedAt = yield* now;
    const rows = yield* sql<TotRow>`
      UPDATE tots SET
        charter = CASE
          WHEN ${input.approve ? 1 : 0} = 1 THEN COALESCE(${input.charter ?? null}, proposed_charter)
          ELSE charter
        END,
        proposal_id = NULL,
        proposed_charter = NULL,
        proposal_reason = NULL,
        proposed_at = NULL,
        updated_at = ${updatedAt}
      WHERE tot_id = ${input.id} AND proposal_id = ${input.proposalId}
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
    watchThread,
    unwatchThread,
    listWatches,
    watchersOf,
    startedBy,
    listCrewApprovals,
    readCrewApproval,
    answerCrewApproval,
    askUser,
    closeRequest,
    answerRequest,
    answerCharterProposal,
    notifyChanged,
  });
});

export const layer = Layer.effect(TotService, make);
