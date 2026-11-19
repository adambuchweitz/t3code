#!/bin/bash
# Build an exported source tree, then activate only when idle.
# Usage: deploy-mac-server.sh [--prepare-only] --source-dir /absolute/archive | --activate /absolute/prepared/release
# Rebuilds use ordinary Node because Intel macOS cannot run the CLI's Node SEA.
# Parse the full deployment before waiting; GitButler can replace this file meanwhile.
main() {
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

[[ $(uname -s) == Darwin && $(uname -m) == x86_64 ]] || {
  echo 'Run this script on an Intel Mac.' >&2; exit 1;
}
workspace_dir=$(cd "$(dirname "$0")/.." && pwd -P)
source_dir=""
prepare_only=false
activate_only=false
while (($#)); do
  case $1 in
    --prepare-only) prepare_only=true; shift ;;
    --source-dir) source_dir=$(cd "${2:?An exported source path is required.}" && pwd -P); shift 2 ;;
    --activate) activate_only=true; source_dir=$(cd "${2:?A prepared release path is required.}" && pwd -P); shift 2 ;;
    *) echo "Unknown deployment option: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$source_dir" ]] || { echo 'Supply an exported source directory or a prepared release.' >&2; exit 1; }
if [[ $activate_only == true ]]; then
  [[ $prepare_only == false && $(dirname "$source_dir") == "$HOME/.local/share/t3code-build/releases" && $(basename "$source_dir") == build.* && -f "$source_dir/BUILD_READY" ]] || {
    echo 'Refusing to activate an unprepared release.' >&2; exit 1;
  }
else
  [[ ! -e "$source_dir/.git" && -f "$source_dir/pnpm-lock.yaml" ]] || { echo 'Source must be an exported tree.' >&2; exit 1; }
  for metadata in BUILD_REVISION BUILD_TREE UPSTREAM_REVISION; do
    [[ -f "$source_dir/$metadata" && $(cat "$source_dir/$metadata") =~ ^[0-9a-f]{40}$ ]] || {
      echo "Invalid or missing source metadata: $metadata" >&2; exit 1;
    }
  done
fi
install_dir="$HOME/.local/share/t3code-build"
mkdir -p "$install_dir/runtime" "$install_dir/releases"
lock_dir="$install_dir/build.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
  if [[ $owner =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
    rm "$lock_dir/pid"
    rmdir "$lock_dir"
    mkdir "$lock_dir" || { echo 'Another build is running.' >&2; exit 1; }
    echo "Recovered stale build lock from PID $owner"
  else
    echo "Another build is running, or a legacy lock needs inspection: $lock_dir" >&2
    exit 1
  fi
fi
printf '%s\n' "$$" > "$lock_dir/pid"
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cleanup() {
  status=${1:-$?}
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir"
  return "$status"
}
trap cleanup EXIT
if [[ $activate_only == false && -f "$install_dir/current/BUILD_TREE" && $(cat "$install_dir/current/BUILD_TREE") == "$(cat "$source_dir/BUILD_TREE")" ]]; then
  curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3773/
  echo "Already running workspace tree $(cat "$source_dir/BUILD_TREE"); service healthy"; exit 0
fi
# Main can change its wire protocol before installed mobile clients update.
# The operator raises this ceiling only after compatible clients are installed.
max_protocol=$(cat "$install_dir/SUPPORTED_ORCHESTRATION_PROTOCOL" 2>/dev/null || echo 1)
[[ $max_protocol =~ ^[0-9]+$ ]] || { echo 'Invalid supported protocol ceiling.' >&2; exit 1; }
candidate_protocol=$(python3 - "$source_dir" <<'PY'
import pathlib, re, sys
release = pathlib.Path(sys.argv[1])
marker = release / 'ORCHESTRATION_PROTOCOL'
if marker.exists():
    value = marker.read_text().strip()
    if not value.isdigit():
        raise SystemExit('Invalid release protocol metadata.')
    print(value)
    raise SystemExit(0)
text = (release / 'packages/contracts/src/environment.ts').read_text()
match = re.search(r'export const ORCHESTRATION_PROTOCOL_VERSION\s*=\s*(\d+)', text)
if 'ORCHESTRATION_PROTOCOL_VERSION' in text and match is None:
    raise SystemExit('Cannot determine upstream orchestration protocol; refusing deployment.')
print(match.group(1) if match else 1)
PY
)
if ((candidate_protocol > max_protocol)); then
  echo "Upstream requires protocol $candidate_protocol; installed clients support $max_protocol. Keeping the current server."
  exit 1
fi
if [[ -L "$install_dir/current" && "$source_dir" == "$(cd "$install_dir/current" && pwd -P)" ]]; then
  echo 'Refusing to rebuild the running release.' >&2; exit 1
fi

if [[ $activate_only == false ]]; then
[[ -n ${T3CODE_BUILD_VERSION:-} ]] || { echo 'Set T3CODE_BUILD_VERSION to the pinned fleet version.' >&2; exit 1; }
export T3CODE_BUILD_VERSION
node_version=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["engines"]["node"])' "$source_dir/package.json")
[[ $node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Release must pin an exact Node version, got: $node_version" >&2; exit 1; }
node_dir="$install_dir/runtime/node-v$node_version-darwin-x64"
if [[ ! -x "$node_dir/bin/node" ]]; then
  (
    cd "$install_dir/runtime"
    archive="node-v$node_version-darwin-x64.tar.gz"
    curl -fL --retry 2 -o "$archive" "https://nodejs.org/dist/v$node_version/$archive"
    curl -fL --retry 2 -o SHASUMS256.txt "https://nodejs.org/dist/v$node_version/SHASUMS256.txt"
    grep " $archive\$" SHASUMS256.txt | shasum -a 256 -c -
    tar -xzf "$archive"
  )
fi
export PATH="$node_dir/bin:$source_dir/node_modules/.bin:$install_dir/tools/node_modules/.bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$source_dir"
package_manager=$(node -p 'require("./package.json").packageManager')
if [[ ! -x "$install_dir/tools/node_modules/.bin/pnpm" ]] ||
   [[ $(pnpm --version) != "${package_manager#pnpm@}" ]]; then
  npm install --prefix "$install_dir/tools" "$package_manager"
fi
# Upstream's example contains the public production T3 Connect identifiers.
cp .env.example .env
node --input-type=module - <<'JS'
import fs from 'node:fs';
const path = 'apps/server/package.json';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.version = process.env.T3CODE_BUILD_VERSION;
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
JS
pnpm install --frozen-lockfile
pnpm exec vp test run apps/web/src/hooks/useClearTheDecks.test.ts apps/web/src/lib/readAloudMessages.test.ts --maxWorkers=2
bash scripts/fleet/check-mac-migrations.sh "$source_dir"
pnpm exec vp run --filter t3 build
export CARGO_TARGET_DIR="$install_dir/cargo-target"
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p apps/server/dist/resource-monitor/darwin-x64
cp "$CARGO_TARGET_DIR/release/t3-resource-monitor" apps/server/dist/resource-monitor/darwin-x64/
node apps/server/dist/bin.mjs --version
test -s apps/server/dist/client/index.html
runtime_dir=$(mktemp -d "$install_dir/releases/build.XXXXXX")
node scripts/stage-mac-server.ts --source-dir "$source_dir" --destination-dir "$runtime_dir" --protocol "$candidate_protocol"
source_dir="$runtime_dir"
cd "$workspace_dir"
node "$source_dir/apps/server/dist/bin.mjs" --version
test -s "$source_dir/apps/server/dist/client/index.html"
python3 "$workspace_dir/scripts/fleet/smoke-mac.py" "$node_dir/bin/node" "$source_dir"
printf '%s\n' "$node_version" > "$source_dir/NODE_VERSION"
touch "$source_dir/BUILD_READY"
fi
# Releases prepared before NODE_VERSION existed were built with Node 24.13.1.
node_dir="$install_dir/runtime/node-v$(cat "$source_dir/NODE_VERSION" 2>/dev/null || echo 24.13.1)-darwin-x64"
if [[ $prepare_only == true ]]; then
  printf '%s\n' "$source_dir" > "$install_dir/PREPARED_RELEASE"
  echo "Prepared $source_dir; the running server was not changed."
  exit 0
fi
# Include every durable run, including the deploying agent itself. A quiet interval
# avoids restarting between adjacent queued turns; re-check immediately before bootout.
python3 "$workspace_dir/scripts/wait-for-t3-idle.py" "$HOME/.t3/userdata/statev2.sqlite"

label=com.t3tools.t3code-server
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/$label.plist"
backup=""
previous=$(readlink "$install_dir/current" || true)
# bootout returns before launchd finishes removing the service.
# Wait for removal before bootstrap, including during rollback.
stop_service() {
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label" 2>/dev/null || true
  fi
  for ((attempt=0; attempt<60; attempt++)); do
    if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $label to unload" >&2
  return 1
}
service_changed=false
recover_service() {
  status=$?
  if [[ $status != 0 && $service_changed == true ]]; then
    stop_service || true
    cp "$backup/server.plist" "$plist"
    if [[ -n "$previous" ]]; then
      ln -sfn "$previous" "$install_dir/current"
    fi
    launchctl bootstrap "$domain" "$plist" || true
    echo "Deployment failed; restored the previous service. Database backup: $backup" >&2
  fi
  cleanup "$status"
}
trap recover_service EXIT
# Snapshot and verify the compressed database before replacing any older backup.
database=$(python3 - "$HOME/.t3/userdata" "$install_dir/current" <<'PY'
import pathlib, re, sys
userdata, release = map(pathlib.Path, sys.argv[1:])
active_contract = release / 'packages/contracts/src/environment.ts'
# Back up the active release's database, including after a V2-to-V1 rollback.
active_protocol = 1
marker = release / 'ORCHESTRATION_PROTOCOL'
if marker.exists():
    value = marker.read_text().strip()
    if not value.isdigit():
        raise SystemExit('Invalid active protocol metadata.')
    active_protocol = int(value)
elif active_contract.exists():
    text = active_contract.read_text()
    match = re.search(r'export const ORCHESTRATION_PROTOCOL_VERSION\s*=\s*(\d+)', text)
    if 'ORCHESTRATION_PROTOCOL_VERSION' in text and match is None:
        raise SystemExit('Cannot determine active database; refusing deployment.')
    active_protocol = int(match.group(1)) if match else 1
source = userdata / ('statev2.sqlite' if active_protocol >= 2 else 'state.sqlite')
if not source.is_file():
    raise SystemExit('Active database is missing; refusing deployment without a backup.')
print(source)
PY
)
backup=$(python3 "$workspace_dir/scripts/deploy-mac-storage.py" backup --source "$database" --backups-dir "$install_dir/backups" --server-plist "$plist")
python3 "$workspace_dir/scripts/wait-for-t3-idle.py" "$HOME/.t3/userdata/statev2.sqlite" --quiet-seconds 0
service_changed=true
stop_service
ln -s "$source_dir" "$install_dir/current.next"
mv -fh "$install_dir/current.next" "$install_dir/current"
python3 - "$plist" "$node_dir/bin/node" "$install_dir/current/apps/server/dist/bin.mjs" <<'PY'
import pathlib, plistlib, sys
path, node, entry = sys.argv[1:]
with open(path, 'rb') as f:
    config = plistlib.load(f)
config['ProgramArguments'] = [node, entry, 'serve', '--tailscale-serve', '--host', '0.0.0.0', '--port', '3773']
paths = config['EnvironmentVariables']['PATH'].split(':')
paths = [p for p in paths if '/t3code-build/runtime/' not in p]
config['EnvironmentVariables']['PATH'] = ':'.join([str(pathlib.Path(node).parent), *paths])
with open(path, 'wb') as f:
    plistlib.dump(config, f)
PY
launchctl bootstrap "$domain" "$plist"
# Startup runs pending migrations first; a rollback mid-migration would put the old server on a newer database.
curl -fsS --retry 450 --retry-connrefused --retry-delay 2 --max-time 5 \
  -o /dev/null http://127.0.0.1:3773/
trap cleanup EXIT
if [[ -n "$previous" ]]; then
  ln -sfn "$previous" "$install_dir/previous"
fi
echo "Deployed $source_dir; previous release: ${previous:-npm installation}"
echo "Backup: $backup"
# Keep current, previous and the newest complete backup; the deploy already succeeded.
python3 "$workspace_dir/scripts/deploy-mac-storage.py" prune --root "$install_dir" ||
  echo "Pruning old releases and backups failed; they were kept." >&2

}
main "$@"
