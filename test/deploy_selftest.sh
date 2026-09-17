#!/usr/bin/env bash
# Smoke tests for deploy.sh discovery/adoption logic.
# Runs as an unprivileged user: no systemd, no root, no real installation needed —
# every system path is redirected into a temporary mock root.
#
#   bash test/deploy_selftest.sh
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY="$HERE/../deploy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '\033[32m  ok\033[0m %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf '\033[31mFAIL\033[0m %s\n' "$*"; }
check() { # DESCRIPTION EXPECTED ACTUAL
    if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}

# ----------------------------------------------------------------- mock system
mkdir -p "$TMP/units" "$TMP/etc/mirage" "$TMP/opt/mirage" "$TMP/srv/web/mirage-1.4" \
         "$TMP/home/bob/antidetect-kit" "$TMP/naive/mirage" "$TMP/not-mirage"

make_app() { # DIR [PORT]
    local d="$1" port="${2:-7788}"
    mkdir -p "$d/src/browser" "$d/public"
    : >"$d/src/index.js"
    : >"$d/src/api.js"
    : >"$d/src/browser/manager.js"
    echo '<html></html>' >"$d/public/index.html"
    cat >"$d/package.json" <<EOF
{
  "name": "mirage",
  "version": "1.0.0",
  "description": "Mirage — web-based anti-detect browser",
  "type": "module",
  "main": "src/index.js"
}
EOF
}

make_foreign_app() { # DIR — a Mirage-shaped dir that is NOT mirage (decoy)
    mkdir -p "$1/src/browser" "$1/public"
    echo 'console.log(1)' >"$1/src/index.js"
    cat >"$1/package.json" <<'EOF'
{ "name": "unrelated-service", "version": "0.1.0", "description": "some other web app" }
EOF
}

make_app "$TMP/opt/mirage" 7788
make_app "$TMP/srv/web/mirage-1.4" 8899
make_app "$TMP/home/bob/antidetect-kit" 9000
make_app "$TMP/naive/mirage" 9100
make_foreign_app "$TMP/not-mirage"
echo '{"name":"totally-not-mirage"}' >"$TMP/not-mirage/package.json"

# ------------------------------------------------------------------ harness
MOCK_STATE="$TMP/etc/mirage/install.conf"
export MIRAGE_UNIT_DIRS="$TMP/units"
export MIRAGE_STATE_FILE="$MOCK_STATE"
export MIRAGE_STATE_DIR="$TMP/etc/mirage"
export MIRAGE_NO_SUDO=1
export MIRAGE_SEARCH_ROOTS="$TMP"
export MIRAGE_SEARCH_DEPTH=6
SELF_DIR_PARENT="$(dirname "$SELF_DIR")"
export MIRAGE_COMMON_DIRS=""
export MIRAGE_EXTRA_DIRS=""
export MIRAGE_ASSUME_YES=0
export MIRAGE_KEEP_BACKUPS=3

# shellcheck source=../deploy.sh
source "$DEPLOY"

reset_env() {
    APP_DIR_ENV=""; APP_USER_ENV=""; PORT_ENV=""; DOMAIN_ENV=""
    SERVICE_NAME_ENV=""; NODE_BIN_ENV=""; CHROME_BIN_ENV=""
    MIRAGE_NO_FS_SCAN=0
    APP_DIR=""; APP_USER=""; PORT=""; DOMAIN=""; SERVICE_NAME=""; SERVICE_UNIT=""
    NODE_BIN=""; CHROME=""; DATA_DIR=""; NGINX_CONF=""
    INSTALLED=0; DISCOVERY_SOURCE=""; DISCOVERY_LOG=(); TRY_DIR=""
}

echo "== recognition =="
check "mirage_score real tree"      "10" "$(mirage_score "$TMP/opt/mirage")"
check "foreign app score below threshold" "2" "$(mirage_score "$TMP/not-mirage")"
if is_mirage_dir "$TMP/not-mirage"; then fail "decoy dir wrongly accepted"; else pass "decoy dir rejected"; fi
if is_mirage_dir "$TMP/opt/mirage"; then pass "real tree accepted"; else fail "real tree not accepted"; fi
if is_mirage_dir "/nonexistent/whatever"; then fail "missing dir accepted"; else pass "missing dir rejected"; fi

echo "== discovery: explicit APP_DIR =="
reset_env
APP_DIR_ENV="$TMP/srv/web/mirage-1.4"
d=""; find_mirage_dir && d="$FOUND_DIR"
check "explicit dir found" "$TMP/srv/web/mirage-1.4" "$d"
check "source label" "explicit APP_DIR" "$DISCOVERY_SOURCE"

echo "== discovery: state file =="
reset_env
cat >"$MOCK_STATE" <<EOF
MIRAGE_APP_DIR="$TMP/home/bob/antidetect-kit"
MIRAGE_APP_USER="bob"
MIRAGE_PORT="9001"
MIRAGE_DOMAIN="mirage.hata"
MIRAGE_SERVICE="mirage-alt.service"
MIRAGE_NODE_BIN="/usr/local/bin/node"
EOF
d=""; find_mirage_dir && d="$FOUND_DIR"
check "state dir found" "$TMP/home/bob/antidetect-kit" "$d"
resolve_installation
check "user from state"   "bob"          "$APP_USER"
check "port from state"   "9001"         "$PORT"
check "domain from state" "mirage.hata"  "$DOMAIN"
check "unit from state"   "mirage-alt.service" "$SERVICE_NAME"
check "installed flag"    "1"            "$INSTALLED"

echo "== discovery: systemd unit only =="
reset_env; rm -f "$MOCK_STATE"
cat >"$TMP/units/mirage-custom.service" <<EOF
[Unit]
Description=Mirage anti-detect browser
[Service]
User=srvuser
WorkingDirectory=$TMP/srv/web/mirage-1.4
Environment=PORT=8899
ExecStart=/usr/local/bin/node $TMP/srv/web/mirage-1.4/src/index.js
[Install]
WantedBy=multi-user.target
EOF
d=""; find_mirage_dir && d="$FOUND_DIR"
check "unit dir discovered" "$TMP/srv/web/mirage-1.4" "$d"
resolve_installation
check "unit file picked up" "$TMP/units/mirage-custom.service" "$SERVICE_UNIT"
check "unit name"    "mirage-custom.service" "$SERVICE_NAME"
check "user from unit"   "srvuser" "$APP_USER"
check "port from unit"   "8899"    "$PORT"
check "node from unit"   "/usr/local/bin/node" "$NODE_BIN"
check "domain falls back to default" "$DEFAULT_DOMAIN" "$DOMAIN"

echo "== discovery: scan finds a renamed unit =="
reset_env
cat >"$TMP/units/gateway.service" <<EOF
[Service]
ExecStart=/usr/bin/node $TMP/srv/web/mirage-1.4/src/index.js
EOF
mv "$TMP/units/mirage-custom.service" "$TMP/units/gateway.service"
check "unit path from ExecStart" "$TMP/srv/web/mirage-1.4" "$(unit_exec_dir "$TMP/units/gateway.service")"
d=""; find_mirage_dir && d="$FOUND_DIR"
check "found via generic unit scan" "$TMP/srv/web/mirage-1.4" "$d"

echo "== discovery: filesystem walk (dir not in known locations) =="
reset_env; rm -f "$TMP/units/"*.service
mkdir -p "$TMP/phase-walk/naive" && make_app "$TMP/phase-walk/naive/mirage" 9100
mkdir -p "$TMP/phase-walk/opt/mirage" && make_app "$TMP/phase-walk/opt/mirage" 9200
export MIRAGE_SEARCH_ROOTS="$TMP/phase-walk"; export MIRAGE_COMMON_DIRS=""
d=""; find_mirage_dir && d="$FOUND_DIR"
check "found by dir name" "$TMP/phase-walk/naive/mirage" "$d"
case "$DISCOVERY_SOURCE" in *"filesystem scan (dirname)"*) pass "source = dirname scan";;
    *) fail "unexpected source: $DISCOVERY_SOURCE";; esac

echo "== discovery: payload scan (dirname does not contain 'mirage') =="
reset_env
mkdir -p "$TMP/phase-payload/antidetect-kit" && make_app "$TMP/phase-payload/antidetect-kit" 9300
export MIRAGE_SEARCH_ROOTS="$TMP/phase-payload"
d=""; find_mirage_dir && d="$FOUND_DIR"
check "found by package.json marker" "$TMP/phase-payload/antidetect-kit" "$d"
case "$DISCOVERY_SOURCE" in *"payload"*) pass "source = payload scan";;
    *) fail "unexpected source: $DISCOVERY_SOURCE";; esac

echo "== discovery: nothing found =="
reset_env
mkdir -p "$TMP/phase-empty"
export MIRAGE_SEARCH_ROOTS="$TMP/phase-empty"
if find_mirage_dir; then fail "phantom install found: $FOUND_DIR"
else pass "failure reported when nothing exists"; fi
resolve_installation
check "installed flag stays 0" "0" "$INSTALLED"
check "falls back to default dir" "$DEFAULT_APP_DIR" "$APP_DIR"

echo "== explicit override must win =="
reset_env
mkdir -p "$TMP/phase-explicit/explicit-mirage" && make_app "$TMP/phase-explicit/explicit-mirage" 7000
APP_DIR_ENV="$TMP/phase-explicit/explicit-mirage"
export MIRAGE_SEARCH_ROOTS="$TMP/phase-walk"
d=""; find_mirage_dir && d="$FOUND_DIR"
check "custom dir honoured" "$TMP/phase-explicit/explicit-mirage" "$d"
check "source label" "explicit APP_DIR" "$DISCOVERY_SOURCE"
# a real install would have left a marker behind — write one, then move the tree
APP_DIR="$TMP/phase-explicit/explicit-mirage"; APP_USER="svc"; PORT="7000"
DOMAIN="mirage.test"; SERVICE_NAME="mirage.service"; NODE_BIN="/usr/local/bin/node"
write_marker
reset_env

echo "== rejected candidates are explained =="
reset_env
mkdir -p "$TMP/phase-decoy/decoy" && make_foreign_app "$TMP/phase-decoy/decoy/mirage"
export MIRAGE_SEARCH_ROOTS="$TMP/phase-decoy"
export MIRAGE_COMMON_DIRS="$TMP/phase-decoy/decoy/mirage"
if find_mirage_dir; then fail "decoy adopted: $FOUND_DIR"; else pass "decoy not adopted"; fi
log_hit=0
for l in "${DISCOVERY_LOG[@]:-}"; do [[ "$l" == *"$TMP/phase-decoy/decoy/mirage"* ]] && log_hit=1; done
check "decoy logged as rejected" "1" "$log_hit"
export MIRAGE_COMMON_DIRS=""

echo "== source checkout is never adopted implicitly =="
reset_env
export MIRAGE_SEARCH_ROOTS="$SELF_DIR_PARENT"
check "SELF_DIR detected as a Mirage tree" "yes" "$(is_mirage_dir "$SELF_DIR" && echo yes || echo no)"
if find_mirage_dir; then fail "adopted its own checkout: $FOUND_DIR"; else pass "own checkout not adopted"; fi
log_hit=0
for l in "${DISCOVERY_LOG[@]:-}"; do [[ "$l" == *"directory the script was run from"* ]] && log_hit=1; done
check "own checkout explained in the log" "1" "$log_hit"
APP_DIR_ENV="$SELF_DIR"
d=""; find_mirage_dir && d="$FOUND_DIR"
check "explicit self-dir still works" "$SELF_DIR" "$d"

echo "== marker / state writers are parseable =="
reset_env; rm -f "$MOCK_STATE"
# simulate an operator moving the tree to another machine/path
mv "$TMP/phase-explicit/explicit-mirage" "$TMP/phase-explicit/relocated"
check "marker survived the move" "yes" "$([[ -f "$TMP/phase-explicit/relocated/.mirage-install" ]] && echo yes || echo no)"
check "stale marker still names the old path" "$TMP/phase-explicit/explicit-mirage" "$(marker_get "$TMP/phase-explicit/relocated" app_dir)"
APP_DIR="$TMP/phase-explicit/relocated"; APP_USER="mirageuser"; PORT="7788"
DOMAIN="mirage.local"; SERVICE_NAME="mirage.service"; NODE_BIN="/usr/local/bin/node"
write_marker   # the next install/update rewrites the marker in place
check "marker self-heals on the next run" "$TMP/phase-explicit/relocated" "$(marker_get "$APP_DIR" app_dir)"
check "marker port"   "7788"        "$(marker_get "$APP_DIR" port)"
check "marker domain" "mirage.local" "$(marker_get "$APP_DIR" domain)"
write_state
check "state app dir" "$TMP/phase-explicit/relocated" "$(state_get MIRAGE_APP_DIR)"
check "state user"    "mirageuser"            "$(state_get MIRAGE_APP_USER)"
check "state service" "mirage.service"        "$(state_get MIRAGE_SERVICE)"

echo "== detection of foreign payloads is refused =="
reset_env
if payload_ok="$(is_mirage_dir "$TMP/decoy/mirage" && echo yes || echo no)"; then :; fi
check "decoy refused" "no" "$payload_ok"

echo "== missing-installation guidance =="
reset_env
EMPTY_ROOT="$TMP/nowhere"
mkdir -p "$EMPTY_ROOT"
out="$(MIRAGE_SEARCH_ROOTS="$EMPTY_ROOT" MIRAGE_STATE_FILE="$EMPTY_ROOT/none.conf" \
       MIRAGE_UNIT_DIRS="$EMPTY_ROOT/units" MIRAGE_COMMON_DIRS="$EMPTY_ROOT/none" \
       bash "$DEPLOY" --status 2>&1 || true)"
if [[ "$out" == *"no Mirage installation detected"* ]]; then pass "--status reports a clean machine"; else fail "--status output unexpected: $out"; fi
if [[ "$out" == *"root is required"* ]]; then fail "--status hit the root guard (must work unprivileged)"; else pass "--status needs no root"; fi
if [[ "$out" == *"--app-dir"* ]]; then pass "--status suggests --app-dir"; else fail "--status does not suggest --app-dir"; fi

reset_env
DISCOVERY_LOG=("rejected $TMP/decoy/mirage (from filesystem scan — not a Mirage tree)")
out="$(explain_not_found 2>&1 || true)"
[[ "$out" == *"installation directory was not found"* ]] && pass "not-found message" || fail "not-found message missing"
[[ "$out" == *"state file"* && "$out" == *"systemd units"* && "$out" == *"filesystem walk"* ]] \
    && pass "not-found lists the search order" || fail "search order not listed"
[[ "$out" == *"--app-dir /path/to/mirage"* ]] && pass "not-found suggests --app-dir" || fail "--app-dir hint missing"
[[ "$out" == *"rejected $TMP/decoy/mirage"* ]] && pass "not-found explains rejected candidates" || fail "rejected candidates not shown"
[[ "$out" == *"sits inside a Mirage tree"* ]] && pass "not-found hints at the script's own tree" || fail "self-tree hint missing"

echo "== CLI surface =="
if bash "$DEPLOY" --help >/dev/null 2>&1; then pass "--help exits 0"; else fail "--help failed"; fi
if bash "$DEPLOY" --bogus >/dev/null 2>&1; then fail "unknown flag accepted"; else pass "unknown flag rejected"; fi
export MIRAGE_SEARCH_ROOTS="$TMP" MIRAGE_STATE_FILE="$MOCK_STATE" MIRAGE_UNIT_DIRS="$TMP/units"
out="$(bash "$DEPLOY" --status 2>&1 || true)"
if [[ "$out" == *"installation found"* ]]; then pass "--status detects the mock install"; else fail "--status missed the install: $out"; fi
out="$(bash "$DEPLOY" --find 2>&1 || true)"
[[ "$out" == *"installation found"* ]] && pass "--find alias works" || fail "--find alias broken"
out="$(MIRAGE_NO_SUDO=1 bash "$DEPLOY" --uninstall 2>&1 || true)"
[[ "$out" == *"root is required"* ]] && pass "uninstall needs root (guarded)" || fail "uninstall root guard missing"

echo "== non-root guard =="
out="$(MIRAGE_NO_SUDO=1 bash "$DEPLOY" --update 2>&1 || true)"
if [[ "$out" == *"root is required"* ]]; then pass "refuses to run as non-root"; else fail "no root guard: $out"; fi

echo
printf 'deploy.sh selftest: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
