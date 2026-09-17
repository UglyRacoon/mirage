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

echo "== 4. a broken release is refused BEFORE anything is touched =="
mkdir -p "$TMP/app/data"; echo "profile-data" >"$TMP/app/data/mirage.db"
svc_pid="$(bg_pid || true)"
ver_before="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/app/package.json" | head -n1)"
# publish a release that cannot even parse
perl -0pi -e 's/const DATA = process\.env\.MIRAGE_DATA/const DATA = process.env.MIRAGE_DATA; await brokenSyntaxHere(/' "$TMP/origin_src/src/index.js"
if ! node --check "$TMP/origin_src/src/index.js" >/dev/null 2>&1; then pass "broken release prepared"; else fail "release is not broken"; fi
git -C "$TMP/origin_src" add -A && git -C "$TMP/origin_src" commit --quiet -m "broken release"

if do_update >"$TMP/update2.log" 2>&1; then
    fail "do_update reported success on a broken payload"
else
    pass "do_update reported failure on a broken payload"
fi
if grep -q "does not parse" "$TMP/update2.log"; then pass "the parse error is named"; else fail "no parse error reported: $(tail -6 "$TMP/update2.log")"; fi
if grep -qi "rolling back" "$TMP/update2.log"; then fail "a rollback happened — the release should have been refused earlier"; else pass "no rollback needed (install was never touched)"; fi
check "service was not restarted" "$svc_pid" "$(bg_pid || echo none)"
check "version on disk is unchanged" "$ver_before" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/app/package.json" | head -n1)"
if wait_health; then pass "old version keeps serving (zero downtime)"; else fail "app went down while refusing the release"; fi

echo "== 4b. rollback path: a release that passes validation but dies on start =="
# repair the source and publish a good release
python3 - "$TMP/origin_src/src/index.js" <<'PYFIX'
import sys
p = sys.argv[1]
s = open(p).read().replace("; await brokenSyntaxHere(", "")
open(p, "w").write(s)
PYFIX
if node --check "$TMP/origin_src/src/index.js" >/dev/null 2>&1; then pass "good release prepared"; else fail "could not repair the source tree"; fi
git -C "$TMP/origin_src" add -A && git -C "$TMP/origin_src" commit --quiet -m "fix: repair release"

# the release itself is fine, but the first health check after the swap fails
orig_health="$(declare -f health_check)"
eval "health_check__real${orig_health#health_check}"
FAIL_HEALTH=1
health_check() { if (( FAIL_HEALTH > 0 )); then FAIL_HEALTH=$((FAIL_HEALTH - 1)); return 1; fi; health_check__real "$@"; }
if do_update >"$TMP/update3.log" 2>&1; then fail "update reported success although the service never came up"; else pass "update reported failure"; fi
eval "$orig_health"

if grep -q "did not come up after the update" "$TMP/update3.log"; then pass "start failure detected"; else fail "no start failure reported: $(tail -6 "$TMP/update3.log")"; fi
if grep -q "rolling back" "$TMP/update3.log"; then pass "rollback was attempted"; else fail "no rollback: $(tail -8 "$TMP/update3.log")"; fi
if grep -q "rolled back — the previous version is running again" "$TMP/update3.log"; then pass "rollback brought the old version back"; else fail "rollback did not recover"; fi
check "rolled back to the previous version" "$ver_before" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/app/package.json" | head -n1)"
if node --check "$TMP/app/src/index.js" >/dev/null 2>&1; then pass "rolled-back tree parses"; else fail "tree left broken after rollback"; fi
if wait_health; then pass "app is serving after rollback"; else fail "app is down after rollback"; fi
if grep -q "profile-data" "$TMP/app/data/mirage.db" 2>/dev/null; then pass "profile data survived the rollback"; else fail "profile data lost during rollback"; fi

echo "== 4c. pre-flight: a checkout that is ahead of origin is caught =="
git -C "$TMP/app" config user.email t@t; git -C "$TMP/app" config user.name t
echo "local patch" >>"$TMP/app/src/util.js"
git -C "$TMP/app" add -A && git -C "$TMP/app" commit --quiet -m "local hotfix"
if do_update >"$TMP/update4.log" 2>&1; then
    fail "do_update proceeded although it cannot fast-forward"
else
    pass "do_update refused an un-fast-forwardable checkout"
fi
if grep -q "ahead of origin" "$TMP/update4.log"; then pass "reason mentions commits ahead"; else fail "no 'ahead' hint: $(tail -6 "$TMP/update4.log")"; fi
git -C "$TMP/app" reset --hard --quiet origin/main

echo "== 4d. pre-flight: a dirty working tree is a warning, not a blocker =="
python3 - "$TMP/origin_src/package.json" <<'PYVER'
import json, sys
p = sys.argv[1]
d = json.load(open(p)); d["version"] = "9.9.10"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PYVER
git -C "$TMP/origin_src" add -A && git -C "$TMP/origin_src" commit --quiet -m "release 9.9.10"
echo "scratch" >"$TMP/app/scratch.txt"          # untracked file: a pull still works
if do_update >"$TMP/update5.log" 2>&1; then pass "update went through with a dirty tree"; else fail "update failed on a dirty tree: $(tail -6 "$TMP/update5.log")"; fi
if grep -q "local changes in the tree" "$TMP/update5.log"; then pass "dirty tree was reported as a warning"; else fail "dirty tree not mentioned"; fi
check "new release applied" "9.9.10" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/app/package.json" | head -n1)"
check "the untracked file was kept" "yes" "$([[ -f "$TMP/app/scratch.txt" ]] && echo yes || echo no)"
rm -f "$TMP/app/scratch.txt"
if wait_health; then pass "service is serving after the update"; else fail "service is down"; fi

echo "== 4e. pre-flight reports a clean bill of health =="
APP_DIR_ENV=""; APP_DIR="$TMP/app"
if preflight_update >"$TMP/preflight.log" 2>&1; then pass "preflight passes on a healthy install"; else fail "preflight failed: $(grep 'x' /dev/null; grep -F '✗' "$TMP/preflight.log" | head -3)"; fi
if grep -qF '✓' "$TMP/preflight.log"; then pass "checks are reported individually"; else fail "no individual checks printed"; fi
if grep -q "service user" "$TMP/preflight.log"; then pass "service user is verified"; else fail "service user not checked"; fi
if grep -q "already at origin" "$TMP/preflight.log"; then pass "up-to-date state is reported"; else fail "up-to-date state not reported"; fi

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
