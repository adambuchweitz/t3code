#!/usr/bin/env python3
"""Wait for durable T3 runs to settle without writing to the live database."""
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3
import time

TERMINAL = ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')

def active_run_count(database):
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)) as conn:
        conn.execute('PRAGMA query_only=ON')
        return conn.execute(
            'SELECT count(*) FROM orchestration_v2_projection_runs WHERE status NOT IN (?,?,?,?,?)',
            TERMINAL,
        ).fetchone()[0]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('--quiet-seconds', type=float, default=30)
    args = parser.parse_args()
    quiet_since = None
    last_count = None
    last_error = None
    while True:
        try:
            count = active_run_count(args.database)
        except sqlite3.Error as error:
            # A failed read cannot establish that agents are idle.
            quiet_since = None
            last_count = None
            if str(error) != last_error:
                print(f'Cannot read T3 agent activity; waiting: {error}', flush=True)
                last_error = str(error)
            time.sleep(10)
            continue
        if last_error is not None:
            print('T3 agent activity database is readable again.', flush=True)
            last_error = None
        if count != last_count:
            print(f'Waiting for T3 agents to become idle: {count} active runs', flush=True)
            last_count = count
        if count:
            quiet_since = None
        elif quiet_since is None:
            quiet_since = time.monotonic()
        if quiet_since is not None and time.monotonic() - quiet_since >= args.quiet_seconds:
            return
        time.sleep(10)

if __name__ == '__main__':
    main()
