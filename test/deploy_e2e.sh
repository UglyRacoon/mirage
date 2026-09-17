#!/usr/bin/env bash
# End-to-end test of the install/update machinery in deploy.sh.
# Needs no root: systemd and root checks are replaced by stubs, everything else
# (discovery, backup, git payload update, service start, health check, rollback)
# runs for real against a throwaway git remote and a live Mirage process.
#
#   bash test/deploy_e2e.sh
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_SRC="$(cd -- "$HERE/.." && pwd -P)"
DEPLOY="$REPO_SRC/deploy.sh"
TMP="$(mktemp -d)"
PORT="${MIRAGE_E2E_PORT:-17991}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '\033[32m  ok\033[0m %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf '\033[31mFAIL\033[0m %s\n' "$*"; }
check() { if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

cleanup() {
    kill "$(cat "$TMP/etc/mirage/mirage.pid" 2>/dev/null)" 2>/dev/null || true
    pkill -f "src/index.js" 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT

# --------------------------------------------------------------- fixtures
mkdir -p "$TMP/etc/mirage" "$TMP/units" "$TMP/backups" "$TMP/src"

# a local "origin" built from the repo under test (fresh history, never shallow)
mkdir -p "$TMP/origin_src"
cp -a "$REPO_SRC/." "$TMP/origin_src/"
rm -rf "$TMP/origin_src/.git"
git -C "$TMP/origin_src" init --quiet -b main
git -C "$TMP/origin_src" config user.email t@t
git -C "$TMP/origin_src" config user.name t
git -C "$TMP/origin_src" add -A
git -C "$TMP/origin_src" commit --quiet -m "release 1.0.0"

# the "installed" tree is a git checkout of that origin
git clone --quiet "$TMP/origin_src" "$TMP/app"

# a decoy Mirage-shaped directory, to make sure the real one wins
mkdir -p "$TMP/decoy/mirage/src" && printf 'not mirage\n' >"$TMP/decoy/mirage/src/index.js"

# --------------------------------------------------------------- harness
export REPO="$TMP/origin_src"
export APP_DIR="$TMP/app"
export PORT
export MIRAGE_STATE_FILE="$TMP/etc/mirage/install.conf"
export MIRAGE_STATE_DIR="$TMP/etc/mirage"
export MIRAGE_UNIT_DIRS="$TMP/units"
export MIRAGE_SEARCH_ROOTS="$TMP"
export MIRAGE_SEARCH_DEPTH=4
export MIRAGE_COMMON_DIRS="$TMP/app $TMP/decoy/mirage"
export MIRAGE_KEEP_BACKUPS=2
export BACKUP_ROOT="$TMP/backups"
export MIRAGE_ASSUME_YES=1
NODE_BIN="$(command -v node)"
export NODE_BIN

# shellcheck source=../deploy.sh
source "$DEPLOY"

# stubs: this test must run unprivileged and without a real init system
ensure_root() { :; }
systemd_available() { return 1; }
unit_known() { return 1; }

wait_health() { health_check "$PORT" 15; }

echo "== 1. discovery of an existing installation =="
resolve_installation
check "installation detected"   "$TMP/app" "$APP_DIR"
check "installed flag"          "1"       "$INSTALLED"
check "port from env"           "$PORT"   "$PORT_ENV"
check "user resolved"           "yes"     "$(id "$APP_USER" >/dev/null 2>&1 && echo yes || echo no)"

echo "== 2. update to a new version =="
VER_NOW="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/app/package.json" | head -n1)"
sed -i 's/"version": "[^"]*"/"version": "9.9.9"/' "$TMP/origin_src/package.json"
echo "// e2e marker" >>"$TMP/origin_src/src/util.js"
git -C "$TMP/origin_src" add -A && git -C "$TMP/origin_src" commit --quiet -m "release 9.9.9"

if do_update >"$TMP/update1.log" 2>&1; then pass "do_update succeeded"; else fail "do_update failed: $(tail -5 "$TMP/update1.log")"; fi
check "new version on disk" "9.9.9" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/app/package.json" | head -n1)"
if wait_health; then pass "app answers on 127.0.0.1:$PORT"; else fail "app does not answer after update"; fi
check "backup of the old version kept" "yes" "$(ls -d "$TMP/backups"/mirage_backup_* >/dev/null 2>&1 && echo yes || echo no)"
check "state file written" "yes" "$([[ -f "$MIRAGE_STATE_FILE" ]] && echo yes || echo no)"
check "state records the port" "$PORT" "$(sed -n 's/^MIRAGE_PORT="\(.*\)"$/\1/p' "$MIRAGE_STATE_FILE")"
check "state points at the install" "$TMP/app" "$(sed -n 's/^MIRAGE_APP_DIR="\(.*\)"$/\1/p' "$MIRAGE_STATE_FILE")"
check "marker written" "yes" "$([[ -f "$TMP/app/.mirage-install" ]] && echo yes || echo no)"

echo "== 2b. the no-systemd fallback can really stop the server =="
svc_pid="$(bg_pid || true)"
check "server pid recorded" "yes" "$([[ -n "$svc_pid" ]] && echo yes || echo no)"
service_stop
sleep 1
if health_check "$PORT" 2; then fail "service_stop left the server running"; else pass "service_stop stopped the server"; fi
if kill -0 "${svc_pid:-0}" 2>/dev/null; then fail "pid $svc_pid still alive after stop"; else pass "recorded pid is really the server"; fi
service_start
if wait_health; then pass "service_start brings it back"; else fail "service_start failed"; fi

echo "== 3. update from a plain directory (no git, tarball-style install) =="
plain="$TMP/plaininstall"
mkdir -p "$plain"; cp -a "$TMP/app/." "$plain/"; rm -rf "$plain/.git" "$plain/.mirage-install" "$plain/data"
APP_DIR_ENV="$plain"
if find_mirage_dir; then pass "plain tree found"; else fail "plain tree not found"; fi
check "plain tree chosen" "$plain" "$FOUND_DIR"
APP_DIR="$plain"; REPO="$TMP/origin_src"
if apply_payload >/dev/null 2>&1; then pass "payload applied to a non-git tree"; else fail "non-git payload sync failed"; fi
check "plain tree got the new release" "9.9.9" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$plain/package.json" | head -n1)"
APP_DIR_ENV="$TMP/app"; APP_DIR="$TMP/app"; REPO="$TMP/origin_src"

echo "== 4. rollback when the new version cannot start =="
mkdir -p "$TMP/app/data"; echo "profile-data" >"$TMP/app/data/mirage.db"
# break the payload in a way only a runtime check can catch
perl -0pi -e 's/const DATA = process\.env\.MIRAGE_DATA/const DATA = process.env.MIRAGE_DATA; await brokenSyntaxHere(/' "$TMP/origin_src/src/index.js"
if ! node --check "$TMP/origin_src/src/index.js" >/dev/null 2>&1; then pass "broken payload prepared"; else fail "payload is not broken"; fi
git -C "$TMP/origin_src" add -A && git -C "$TMP/origin_src" commit --quiet -m "broken release"

if do_update >"$TMP/update2.log" 2>&1; then
    fail "do_update reported success on a broken payload"
else
    pass "do_update reported failure on a broken payload"
fi
if grep -q "did not come up after the update" "$TMP/update2.log"; then
    pass "health check caught the broken payload"
else
    fail "broken payload was not detected: $(tail -3 "$TMP/update2.log")"
fi
if grep -q "rolling back" "$TMP/update2.log"; then pass "rollback was attempted"; else fail "no rollback in log: $(tail -6 "$TMP/update2.log")"; fi
if node --check "$TMP/app/src/index.js" >/dev/null 2>&1; then pass "rolled-back tree is valid again"; else fail "tree left broken after rollback"; fi
if wait_health; then pass "app is serving after rollback"; else fail "app is down after rollback"; fi
if grep -q "profile-data" "$TMP/app/data/mirage.db" 2>/dev/null; then pass "profile data survived the rollback"; else fail "profile data lost during rollback"; fi

echo "== 5. surviving a moved installation (path changed) =="
moved="$TMP/moved/elsewhere"
mkdir -p "$(dirname "$moved")"
mv "$TMP/app" "$moved"
rm -f "$MIRAGE_STATE_FILE"                     # pretend the state file was lost
export REPO="$TMP/origin_src"
APP_DIR_ENV=""
if find_mirage_dir; then pass "moved tree discovered without a state file"; else fail "moved tree not discovered"; fi
check "discovered the new path" "$moved" "$FOUND_DIR"
APP_DIR="$moved"
check "marker carried over" "$TMP/app" "$(marker_get "$moved" app_dir)"

echo
printf 'deploy.sh e2e: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
