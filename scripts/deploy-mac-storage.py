#!/usr/bin/env python3
"""Keep two installed releases and one verified, compressed database snapshot."""
import argparse
from contextlib import closing
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile


def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        result.update(chunk)
    return result.hexdigest()


def create_backup(source, backups, server_plist=None):
    source = source.resolve(strict=True)
    backups.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.backup-', dir=backups))
    try:
        snapshot = temporary / source.name
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
            with closing(sqlite3.connect(snapshot)) as dst:
                src.backup(dst, pages=4096)
        with closing(sqlite3.connect(snapshot.as_uri() + '?mode=ro', uri=True)) as db:
            if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise ValueError('Database snapshot failed SQLite quick_check')
        with snapshot.open('rb') as stream:
            expected = digest(stream)
        archive = snapshot.with_suffix(snapshot.suffix + '.gz')
        with snapshot.open('rb') as src, gzip.open(archive, 'wb', compresslevel=6) as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        with gzip.open(archive, 'rb') as stream:
            if digest(stream) != expected:
                raise ValueError('Compressed database does not restore to the verified snapshot')
        (temporary / 'manifest.json').write_text(json.dumps({
            'database': source.name, 'sha256': expected,
            'created': datetime.now().astimezone().isoformat(),
        }, indent=2) + '\n')
        if server_plist is not None:
            shutil.copy2(server_plist, temporary / 'server.plist')
        snapshot.unlink()
        for suffix in ['-wal', '-shm', '-journal']:
            snapshot.with_name(snapshot.name + suffix).unlink(missing_ok=True)
        (temporary / 'BACKUP_READY').touch()
        destination = backups / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        temporary.rename(destination)
        return destination
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def prune(root, keep_release=None):
    root = root.resolve(strict=True)
    releases = root / 'releases'
    keep = set()
    for name in ['current', 'previous']:
        reference = root / name
        if reference.is_symlink():
            target = reference.resolve(strict=True)
            if target.parent != releases or not target.name.startswith('build.'):
                raise ValueError(f'Refusing to prune with invalid {name} release: {target}')
            keep.add(target)
    if keep_release is not None:
        target = keep_release.resolve(strict=True)
        if target.parent != releases or not target.name.startswith('build.'):
            raise ValueError(f'Invalid staged release: {target}')
        keep.add(target)
    if (root / 'current').is_symlink():
        for release in releases.glob('build.*'):
            if release not in keep and release.is_dir() and not release.is_symlink():
                shutil.rmtree(release)
    prepared = root / 'PREPARED_RELEASE'
    if prepared.exists() and not Path(prepared.read_text().strip()).exists():
        prepared.unlink()
    backups = root / 'backups'
    ready = sorted(p for p in backups.glob('*') if p.is_dir() and not p.is_symlink()
                   and (p / 'BACKUP_READY').is_file() and (p / 'manifest.json').is_file()
                   and list(p.glob('*.sqlite.gz')))
    if ready:
        for backup in backups.iterdir():
            if backup != ready[-1] and not backup.name.startswith('.') and backup.is_dir() and not backup.is_symlink():
                shutil.rmtree(backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    backup = commands.add_parser('backup')
    backup.add_argument('--source', type=Path, required=True)
    backup.add_argument('--backups-dir', type=Path, required=True)
    backup.add_argument('--server-plist', type=Path)
    clean = commands.add_parser('prune')
    clean.add_argument('--root', type=Path, required=True)
    clean.add_argument('--keep-release', type=Path)
    args = parser.parse_args()
    if args.command == 'backup':
        print(create_backup(args.source, args.backups_dir, args.server_plist))
    else:
        prune(args.root, args.keep_release)


if __name__ == '__main__':
    main()
