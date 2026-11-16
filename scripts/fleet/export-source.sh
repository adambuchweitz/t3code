#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
output=${1:?Supply a new output directory outside the checkout.}
mkdir -p "$(dirname "$output")"
parent=$(cd "$(dirname "$output")" && pwd -P)
output="$parent/$(basename "$output")"
case "$output/" in "$repo/"*) echo 'Output must be outside the checkout.' >&2; exit 1 ;; esac
mkdir "$output"

revision=$(git -C "$repo" rev-parse --verify 'HEAD^{commit}')
tree=$(git -C "$repo" rev-parse --verify "$revision^{tree}")
upstream=$(git -C "$repo" merge-base "$revision" 'origin/main^{commit}')
version=$(git -C "$repo" describe --tags --match 'v*-nightly.*' --abbrev=0 "$revision")
version=${version#v}
git -C "$repo" archive "$revision" > "$output/source.tar"
sha=$(sha256sum "$output/source.tar" | cut -d ' ' -f 1)
python3 - "$output/metadata.json" "$revision" "$tree" "$upstream" "$version" "$sha" <<'PY'
import json, sys
path, revision, tree, upstream, version, sha = sys.argv[1:]
with open(path, 'w', encoding='utf-8') as f:
    json.dump({'sourceCommit': revision, 'sourceTree': tree, 'upstreamBase': upstream,
               'version': version, 'archiveSha256': sha}, f, indent=2)
    f.write('\n')
PY
printf 'Exported %s to %s\n' "$tree" "$output"
