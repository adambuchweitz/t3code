import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE tots (
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
});
