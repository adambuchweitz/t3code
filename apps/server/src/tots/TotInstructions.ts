import { TotJob, TotVoice, type ThreadId } from "@t3tools/contracts";
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
});
const decodeRow = Schema.decodeUnknownEffect(TotInstructionsRow);

/**
 * What a Tot's next turn tells the model. Apart from `TotService`, which depends on thread
 * management and so can't sit underneath turn start.
 */
export class TotInstructions extends Context.Service<
  TotInstructions,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<{
      readonly name: string | null;
      readonly job: TotJob;
      readonly voice: TotVoice;
      readonly charter: string;
    } | null>;
  }
>()("t3/tots/TotInstructions") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureTotsTable;
  return TotInstructions.of({
    forThread: Effect.fn("TotInstructions.forThread")(
      function* (threadId) {
        const rows = yield* sql`
        SELECT name, name_enabled, job, voice, charter FROM tots WHERE thread_id = ${threadId}
      `;
        if (rows[0] === undefined) return null;
        const row = yield* decodeRow(rows[0]);
        return {
          name: row.name_enabled === 0 ? null : row.name,
          job: row.job,
          voice: row.voice,
          charter: row.charter,
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
  });
});

export const layer = Layer.effect(TotInstructions, make);
