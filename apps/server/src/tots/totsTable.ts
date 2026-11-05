import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const ADDED_COLUMNS = {
  charter: "TEXT NOT NULL DEFAULT ''",
  voice: "TEXT NOT NULL DEFAULT 'toddler'",
  proposal_id: "TEXT",
  proposed_charter: "TEXT",
  proposal_reason: "TEXT",
  proposed_at: "TEXT",
  wake_settings:
    'TEXT NOT NULL DEFAULT \'{"quietHours":null,"dailyWakeLimit":null,"wakeChecks":[]}\'',
  crew_models: "TEXT NOT NULL DEFAULT '[]'",
  wake_day: "TEXT",
  wake_count: "INTEGER NOT NULL DEFAULT 0",
  heartbeat_created: "INTEGER NOT NULL DEFAULT 0",
  briefed_at: "TEXT",
  talk_topic: "TEXT",
  talk_asked_at: "TEXT",
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
  yield* sql`
    CREATE TABLE IF NOT EXISTS tot_held_wakes (
      held_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      scheduled_task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      held_at TEXT NOT NULL,
      batch_id TEXT,
      batch_day TEXT,
      released_at TEXT
    )
  `;
  // "launched" also lets the Tot answer the thread's requests; "requested" only wakes it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS tot_watches (
      tot_thread_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (tot_thread_id, thread_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tot_watches_thread ON tot_watches (thread_id)`;
  const heldColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('tot_held_wakes')
  `;
  const heldPresent = new Set(heldColumns.map((column) => column.name));
  if (!heldPresent.has("batch_id")) yield* sql`ALTER TABLE tot_held_wakes ADD COLUMN batch_id TEXT`;
  if (!heldPresent.has("batch_day"))
    yield* sql`ALTER TABLE tot_held_wakes ADD COLUMN batch_day TEXT`;
  if (!heldPresent.has("released_at")) {
    yield* sql`ALTER TABLE tot_held_wakes ADD COLUMN released_at TEXT`;
  }
  // A proposal saved before proposals had ids still needs one to be answered.
  yield* sql`
    UPDATE tots SET proposal_id = lower(hex(randomblob(16)))
    WHERE proposed_charter IS NOT NULL AND proposal_id IS NULL
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tot_held_wakes_thread ON tot_held_wakes (thread_id)`;
}).pipe(Effect.orDie);
