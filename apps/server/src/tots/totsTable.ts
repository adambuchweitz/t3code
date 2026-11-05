import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const ADDED_COLUMNS = {
  charter: "TEXT NOT NULL DEFAULT ''",
  voice: "TEXT NOT NULL DEFAULT 'toddler'",
  proposed_charter: "TEXT",
  proposal_reason: "TEXT",
  proposed_at: "TEXT",
} as const;

// Not a numbered migration: this feature lives on a fork, and a database that recorded an id
// upstream later reuses refuses to start. Move this into a migration if Tots go upstream.
export const ensureTotsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tots (
      tot_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_enabled INTEGER NOT NULL,
      character_id TEXT NOT NULL,
      job TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  const existing = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('tots')`;
  const present = new Set(existing.map((column) => column.name));
  for (const [name, definition] of Object.entries(ADDED_COLUMNS)) {
    if (!present.has(name)) yield* sql.unsafe(`ALTER TABLE tots ADD COLUMN ${name} ${definition}`);
  }
}).pipe(Effect.orDie);
