#!/bin/bash
set -euo pipefail
source_dir=${1:?Supply an extracted source directory.}
database="$HOME/.t3/userdata/statev2.sqlite"
[[ -f "$database" ]] || { echo 'Live database not found; cannot verify migrations.' >&2; exit 1; }
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/t3-migrations.XXXXXXXX")
trap 'rm -rf "$work_dir"' EXIT
python3 - "$database" "$work_dir/statev2.sqlite" <<'PY'
import pathlib, sqlite3, sys
source = pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro'
with sqlite3.connect(source, uri=True) as live, sqlite3.connect(sys.argv[2]) as copy:
    live.backup(copy)
PY
cd "$source_dir/apps/server"
node --input-type=module - "$work_dir/statev2.sqlite" <<'JS'
import * as Effect from 'effect/Effect';
import * as NodeSqliteClient from '@t3tools/shared/nodeSqliteClient';
import { runMigrations } from './src/persistence/Migrations.ts';
import { ensureTotsTable } from './src/tots/totsTable.ts';
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const applied = yield* runMigrations();
  yield* ensureTotsTable;
  console.log(`Migration check passed on a database copy (${applied.length} applied).`);
}).pipe(Effect.provide(NodeSqliteClient.layer({ filename: process.argv[2] })))));
JS
