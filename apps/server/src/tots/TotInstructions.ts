import {
  TOT_MAX_OPEN_REQUESTS,
  TotCrewModel,
  TotJob,
  TotVoice,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureTotsTable } from "./totsTable.ts";

const TotInstructionsRow = Schema.Struct({
  name: Schema.String,
  name_enabled: Schema.Number,
  job: TotJob,
  voice: TotVoice,
  charter: Schema.String,
  crew_models: Schema.fromJsonString(Schema.Array(TotCrewModel)),
});
const decodeRow = Schema.decodeUnknownEffect(TotInstructionsRow);

export interface TotInstructionsShape {
  readonly forThread: (threadId: ThreadId) => Effect.Effect<{
    readonly name: string | null;
    readonly job: TotJob;
    readonly voice: TotVoice;
    readonly charter: string;
    readonly crewModels: ReadonlyArray<TotCrewModel>;
    readonly openRequests: ReadonlyArray<{
      readonly id: string;
      readonly question: string;
      readonly blocks: string | null;
      readonly askedAt: string;
    }>;
  } | null>;
}

/**
 * What a Tot's next turn tells the model. Apart from `TotService`, which depends on thread
 * management and so can't sit underneath turn start. A reference so that turn start's many test
 * layers need nothing: without this service provided, no thread is a Tot.
 */
export class TotInstructions extends Context.Reference<TotInstructionsShape>(
  "t3/tots/TotInstructions",
  { defaultValue: () => ({ forThread: () => Effect.succeed(null) }) },
) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureTotsTable;
  return {
    forThread: Effect.fn("TotInstructions.forThread")(
      function* (threadId) {
        const rows = yield* sql`
        SELECT name, name_enabled, job, voice, charter, crew_models FROM tots WHERE thread_id = ${threadId}
      `;
        if (rows[0] === undefined) return null;
        const row = yield* decodeRow(rows[0]);
        const openRequests = yield* sql<{
          readonly request_id: string;
          readonly question: string;
          readonly blocks: string | null;
          readonly asked_at: string;
        }>`
          SELECT request_id, question, blocks, asked_at FROM tot_requests
          WHERE tot_thread_id = ${threadId}
          ORDER BY asked_at, rowid
          LIMIT ${TOT_MAX_OPEN_REQUESTS}
        `;
        return {
          name: row.name_enabled === 0 ? null : row.name,
          job: row.job,
          voice: row.voice,
          charter: row.charter,
          crewModels: row.crew_models,
          openRequests: openRequests.map((request) => ({
            id: request.request_id,
            question: request.question,
            blocks: request.blocks,
            askedAt: request.asked_at,
          })),
        };
      },
      (effect) =>
        // A lost charter is better than a turn that won't start.
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not read a Tot's instructions", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        ),
    ),
  } satisfies TotInstructionsShape;
});

export const layer = Layer.effect(TotInstructions, make);
