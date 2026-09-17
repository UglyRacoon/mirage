#!/usr/bin/env bash
# =============================================================================
#  Mirage — adaptive install / update / uninstall manager for Linux
# =============================================================================
#  Usage:
#    sudo ./deploy.sh                 # interactive menu (default)
#    sudo ./deploy.sh --install       # install or repair an existing tree
#    sudo ./deploy.sh --update        # update the installation wherever it is
#    sudo ./deploy.sh --uninstall     # remove service/unit/vhost (+ keep data)
#    sudo ./deploy.sh --status        # diagnostics: what was detected and how
#
#  Why this script is "adaptive":
#    * It never assumes /opt/mirage.  The installation directory is discovered:
#        0. explicit APP_DIR / --app-dir
#        1. state file            (/etc/mirage/install.conf, written on install)
#        2. systemd units         (ExecStart / WorkingDirectory, any unit name)
#        3. running processes     (/proc/<pid>/cwd of node src/index.js)
#        4. common directories    (/opt, /srv, /var/www, /usr/local, /root, /home/*…)
#        5. locate(1) index       (if installed)
#        6. filesystem walk       (dirs named *mirage*, then package.json markers)
#    * Related facts are discovered the same way: user, port, domain, service
#      unit name, node binary, chromium binary, nginx vhost, data dir.
#    * Operations degrade gracefully: service stopped, unit renamed/missing,
#      no systemd (container), no nginx, no npm, node outside $PATH.
#    * Update makes a rotating backup and rolls back if the app fails to boot.
#
#  Everything is overridable by env var or CLI flag, e.g.:
#    APP_DIR=/home/me/mirage PORT=8080 sudo ./deploy.sh --update
#    sudo ./deploy.sh --update --app-dir /srv/apps/mirage --fast
# =============================================================================
set -euo pipefail

# ------------------------------------------------------------------ settings
SELF="${BASH_SOURCE[0]}"
SELF_DIR="$(cd -- "$(dirname -- "$SELF")" >/dev/null 2>&1 && pwd -P)"

DEFAULT_APP_DIR="${MIRAGE_DEFAULT_APP_DIR:-/opt/mirage}"
DEFAULT_APP_USER="mirage"
DEFAULT_PORT="7788"
DEFAULT_DOMAIN="mirage.local"
DEFAULT_SERVICE="mirage.service"

STATE_DIR="${MIRAGE_STATE_DIR:-/etc/mirage}"
STATE_FILE="${MIRAGE_STATE_FILE:-$STATE_DIR/install.conf}"
MARKER_FILE=".mirage-install"
KEEP_BACKUPS="${MIRAGE_KEEP_BACKUPS:-5}"

# Explicit user overrides (env or flags). Empty = "discover it".
APP_DIR_ENV="${APP_DIR:-}"
APP_USER_ENV="${APP_USER:-}"
PORT_ENV="${PORT:-}"
DOMAIN_ENV="${DOMAIN:-}"
SERVICE_NAME_ENV="${SERVICE_NAME:-}"
NODE_BIN_ENV="${NODE_BIN:-}"
CHROME_BIN_ENV="${CHROME_BIN:-}"
REPO="${REPO:-}"
BRANCH_ENV="${BRANCH:-${REPO_BRANCH:-}}"    # branch/tag to update from (empty = the checkout's own)
FORCE="${MIRAGE_FORCE:-0}"
PURGE_DATA=0
SET_HOSTS="${SET_HOSTS:-1}"
BACKUP_ROOT="${BACKUP_ROOT:-}"

# Resolved installation facts (filled by resolve_installation()).
APP_DIR=""
APP_USER=""
PORT=""
DOMAIN=""
SERVICE_NAME=""
SERVICE_UNIT=""
NODE_BIN=""
CHROME=""
DATA_DIR=""
NGINX_CONF=""
INSTALLED=0
DISCOVERY_SOURCE=""
DISCOVERY_LOG=()
FOUND_DIR=""
TRY_DIR=""
TRY_SOURCE=""
MIRAGE_QUIET=0
BACKUP_DIR=""
ORIG_ARGS=()

# ------------------------------------------------------------------ output
if [[ -t 1 && "${NO_COLOR:-}" == "" ]]; then
    C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
    C_RED=$'\033[31m';  C_DIM=$'\033[2m';   C_OFF=$'\033[0m'
else
    C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_OFF=""
fi
say()  { printf '%s[mirage]%s %s\n' "$C_CYAN" "$C_OFF" "$*"; }
ok()   { printf '%s[ok]%s %s\n'     "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s[warn]%s %s\n'   "$C_YELLOW" "$C_OFF" "$*" >&2; }
err()  { printf '%s[error]%s %s\n'  "$C_RED" "$C_OFF" "$*" >&2; }
die()  { err "$*"; exit 1; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }

have() { command -v "$1" >/dev/null 2>&1; }

run_timeout() { # SECONDS CMD...
    local t="$1"; shift
    if have timeout; then timeout "$t" "$@"; else "$@"; fi
}

confirm() { # PROMPT [yes|no]
    local prompt="$1" def="${2:-yes}" a=""
    if [[ "${MIRAGE_ASSUME_YES:-0}" == 1 ]]; then
        say "$prompt → yes (assume-yes)"
        return 0
    fi
    if [[ ! -t 0 ]]; then
        warn "$prompt → '$def' (non-interactive stdin)"
        [[ "$def" == yes ]]
        return
    fi
    local hint="[Y/n]"; [[ "$def" == no ]] && hint="[y/N]"
    read -r -p "$prompt $hint " a || a=""
    a="${a,,}"
    case "$a" in
        y|yes|д|да) return 0 ;;
        n|no|н|нет) return 1 ;;
        "") [[ "$def" == yes ]] ;;
        *)  [[ "$def" == yes ]] ;;
    esac
}

pause() {
    [[ -t 0 ]] || return 0
    read -r -p "Press Enter to continue..." _ || true
}

usage() {
    cat <<'USAGE'
Mirage deployment manager (adaptive install / update / uninstall)

Usage: sudo ./deploy.sh [ACTION] [OPTIONS]

Actions:
  -i, --install          install (or repair) Mirage on this machine
  -u, --update           update the detected installation (auto-discovery)
  -U, --uninstall        stop & remove the service, unit, vhost (keeps data)
  -s, --status           show what was detected, where, and from which source
  -d, --doctor           status + pre-flight diagnostics (no changes made)
  -m, --menu             interactive menu (default when run in a terminal)
  -h, --help             this help

Options:
      --app-dir DIR      force the installation directory (skips discovery)
      --user NAME        system user that runs the service
      --port N           application port                     (default 7788)
      --domain NAME      nginx server_name / /etc/hosts entry (default mirage.local)
      --service NAME     systemd unit name                    (default mirage)
      --repo URL         git repository used by install/update
      --branch NAME      branch or tag to update from (default: the checkout's own)
      --no-hosts         do not touch /etc/hosts
      --fast             skip the (slow) filesystem walk during discovery
      --skip-smoke       do not test-launch the new release before applying it
      --offline          do not touch the network (no git fetch/ls-remote)
      --force            install even if an existing tree was detected
      --purge-data       uninstall also deletes profile data (no backup kept)
  -y, --yes              assume "yes" for confirmations (non-interactive)
      --no-sudo          never re-exec through sudo

Env overrides: APP_DIR APP_USER PORT DOMAIN SERVICE_NAME REPO BRANCH NODE_BIN CHROME_BIN
               DATA_DIR MIRAGE_STATE_FILE MIRAGE_KEEP_BACKUPS BACKUP_ROOT
               MIRAGE_EXTRA_DIRS MIRAGE_SEARCH_ROOTS MIRAGE_SEARCH_DEPTH
               MIRAGE_SCAN_TIMEOUT MIRAGE_NO_FS_SCAN MIRAGE_ASSUME_YES

Examples:
  sudo ./deploy.sh --update                      # any install location
  sudo ./deploy.sh --update --branch release-2   # update from another branch/tag
  sudo ./deploy.sh --update --app-dir /srv/mirage
  APP_DIR=/home/me/mirage ./deploy.sh --status
USAGE
}

# =============================================================================
#  Mirage recognition
# =============================================================================

# Prints a confidence score (0 = not Mirage at all, higher = more certain).
mirage_score() {
    local d="${1%/}" score=0 pj
    [[ -n "$d" && -d "$d" ]] || return 1
    [[ -f "$d/src/index.js" ]] || return 1
    score=1
    pj="$d/package.json"
    if [[ -f "$pj" ]]; then
        score=$((score + 1))
        grep -qE '"name"[[:space:]]*:[[:space:]]*"mirage"' "$pj" 2>/dev/null && score=$((score + 3))
        grep -qiE 'anti-?detect' "$pj" 2>/dev/null && score=$((score + 2))
    fi
    [[ -f "$d/public/index.html" ]]        && score=$((score + 1))
    [[ -f "$d/src/browser/manager.js" ]]   && score=$((score + 1))
    [[ -f "$d/src/api.js" ]]               && score=$((score + 1))
    [[ -f "$d/$MARKER_FILE" ]]             && score=$((score + 6))
    printf '%s' "$score"
    return 0
}

is_mirage_dir() { # DIR [MIN_SCORE]
    local s
    s="$(mirage_score "${1:-}" 2>/dev/null || true)"
    [[ -n "$s" && "$s" -ge "${2:-3}" ]]
}

# ---------------------------------------------------------------- state file
state_get() {
    local k="$1" v=""
    [[ -f "$STATE_FILE" ]] || return 0
    v="$(sed -n "s/^${k}=\"\\(.*\\)\"\$/\1/p" "$STATE_FILE" 2>/dev/null | head -n1 || true)"
    printf '%s' "$v"
}

_state_sanitize() { printf '%s' "$1" | tr -d '"\\\n\r'; }

write_state() {
    mkdir -p "$STATE_DIR" 2>/dev/null || { warn "cannot create $STATE_DIR (state file not saved)"; return 0; }
    {
        printf '# Mirage install state — written by deploy.sh. Parsed, never sourced.\n'
        printf 'MIRAGE_STATE_VERSION="2"\n'
        printf 'MIRAGE_APP_DIR="%s"\n'      "$(_state_sanitize "$APP_DIR")"
        printf 'MIRAGE_APP_USER="%s"\n'     "$(_state_sanitize "$APP_USER")"
        printf 'MIRAGE_PORT="%s"\n'         "$(_state_sanitize "$PORT")"
        printf 'MIRAGE_DOMAIN="%s"\n'       "$(_state_sanitize "$DOMAIN")"
        printf 'MIRAGE_SERVICE="%s"\n'      "$(_state_sanitize "$SERVICE_NAME")"
        printf 'MIRAGE_NODE_BIN="%s"\n'     "$(_state_sanitize "${NODE_BIN:-}")"
        printf 'MIRAGE_CHROME_BIN="%s"\n'   "$(_state_sanitize "${CHROME:-}")"
        printf 'MIRAGE_DATA_DIR="%s"\n'     "$(_state_sanitize "${DATA_DIR:-}")"
        printf 'MIRAGE_REPO="%s"\n'         "$(_state_sanitize "${REPO:-}")"
        printf 'MIRAGE_GIT_REF="%s"\n'      "$(_state_sanitize "${GIT_REF:-}")"
        printf 'MIRAGE_INSTALLED_AT="%s"\n' "$(_state_sanitize "$(date -Is 2>/dev/null || date)")"
        printf 'MIRAGE_UPDATED_AT="%s"\n'   "$(_state_sanitize "$(date -Is 2>/dev/null || date)")"
    } >"$STATE_FILE" 2>/dev/null || warn "failed to write $STATE_FILE"
    return 0
}

write_marker() {
    [[ -n "${APP_DIR:-}" && -d "$APP_DIR" ]] || return 0
    {
        printf '# Mirage marker — lets deploy.sh recognise this tree after a move.\n'
        printf 'app_dir="%s"\n'  "$(_state_sanitize "$APP_DIR")"
        printf 'user="%s"\n'     "$(_state_sanitize "${APP_USER:-}")"
        printf 'port="%s"\n'     "$(_state_sanitize "${PORT:-}")"
        printf 'domain="%s"\n'   "$(_state_sanitize "${DOMAIN:-}")"
        printf 'service="%s"\n'  "$(_state_sanitize "${SERVICE_NAME:-}")"
        printf 'date="%s"\n'     "$(_state_sanitize "$(date -Is 2>/dev/null || date)")"
    } >"$APP_DIR/$MARKER_FILE" 2>/dev/null || true
    return 0
}

marker_get() { # DIR KEY
    local f="${1%/}/$MARKER_FILE" k="$2"
    [[ -f "$f" ]] || return 0
    sed -n "s/^${k}=\"\\(.*\\)\"\$/\1/p" "$f" 2>/dev/null | head -n1 || true
}

# ------------------------------------------------------------- unit discovery
unit_dirs() {
    if [[ -n "${MIRAGE_UNIT_DIRS:-}" ]]; then
        # shellcheck disable=SC2086
        printf '%s\n' ${MIRAGE_UNIT_DIRS}
    else
        printf '%s\n' /etc/systemd/system /run/systemd/system /usr/lib/systemd/system /lib/systemd/system
    fi
}

unit_candidates() {
    local d n
    while IFS= read -r d; do
        [[ -d "$d" ]] || continue
        for n in "$SERVICE_NAME_ENV" "${SERVICE_NAME_ENV%.service}.service" \
                 mirage.service mirage.target mirage-*.service; do
            [[ -n "$n" && -f "$d/$n" ]] && printf '%s\n' "$d/$n"
        done
        # content-based fallback: any unit that starts a Mirage-like app
        grep -lE '^ExecStart=.*(mirage|src/index\.js)' "$d"/*.service 2>/dev/null || true
    done < <(unit_dirs)
}

unit_field() { # FILE KEY
    local f="$1" k="$2"
    [[ -f "$f" ]] || return 0
    sed -n "s/^[[:space:]]*${k}=//p" "$f" 2>/dev/null | head -n1 || true
}

unit_exec_dir() { # extract APP_DIR from ExecStart=…/src/index.js
    local f="$1" line p=""
    line="$(unit_field "$f" ExecStart)"
    [[ -n "$line" ]] || return 0
    line="${line#-}"                        # optional '-' prefix (ignore-failure)
    # 1) quoted path — unambiguous: ExecStart=/usr/bin/node "/opt/my mirage/src/index.js"
    p="$(printf '%s\n' "$line" | grep -oE '"[^"]*src/index\.js"' | tail -n1 | tr -d '"' || true)"
    if [[ -z "$p" ]]; then
        # 2) backslash-escaped spaces: mask them so the path survives word splitting
        p="$(printf '%s\n' "$line" \
             | sed 's/\\ /@@SP@@/g' \
             | tr ' ' '\n' \
             | grep -E '/src/index\.js"?$' | tail -n1 | tr -d '"' || true)"
        p="${p//@@SP@@/ }"
    fi
    # 3) plain absolute path without spaces
    if [[ -z "$p" ]]; then
        p="$(printf '%s\n' "$line" | grep -oE '/[^[:space:]"]*/src/index\.js' | tail -n1 || true)"
    fi
    [[ -n "$p" ]] && dirname "$(dirname "$p")"
    return 0
}

unit_exec_node() { # first token of ExecStart if absolute path
    local f="$1" line n
    line="$(unit_field "$f" ExecStart)"
    n="$(printf '%s\n' "$line" | grep -oE '^/[^[:space:]]*/node' | head -n1 || true)"
    [[ -n "$n" ]] && printf '%s\n' "$n"
    return 0
}

unit_env_port() { # Environment=…PORT=7788…
    local f="$1"
    [[ -f "$f" ]] || return 0
    grep -oE 'PORT=[0-9]+' "$f" 2>/dev/null | head -n1 | cut -d= -f2 || true
}

find_unit_for_dir() { # DIR -> unit file path
    local want="${1%/}" u dir wd
    while IFS= read -r u; do
        [[ -n "$u" ]] || continue
        dir="$(unit_exec_dir "$u")"
        wd="$(unit_field "$u" WorkingDirectory)"
        wd="${wd%\"}"; wd="${wd#\"}"
        if [[ -n "$want" && ( "$dir" == "$want" || "${wd%/}" == "$want" ) ]]; then
            printf '%s\n' "$u"
            return 0
        fi
    done < <(unit_candidates)
    return 1
}

# ---------------------------------------------------------- process discovery
process_candidates() {
    local p cmd path cwd
    for p in /proc/[0-9]*; do
        [[ -r "$p/cmdline" ]] || continue
        cmd="$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null || true)"
        [[ "$cmd" == *"src/index.js"* ]] || continue
        path="$(printf '%s\n' "$cmd" | grep -oE '/[^ ]*/src/index\.js' | tail -n1 || true)"
        [[ -n "$path" ]] && dirname "$(dirname "$path")"
        cwd="$(readlink -f "$p/cwd" 2>/dev/null || true)"
        [[ -n "$cwd" ]] && printf '%s\n' "$cwd"
    done
    return 0
}

# ----------------------------------------------------------- known locations
common_dirs() {
    local d pat patterns=()
    if [[ -n "${MIRAGE_COMMON_DIRS:-}" ]]; then
        # shellcheck disable=SC2206
        patterns=(${MIRAGE_COMMON_DIRS})
    else
        patterns=(
            /opt/mirage /opt/mirage-* /opt/*/mirage /opt/apps/mirage
            /srv/mirage /srv/mirage-* /srv/www/mirage /srv/apps/mirage
            /var/www/mirage /var/www/html/mirage /var/www/mirage-*
            /var/lib/mirage /var/opt/mirage
            /usr/local/mirage /usr/local/share/mirage /usr/local/lib/mirage
            /usr/share/mirage /usr/lib/mirage
            /app /app/mirage /data/mirage /mnt/mirage /media/mirage
            /root/mirage /root/mirage-* /root/apps/mirage
            /home/*/mirage /home/*/mirage-* /home/*/apps/mirage /home/*/*/mirage
        )
    fi
    if [[ -n "${MIRAGE_EXTRA_DIRS:-}" ]]; then
        # shellcheck disable=SC2206
        patterns=(${MIRAGE_EXTRA_DIRS} "${patterns[@]}")
    fi
    for pat in "${patterns[@]}"; do
        # shellcheck disable=SC2086
        for d in $pat; do
            [[ -d "$d" ]] && printf '%s\n' "${d%/}"
        done
    done
    return 0
}

search_roots() {
    if [[ -n "${MIRAGE_SEARCH_ROOTS:-}" ]]; then
        # shellcheck disable=SC2086
        printf '%s\n' ${MIRAGE_SEARCH_ROOTS}
    else
        printf '%s\n' /opt /srv /var/www /usr/local /var/lib /root /home /data /app /mnt /media
    fi
}

# directories named *mirage*
fs_walk_dirs() {
    local r depth="${MIRAGE_SEARCH_DEPTH:-5}"
    while IFS= read -r r; do
        [[ -d "$r" ]] || continue
        run_timeout "${MIRAGE_SCAN_TIMEOUT:-45}" find "$r" -maxdepth "$depth" \
            \( -name node_modules -o -name .git -o -name .cache -o -name lost+found \
               -o -name proc -o -name sys -o -name snap \) -prune -o \
            -type d -iname '*mirage*' -print 2>/dev/null || true
    done < <(search_roots)
    return 0
}

# package.json files under the same roots (last-resort marker scan)
fs_walk_markers() {
    local r f count=0 max="${MIRAGE_SCAN_MAX_FILES:-4000}" depth="${MIRAGE_SEARCH_DEPTH:-5}"
    while IFS= read -r r; do
        [[ -d "$r" ]] || continue
        while IFS= read -r f; do
            count=$((count + 1))
            if (( count > max )); then return 0; fi
            printf '%s\n' "$f"
        done < <(run_timeout "${MIRAGE_SCAN_TIMEOUT:-45}" find "$r" -maxdepth "$depth" \
                    \( -name node_modules -o -name .git -o -name proc -o -name sys \
                       -o -name lost+found -o -name .cache \) -prune -o \
                    -type f -name 'package.json' -print 2>/dev/null || true)
    done < <(search_roots)
    return 0
}

locate_candidates() {
    have locate || return 0
    { locate -e -- '*/mirage/package.json' 2>/dev/null \
        || locate 'mirage' 2>/dev/null | grep -E '/package\.json$' \
        || true; } | head -n 40 || true
    return 0
}

# ------------------------------------------------------------------ resolution
try_dirs() { # SOURCE MIN_SCORE DIR...
    local src="$1" min="$2"; shift 2
    local d
    for d in "$@"; do
        d="${d%/}"
        [[ -n "$d" && -d "$d" ]] || continue
        # a source checkout used to run the script is not "the installation":
        # never adopt it implicitly, only via an explicit APP_DIR/--app-dir.
        if [[ "$d" == "$SELF_DIR" && "$src" != "explicit APP_DIR" ]]; then
            DISCOVERY_LOG+=("skipped $d  (this is the directory the script was run from, not an installation)")
            continue
        fi
        if is_mirage_dir "$d" "$min"; then
            TRY_DIR="$d"; TRY_SOURCE="$src"
            return 0
        fi
        DISCOVERY_LOG+=("rejected $d  (from $src — not a Mirage tree)")
    done
    TRY_DIR=""
    return 1
}

# Locates the installation directory. Returns 0 and sets FOUND_DIR when found;
# returns 1 with FOUND_DIR empty otherwise. Never call this through $( ) — the
# discovery diagnostics (DISCOVERY_SOURCE/DISCOVERY_LOG) live in the caller's shell.
find_mirage_dir() {
    DISCOVERY_LOG=(); DISCOVERY_SOURCE=""
    local -a cands=()
    local d

    # 0 — explicit override (env APP_DIR / --app-dir)
    if [[ -n "$APP_DIR_ENV" ]]; then
        if is_mirage_dir "$APP_DIR_ENV"; then
            DISCOVERY_SOURCE="explicit APP_DIR"
            FOUND_DIR="${APP_DIR_ENV%/}"; return 0
        fi
        DISCOVERY_LOG+=("APP_DIR=$APP_DIR_ENV does not look like a Mirage tree — searching anyway")
    fi

    # 1 — state file written by a previous run
    d="$(state_get MIRAGE_APP_DIR)"
    try_dirs "state file $STATE_FILE" 3 "$d" && { DISCOVERY_SOURCE="$TRY_SOURCE"; FOUND_DIR="$TRY_DIR"; return 0; }

    # 2 — systemd units (any name, any directory)
    cands=()
    while IFS= read -r u; do
        [[ -n "$u" ]] || continue
        d="$(unit_exec_dir "$u")";      [[ -n "$d" ]] && cands+=("$d")
        d="$(unit_field "$u" WorkingDirectory)"; d="${d%\"}"; d="${d#\"}"; [[ -n "$d" ]] && cands+=("$d")
    done < <(unit_candidates)
    if (( ${#cands[@]} )); then
        try_dirs "systemd unit" 3 "${cands[@]}" && { DISCOVERY_SOURCE="$TRY_SOURCE"; FOUND_DIR="$TRY_DIR"; return 0; }
    fi

    # 3 — running process (cwd / command line of node …/src/index.js)
    cands=()
    while IFS= read -r d; do [[ -n "$d" ]] && cands+=("$d"); done < <(process_candidates)
    if (( ${#cands[@]} )); then
        try_dirs "running process" 3 "${cands[@]}" && { DISCOVERY_SOURCE="$TRY_SOURCE"; FOUND_DIR="$TRY_DIR"; return 0; }
    fi

    # 4 — well-known directories
    cands=()
    while IFS= read -r d; do [[ -n "$d" ]] && cands+=("$d"); done < <(common_dirs)
    if (( ${#cands[@]} )); then
        try_dirs "known locations" 3 "${cands[@]}" && { DISCOVERY_SOURCE="$TRY_SOURCE"; FOUND_DIR="$TRY_DIR"; return 0; }
    fi

    if [[ "${MIRAGE_NO_FS_SCAN:-0}" == 1 || "${MIRAGE_FAST:-0}" == 1 ]]; then
        DISCOVERY_LOG+=("filesystem scan skipped (--fast)")
        return 1
    fi

    [[ "$MIRAGE_QUIET" == 1 ]] || say "Installation not found in the usual places — scanning the filesystem…" >&2

    # 5 — locate(1) index
    cands=()
    while IFS= read -r d; do [[ -n "$d" ]] && cands+=("$(dirname "$d")"); done < <(locate_candidates)
    if (( ${#cands[@]} )); then
        try_dirs "locate index" 3 "${cands[@]}" && { DISCOVERY_SOURCE="$TRY_SOURCE"; FOUND_DIR="$TRY_DIR"; return 0; }
    fi

    # 6a — directories called *mirage*
    cands=()
    while IFS= read -r d; do [[ -n "$d" ]] && cands+=("$d"); done < <(fs_walk_dirs)
    if (( ${#cands[@]} )); then
        try_dirs "filesystem scan (dirname)" 3 "${cands[@]}" && { DISCOVERY_SOURCE="$TRY_SOURCE"; FOUND_DIR="$TRY_DIR"; return 0; }
    fi

    # 6b — package.json markers (dir may have any name)
    cands=()
    while IFS= read -r d; do [[ -n "$d" ]] && cands+=("$(dirname "$d")"); done < <(fs_walk_markers)
    if (( ${#cands[@]} )); then
        try_dirs "filesystem scan (payload)" 5 "${cands[@]}" && { DISCOVERY_SOURCE="$TRY_SOURCE"; FOUND_DIR="$TRY_DIR"; return 0; }
    fi

    return 1
}

# ------------------------------------------------------- binaries / components
node_ok() { # is NODE >= 22.5 ?
    local n="${1:-}"
    [[ -n "$n" ]] || return 1
    if [[ "$n" == */* ]]; then
        [[ -x "$n" ]] || return 1
    else
        have "$n" || return 1
    fi
    "$n" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=5))?0:1)' 2>/dev/null
}

find_node_bin() {
    local n
    if [[ -n "$NODE_BIN_ENV" ]] && { [[ -x "$NODE_BIN_ENV" ]] || have "$NODE_BIN_ENV"; }; then
        printf '%s\n' "$NODE_BIN_ENV"; return 0
    fi
    for n in node /usr/bin/node /usr/local/bin/node /usr/local/node/bin/node /opt/node/bin/node /opt/nodejs/bin/node; do
        have "$n" && node_ok "$n" && { command -v "$n" 2>/dev/null || printf '%s\n' "$n"; return 0; }
    done
    for n in /root/.nvm/versions/node/*/bin/node /home/*/.nvm/versions/node/*/bin/node \
             /root/.local/share/fnm/node-versions/*/installation/bin/node \
             /root/.volta/bin/node; do
        if [[ -x "$n" ]] && node_ok "$n"; then printf '%s\n' "$n"; return 0; fi
    done
    # last resort: any node at all (installer will report the version)
    have node && { command -v node; return 0; }
    return 1
}

find_chromium_bin() {
    local c
    if [[ -n "$CHROME_BIN_ENV" ]] && [[ -x "$CHROME_BIN_ENV" || -n "$(command -v "$CHROME_BIN_ENV" 2>/dev/null || true)" ]]; then
        command -v "$CHROME_BIN_ENV" 2>/dev/null || printf '%s\n' "$CHROME_BIN_ENV"; return 0
    fi
    for c in chromium chromium-browser google-chrome google-chrome-stable chrome chromium-headless-shell headless_shell; do
        if have "$c"; then command -v "$c"; return 0; fi
    done
    for c in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome \
             /usr/bin/google-chrome-stable /opt/google/chrome/chrome /snap/bin/chromium \
             /usr/lib/chromium/chromium /usr/lib64/chromium-browser/chromium-browser; do
        [[ -x "$c" ]] && { printf '%s\n' "$c"; return 0; }
    done
    for c in /root/.cache/puppeteer/chrome/*/chrome-linux64/chrome \
             /home/*/.cache/puppeteer/chrome/*/chrome-linux64/chrome \
             /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome \
             /home/*/.cache/ms-playwright/chromium-*/chrome-linux/chrome; do
        [[ -x "$c" ]] && { printf '%s\n' "$c"; return 0; }
    done
    return 1
}

nginx_conf_for() { # PORT -> conf path
    local port="${1:-7788}" f
    for f in /etc/nginx/conf.d/mirage.conf /etc/nginx/sites-enabled/mirage /etc/nginx/sites-enabled/mirage.conf; do
        [[ -f "$f" ]] && { printf '%s\n' "$f"; return 0; }
    done
    if [[ -d /etc/nginx ]]; then
        f="$(grep -rlE "proxy_pass[[:space:]]+http://(127\.0\.0\.1|localhost):$port" /etc/nginx 2>/dev/null | head -n1 || true)"
        if [[ -n "$f" ]]; then printf '%s\n' "$f"; return 0; fi
    fi
    return 1
}

# Fills APP_DIR/APP_USER/PORT/DOMAIN/SERVICE_*/NODE_BIN/CHROME/DATA_DIR/NGINX_CONF.
resolve_installation() {
    local d u

    if find_mirage_dir; then
        APP_DIR="$FOUND_DIR"; INSTALLED=1
    else
        INSTALLED=0
        APP_DIR="${APP_DIR_ENV:-$DEFAULT_APP_DIR}"
    fi
    APP_DIR="${APP_DIR%/}"
    d="$FOUND_DIR"

    # A tree that contains this very script is only usable explicitly.
    if [[ -z "$d" && -z "$APP_DIR_ENV" ]] && is_mirage_dir "$SELF_DIR"; then
        DISCOVERY_LOG+=("script checkout: $SELF_DIR (pass APP_DIR=/--app-dir to target it explicitly)")
    fi

    # --- service unit -------------------------------------------------------
    SERVICE_UNIT=""
    if (( INSTALLED )) && u="$(find_unit_for_dir "$APP_DIR")"; then
        SERVICE_UNIT="$u"
    fi
    if [[ -z "$SERVICE_UNIT" ]]; then
        while IFS= read -r u; do
            [[ -n "$u" ]] || continue
            SERVICE_UNIT="$u"; break
        done < <(unit_candidates)
    fi
    SERVICE_NAME="$(state_get MIRAGE_SERVICE)"
    [[ -n "$SERVICE_NAME" ]] || SERVICE_NAME="$SERVICE_NAME_ENV"
    if [[ -n "$SERVICE_UNIT" ]]; then
        SERVICE_NAME="$(basename "$SERVICE_UNIT")"
    fi
    [[ -n "$SERVICE_NAME" ]] || SERVICE_NAME="$DEFAULT_SERVICE"

    # --- app user -----------------------------------------------------------
    APP_USER="$APP_USER_ENV"
    [[ -n "$APP_USER" ]] || APP_USER="$(state_get MIRAGE_APP_USER)"
    [[ -n "$APP_USER" ]] || APP_USER="$(unit_field "${SERVICE_UNIT:-}" User)"
    if [[ -z "$APP_USER" && -d "$APP_DIR" ]]; then
        d="$(stat -c %U "$APP_DIR" 2>/dev/null || true)"
        [[ -n "$d" && "$d" != "root" && "$d" != "UNKNOWN" ]] && APP_USER="$d"
    fi
    [[ -n "$APP_USER" ]] || APP_USER="$DEFAULT_APP_USER"

    # --- port ---------------------------------------------------------------
    PORT="$PORT_ENV"
    [[ -n "$PORT" ]] || PORT="$(state_get MIRAGE_PORT)"
    [[ -n "$PORT" ]] || PORT="$(unit_env_port "${SERVICE_UNIT:-}")"
    [[ -n "$PORT" ]] || PORT="$(marker_get "$APP_DIR" port)"
    [[ -n "$PORT" ]] || PORT="$DEFAULT_PORT"

    # --- domain -------------------------------------------------------------
    DOMAIN="$DOMAIN_ENV"
    [[ -n "$DOMAIN" ]] || DOMAIN="$(state_get MIRAGE_DOMAIN)"
    [[ -n "$DOMAIN" ]] || DOMAIN="$(marker_get "$APP_DIR" domain)"
    if [[ -z "$DOMAIN" ]]; then
        d="$(nginx_conf_for "$PORT" || true)"
        if [[ -n "$d" ]]; then
            DOMAIN="$(sed -n 's/^[[:space:]]*server_name[[:space:]]\+\([^;]*\);.*/\1/p' "$d" 2>/dev/null | head -n1 || true)"
            DOMAIN="${DOMAIN%% *}"
        fi
    fi
    [[ -n "$DOMAIN" ]] || DOMAIN="$DEFAULT_DOMAIN"

    # --- binaries -----------------------------------------------------------
    NODE_BIN="$(state_get MIRAGE_NODE_BIN)"
    [[ -n "$NODE_BIN" && ! -x "$NODE_BIN" ]] && NODE_BIN=""
    [[ -n "$NODE_BIN" ]] || NODE_BIN="$(unit_exec_node "${SERVICE_UNIT:-}")"
    [[ -n "$NODE_BIN" && ! -x "$NODE_BIN" ]] && NODE_BIN=""
    [[ -n "$NODE_BIN" ]] || NODE_BIN="$(find_node_bin || true)"

    CHROME="$(state_get MIRAGE_CHROME_BIN)"
    [[ -n "$CHROME" && ! -x "$CHROME" ]] && CHROME=""
    [[ -n "$CHROME" ]] || CHROME="$(find_chromium_bin || true)"

    # --- data dir -----------------------------------------------------------
    DATA_DIR="${MIRAGE_DATA:-}"
    [[ -n "$DATA_DIR" ]] || DATA_DIR="$(state_get MIRAGE_DATA_DIR)"
    [[ -n "$DATA_DIR" ]] || DATA_DIR="$(marker_get "$APP_DIR" data_dir)"
    if [[ -z "$DATA_DIR" ]]; then
        if [[ -d "$APP_DIR/data" ]]; then DATA_DIR="$APP_DIR/data"; else DATA_DIR="$APP_DIR/data"; fi
    fi

    NGINX_CONF="$(nginx_conf_for "$PORT" || true)"
    return 0
}

print_discovery_report() {
    echo ""
    echo "  ── detected installation ──────────────────────────────"
    if (( INSTALLED )); then
        printf '  %-12s %s  %s(via %s)%s\n' "app dir" "$APP_DIR" "$C_DIM" "$DISCOVERY_SOURCE" "$C_OFF"
    else
        printf '  %-12s %s\n' "app dir" "not found (searched: $STATE_FILE, systemd units, /proc, common dirs$([[ "${MIRAGE_NO_FS_SCAN:-0}" == 1 ]] || echo ", filesystem"))"
    fi
    printf '  %-12s %s\n' "user"   "$APP_USER"
    printf '  %-12s %s\n' "port"   "$PORT"
    printf '  %-12s %s\n' "domain" "$DOMAIN"
    printf '  %-12s %s%s\n' "unit"  "${SERVICE_UNIT:-<none>}" "$([[ -n "$SERVICE_UNIT" ]] && echo " (service: $SERVICE_NAME)" || echo "")"
    printf '  %-12s %s\n' "node"   "${NODE_BIN:-<not found>}"
    printf '  %-12s %s\n' "chromium" "${CHROME:-<not found>}"
    printf '  %-12s %s%s\n' "data" "$DATA_DIR" "$([[ -d "$DATA_DIR" ]] && echo '' || echo ' (created at runtime)')"
    printf '  %-12s %s\n' "nginx"  "${NGINX_CONF:-<none>}"
    for d in "${DISCOVERY_LOG[@]:-}"; do
        [[ -n "$d" ]] && dim "  · $d"
    done
    echo "  ───────────────────────────────────────────────────────"
    echo ""
    return 0
}

# =============================================================================
#  systemd / process control (with graceful fallbacks)
# =============================================================================
systemd_available() { have systemctl && [[ -d /run/systemd/system ]]; }

unit_known() {
    local n="${1:-$SERVICE_NAME}"
    [[ -n "$n" ]] || return 1
    [[ -f "/etc/systemd/system/$n" || -f "/etc/systemd/system/${n%.service}.service" ]] && return 0
    systemctl cat "$n" >/dev/null 2>&1
}

# Where runtime files (pid, log) can actually be written: the state dir when possible,
# otherwise inside the installation, otherwise the temp dir. Keeps the no-systemd
# fallback working for unprivileged or container installs.
state_dir() {
    local d
    for d in "$STATE_DIR" "${APP_DIR:-}/.mirage" "${TMPDIR:-/tmp}/mirage-${APP_USER:-user}"; do
        [[ -n "$d" && "$d" != "/.mirage" ]] || continue
        if mkdir -p "$d" 2>/dev/null && [[ -w "$d" ]]; then printf '%s' "$d"; return 0; fi
    done
    printf '%s' "${TMPDIR:-/tmp}"
}

logfile() { printf '%s/mirage.log' "$(state_dir)"; }
pidfile() { printf '%s/mirage.pid' "$(state_dir)"; }

# pid of a fallback (non-systemd) process, when it is still alive
bg_pid() {
    local p
    p="$(cat "$(pidfile)" 2>/dev/null || true)"
    if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then printf '%s' "$p"; return 0; fi
    return 1
}

service_active() {
    if systemd_available && unit_known && systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        return 0
    fi
    bg_pid >/dev/null 2>&1
}

service_stop() {
    if systemd_available && unit_known; then
        say "stopping $SERVICE_NAME…"
        systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    fi
    local p
    if p="$(bg_pid)"; then
        say "stopping background process (pid $p)…"
        kill "$p" 2>/dev/null || true
        for _ in 1 2 3 4 5; do kill -0 "$p" 2>/dev/null || break; sleep 0.4; done
        kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    fi
    rm -f "$(pidfile)" 2>/dev/null || true
    return 0
}

service_start() {
    if systemd_available && unit_known; then
        systemctl daemon-reload 2>/dev/null || true
        systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || systemctl start "$SERVICE_NAME" 2>/dev/null || true
    elif have systemctl && unit_known; then
        systemctl start "$SERVICE_NAME" 2>/dev/null || true
    else
        warn "systemd is not available — running Mirage as a background process"
        [[ -n "$NODE_BIN" ]] || { err "node binary unknown — cannot start"; return 1; }
        [[ -d "$APP_DIR" ]]  || { err "app dir $APP_DIR is missing — cannot start"; return 1; }
        local log pidf; log="$(logfile)"; pidf="$(pidfile)"
        # exec keeps the pid stable, so the pid file really points at the server
        ( cd "$APP_DIR" || exit 1
          exec nohup env PORT="$PORT" MIRAGE_DATA="$DATA_DIR" NODE_ENV=production \
               "$NODE_BIN" src/index.js >>"$log" 2>&1 ) &
        echo "$!" >"$pidf" 2>/dev/null || warn "cannot write $pidf"
        sleep 1
        if ! bg_pid >/dev/null; then
            err "the background process died immediately — see $log"
            return 1
        fi
        say "pid $(bg_pid), log: $log"
    fi
    return 0
}

health_check() { # [PORT] [TRIES]
    local port="${1:-$PORT}" tries="${2:-12}" i
    for (( i=1; i<=tries; i++ )); do
        port_answers "$port" && return 0
        sleep 1
    done
    return 1
}

# =============================================================================
#  package / dependency helpers
# =============================================================================
detect_pm() {
    if have apt-get; then printf 'apt\n'
    elif have dnf; then printf 'dnf\n'
    elif have yum; then printf 'yum\n'
    elif have zypper; then printf 'zypper\n'
    elif have pacman; then printf 'pacman\n'
    else printf 'none\n'
    fi
}

pkg_installed() { # PM NAME
    case "$1" in
        apt) dpkg-query -W -f='${Status}' "$2" 2>/dev/null | grep -q 'install ok installed' ;;
        dnf|yum|zypper) rpm -q "$2" >/dev/null 2>&1 ;;
        pacman) pacman -Q "$2" >/dev/null 2>&1 ;;
        *) return 1 ;;
    esac
}

pkg_install() { # PM NAME...
    local pm="$1"; shift
    case "$pm" in
        apt) apt-get install -y "$@" ;;
        dnf) dnf install -y "$@" ;;
        yum) yum install -y "$@" ;;
        zypper) zypper --non-interactive install "$@" ;;
        pacman) pacman -S --noconfirm --needed "$@" ;;
        *) return 1 ;;
    esac
}

pm_update_index() {
    case "$1" in
        apt) apt-get update -y ;;
        dnf|yum) true ;;
        zypper) zypper --non-interactive refresh ;;
        pacman) pacman -Sy --noconfirm ;;
        *) true ;;
    esac
}

install_system_packages() { # PM PKG...
    local pm="$1"; shift
    local -a missing=()
    local p
    for p in "$@"; do
        pkg_installed "$pm" "$p" || missing+=("$p")
    done
    if (( ${#missing[@]} == 0 )); then
        ok "system packages already present: $*"
        return 0
    fi
    say "installing missing packages: ${missing[*]}"
    pm_update_index "$pm" || warn "package index refresh failed"
    pkg_install "$pm" "${missing[@]}" || warn "package install reported errors — continuing"
    return 0
}

install_node_runtime() { # PM
    local pm="$1"
    if [[ "$pm" == apt ]]; then
        say "installing Node.js 22 from NodeSource…"
        if curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1; then
            apt-get install -y nodejs && return 0
        fi
    elif [[ "$pm" != none ]]; then
        say "installing Node.js 22 from NodeSource…"
        if curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1; then
            pkg_install "$pm" nodejs && return 0
        fi
    fi
    warn "NodeSource install failed — falling back to the official nodejs.org tarball"
    install_node_tarball
}

install_node_tarball() {
    local arch base file tmp
    case "$(uname -m)" in
        x86_64|amd64) arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) warn "no tarball fallback for architecture $(uname -m)"; return 1 ;;
    esac
    have curl || { warn "curl is required for the tarball fallback"; return 1; }
    base="https://nodejs.org/dist/latest-v22.x"
    file="$(curl -fsSL "$base/" 2>/dev/null | grep -oE "node-v22\.[0-9.]+-linux-$arch\.tar\.gz" | head -n1 || true)"
    [[ -n "$file" ]] || { warn "cannot determine the current v22 tarball name"; return 1; }
    tmp="$(mktemp -d)"
    say "downloading $file…"
    curl -fsSL "$base/$file" -o "$tmp/node.tar.gz" || { rm -rf "$tmp"; return 1; }
    mkdir -p /usr/local/lib/nodejs
    tar -xzf "$tmp/node.tar.gz" -C /usr/local/lib/nodejs || { rm -rf "$tmp"; return 1; }
    rm -rf "$tmp"
    ln -sf "/usr/local/lib/nodejs/${file%.tar.gz}/bin/node" /usr/local/bin/node
    ln -sf "/usr/local/lib/nodejs/${file%.tar.gz}/bin/npm"  /usr/local/bin/npm
    ln -sf "/usr/local/lib/nodejs/${file%.tar.gz}/bin/npx"  /usr/local/bin/npx
    printf 'export PATH=/usr/local/lib/nodejs/%s/bin:$PATH\n' "${file%.tar.gz}" >/etc/profile.d/nodejs.sh
    return 0
}

install_deps() { # npm deps only when the project actually needs them
    local pj="$APP_DIR/package.json"
    if [[ ! -f "$pj" ]]; then warn "no package.json in $APP_DIR"; return 0; fi
    if ! grep -qE '"dependencies"[[:space:]]*:' "$pj" && [[ ! -f "$APP_DIR/package-lock.json" ]]; then
        ok "no runtime npm dependencies — skipping npm install"
        return 0
    fi
    if ! have npm; then
        warn "npm not found — skipping dependency install (app may still run)"
        return 0
    fi
    say "installing npm dependencies in $APP_DIR…"
    if ( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
        ok "dependencies installed"
    elif ( cd "$APP_DIR" && npm install --production --no-audit --no-fund >/dev/null 2>&1 ); then
        ok "dependencies installed (legacy flag)"
    else
        warn "npm install failed — continuing (Mirage has zero runtime deps)"
    fi
    return 0
}

fix_ownership() {
    [[ -n "$APP_DIR" && -d "$APP_DIR" ]] || return 0
    if id "$APP_USER" >/dev/null 2>&1; then
        chown -R "$APP_USER:$APP_USER" "$APP_DIR" 2>/dev/null || warn "chown failed for $APP_DIR"
    fi
    return 0
}

# =============================================================================
#  Backups
# =============================================================================
make_backup() {
    local root="${BACKUP_ROOT:-}"
    if [[ -z "$root" ]]; then
        root="$(dirname "$APP_DIR")"
        [[ -w "$root" ]] || root=/var/backups
    fi
    mkdir -p "$root" 2>/dev/null || { warn "cannot create backup root $root"; BACKUP_DIR=""; return 0; }
    BACKUP_DIR="$root/mirage_backup_$(date +%Y%m%d_%H%M%S)"
    say "backup → $BACKUP_DIR"
    if cp -a "$APP_DIR/." "$BACKUP_DIR/" 2>/dev/null; then
        ok "backup created"
    else
        warn "backup failed (continuing without rollback safety net)"
        rm -rf "$BACKUP_DIR"; BACKUP_DIR=""
    fi
    rotate_backups "$root"
    return 0
}

rotate_backups() {
    local root="$1" keep="${KEEP_BACKUPS:-5}" i=0 d
    [[ "$keep" =~ ^[0-9]+$ ]] || keep=5
    while IFS= read -r d; do
        i=$((i + 1))
        if (( i > keep )); then
            say "removing old backup $d (keeping last $keep)"
            rm -rf "$d"
        fi
    done < <(find "$root" -maxdepth 1 -type d -name 'mirage_backup_*' 2>/dev/null | sort -r)
    return 0
}

# =============================================================================
#  Payload update (git or local tree)
# =============================================================================
copy_local_tree() {
    local src="$SELF_DIR"
    if ! is_mirage_dir "$src"; then
        warn "this script does not live inside a Mirage tree ($src)"
        if [[ -n "$REPO" ]]; then
            src="$(mktemp -d)"
            say "cloning $REPO…"
            git clone --depth 1 "$REPO" "$src" || { rm -rf "$src"; return 1; }
        else
            return 1
        fi
    fi
    say "syncing $src → $APP_DIR (data/ is preserved)"
    if have rsync; then
        rsync -a --exclude '/data/' --exclude '/.git/' --exclude '/node_modules/' "$src/" "$APP_DIR/" || return 1
    else
        # cp cannot exclude: copy data aside, restore after the copy
        local tmpdata=""
        if [[ -d "$APP_DIR/data" ]]; then
            tmpdata="$(mktemp -d)"; cp -a "$APP_DIR/data/." "$tmpdata/" || true
        fi
        cp -a "$src/." "$APP_DIR/" || return 1
        if [[ -n "$tmpdata" ]]; then
            mkdir -p "$APP_DIR/data"; cp -a "$tmpdata/." "$APP_DIR/data/" || true; rm -rf "$tmpdata"
        fi
    fi
    return 0
}

apply_payload() {
    if [[ -d "$APP_DIR/.git" ]]; then
        say "updating git checkout in $APP_DIR"
        git -C "$APP_DIR" fetch --all --prune >/dev/null 2>&1 || warn "git fetch failed (offline?)"
        local br cur ref
        br="${GIT_BRANCH:-}"
        if [[ -z "$br" ]]; then
            br="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
            if [[ "$br" == "HEAD" ]]; then
                br="$(git -C "$APP_DIR" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
            fi
            [[ -n "$br" && "$br" != "HEAD" ]] || br="${BRANCH_ENV:-main}"
        fi
        ref="${GIT_REF:-origin/$br}"
        git -C "$APP_DIR" rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || ref="$br"
        cur="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"

        # updating from another branch/tag: switch the deployment checkout over
        if [[ "$br" != "$cur" ]]; then
            say "switching the checkout: $cur → $br ($ref)"
            local dirty co_out co_flags=(-B)
            dirty="$(git -C "$APP_DIR" status --porcelain 2>/dev/null | grep -v '^??' | head -n 5 || true)"
            if [[ -n "$dirty" && "$FORCE" != 1 ]]; then
                err "local modifications prevent the switch:"
                printf '%s\n' "$dirty" | sed 's/^/      /'
                say "hint: a deployment checkout should stay pristine — revert them or re-run with --force"
                return 1
            fi
            [[ "$FORCE" == 1 ]] && co_flags=(-f -B)
            if co_out="$(git -C "$APP_DIR" checkout "${co_flags[@]}" "$br" "$ref" 2>&1)"; then
                ok "checkout switched to $br ($(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?'))"
                return 0
            fi
            err "cannot switch the checkout to '$br':"
            printf '%s\n' "$co_out" | sed 's/^/      /'
            return 1
        fi
        local pull_out
        if pull_out="$(git -C "$APP_DIR" pull --ff-only origin "$br" 2>&1)"; then
            ok "pulled origin/$br"
            return 0
        fi
        warn "git pull --ff-only failed on branch '$br':"
        printf '%s\n' "$pull_out" | sed 's/^/      /'
        if [[ "${MIRAGE_HARD_RESET:-0}" == 1 ]]; then
            warn "MIRAGE_HARD_RESET=1 → git reset --hard origin/$br (local changes are discarded)"
            git -C "$APP_DIR" reset --hard "origin/$br" >/dev/null && return 0
        else
            say "hint: commit/stash your local changes, or re-run with MIRAGE_HARD_RESET=1 to discard them"
        fi
        return 1
    fi
    if [[ -n "$REPO" ]]; then
        local tmp
        tmp="$(mktemp -d)"
        say "cloning $REPO…"
        if git clone --depth 1 "$REPO" "$tmp"; then
            if have rsync; then
                rsync -a --exclude '/data/' "$tmp/" "$APP_DIR/"
            else
                cp -a "$tmp/." "$APP_DIR/"
            fi
            rm -rf "$tmp"
            return 0
        fi
        rm -rf "$tmp"
        return 1
    fi
    copy_local_tree
}


# =============================================================================
#  Pre-flight diagnostics — verify we have everything a safe update needs
# =============================================================================
CHECKS_FAIL=0
CHECKS_WARN=0
GIT_BRANCH=""
GIT_REF=""
GIT_CUR_BRANCH=""
GIT_BEHIND=0
GIT_AHEAD=0
PREFLIGHT_FETCHED=0
STAGE_DIR=""
STAGE_REF=""
SMOKE_LOG=""
SKIP_SMOKE="${MIRAGE_SKIP_SMOKE:-0}"
OFFLINE="${MIRAGE_OFFLINE:-0}"

chk_pass() { printf '  %s\xe2\x9c\x93%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
chk_warn() { CHECKS_WARN=$((CHECKS_WARN + 1)); printf '  %s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
chk_fail() { CHECKS_FAIL=$((CHECKS_FAIL + 1)); printf '  %s\xe2\x9c\x97%s %s\n' "$C_RED" "$C_OFF" "$*"; }
chk_info() { printf '  %s\xc2\xb7%s %s\n' "$C_DIM" "$C_OFF" "$*"; }

# is anything answering HTTP on PORT?
port_answers() { # PORT
    local port="${1:-}" code
    [[ -n "$port" ]] || return 1
    if have curl; then
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null || true)"
        [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]
    else
        (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
    fi
}

free_port() { # ask node for a port nobody is using
    local n="${NODE_BIN:-node}" p=""
    if have "$n"; then
        p="$("$n" -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const a=s.address().port;s.close(()=>console.log(a))})' 2>/dev/null | tr -dc '0-9' || true)"
    fi
    if [[ -z "$p" ]]; then
        p="$((20000 + RANDOM % 20000))"
        while have ss && ss -ltn 2>/dev/null | grep -qE "[:.]$p[[:space:]]"; do p="$((p + 1))"; done
    fi
    printf '%s' "$p"
}

# Prints every JS file of DIR that does not even parse. Returns 1 when broken.
NODE_CMD=""
node_cmd() { # resolved node command used by the checks
    local n="${NODE_BIN:-}"
    [[ -n "$n" && -x "$n" ]] || n="$(command -v node 2>/dev/null || true)"
    printf '%s' "$n"
}

syntax_check_tree() { # DIR
    local d="${1%/}" f n
    n="$(node_cmd)"
    [[ -n "$n" ]] || { warn "node is not available for the syntax check"; return 0; }
    local bad=0
    while IFS= read -r f; do
        if ! "$n" --check "$f" >/dev/null 2>&1; then
            printf '%s\n' "${f#"$d"/}"
            bad=1
        fi
    done < <(find "$d" \( -name node_modules -o -name .git -o -name data -o -name .smoke-data \) -prune -o \
                -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print 2>/dev/null)
    return $bad
}

# Boots DIR on a spare port with a throwaway data dir: proves the release works
# before we touch the running installation.
smoke_boot() { # DIR
    local d="${1%/}" port log data pid i ok=0
    [[ -f "$d/src/index.js" ]] || { SMOKE_LOG="src/index.js is missing"; return 1; }
    SMOKE_LOG=""
    data="$(mktemp -d)"; log="$(mktemp)"; port="$(free_port)"
    ( cd "$d" || exit 1
      exec env HOST=127.0.0.1 PORT="$port" MIRAGE_DATA="$data" NODE_ENV=production \
           "$NODE_BIN" src/index.js >"$log" 2>&1 ) &
    pid=$!
    for (( i=1; i<=12; i++ )); do
        sleep 1
        if port_answers "$port"; then ok=1; break; fi
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
    done
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    (( ok )) || SMOKE_LOG="$(tail -n 12 "$log" 2>/dev/null || true)"
    rm -rf "$data" "$log"
    (( ok ))
}

# Fetches the candidate release into a temp dir (or points at the local tree).
prepare_payload() {
    cleanup_stage
    local tmp ref
    if [[ -d "$APP_DIR/.git" ]]; then
        if [[ "$OFFLINE" != 1 && "$PREFLIGHT_FETCHED" != 1 ]]; then
            say "fetching origin…"
            git -C "$APP_DIR" fetch --all --prune >/dev/null 2>&1 || warn "git fetch failed — validating the refs known locally"
        fi
        ref="${GIT_REF:-}"
        if [[ -z "$ref" ]]; then
            ref="origin/${GIT_BRANCH:-main}"
            git -C "$APP_DIR" rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || ref="${GIT_BRANCH:-main}"
        fi
        tmp="$(mktemp -d)"
        if git -C "$APP_DIR" archive "$ref" 2>/dev/null | tar -x -C "$tmp" 2>/dev/null; then
            STAGE_DIR="$tmp"; STAGE_REF="$ref"
            return 0
        fi
        rm -rf "$tmp"
        warn "cannot snapshot $ref for validation"
        return 1
    fi
    if [[ -n "$REPO" ]]; then
        tmp="$(mktemp -d)"
        say "fetching $REPO for validation…"
        if git clone --quiet --depth 1 "$REPO" "$tmp" >/dev/null 2>&1; then
            STAGE_DIR="$tmp"; STAGE_REF="$REPO"
            return 0
        fi
        rm -rf "$tmp"
        warn "cannot clone $REPO for validation"
        return 1
    fi
    if is_mirage_dir "$SELF_DIR"; then
        STAGE_DIR="${SELF_DIR%/}"; STAGE_REF="local tree $SELF_DIR"
        return 0
    fi
    warn "no payload to validate (this script is not inside a Mirage tree — set REPO)"
    return 1
}

cleanup_stage() {
    [[ -n "$STAGE_DIR" && "$STAGE_DIR" != "$SELF_DIR" && "$STAGE_DIR" != "$APP_DIR" ]] && rm -rf "$STAGE_DIR" 2>/dev/null
    STAGE_DIR=""
    return 0
}

# Everything that must hold for the new release, verified off-line and off-path:
# parses, has an entry point, and actually boots on a spare port.
validate_payload() { # DIR
    local d="${1%/}" ver
    if [[ ! -f "$d/package.json" ]]; then chk_fail "release has no package.json"; return 1; fi
    ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$d/package.json" 2>/dev/null | head -n1 || true)"
    grep -qE '"name"[[:space:]]*:[[:space:]]*"mirage"' "$d/package.json" 2>/dev/null \
        && chk_pass "release payload: mirage ${ver:-?} ($STAGE_REF)" \
        || chk_warn "release package.json is not named 'mirage' — continuing ($STAGE_REF)"
    [[ -f "$d/src/index.js" ]] || { chk_fail "release has no src/index.js"; return 1; }
    chk_pass "entry point src/index.js present"

    local -a broken=()
    NODE_CMD="$(node_cmd)"        # resolved here: syntax_check_tree runs in a subshell
    while IFS= read -r f; do [[ -n "$f" ]] && broken+=("$f"); done < <(syntax_check_tree "$d" || true)
    if (( ${#broken[@]} )); then
        chk_fail "release does not parse — ${#broken[@]} broken file(s): ${broken[*]}"
        local f e
        if [[ -n "$NODE_CMD" ]]; then
            for f in "${broken[@]}"; do
                e="$("$NODE_CMD" --check "$d/$f" 2>&1 | head -n 5 || true)"
                [[ -n "$e" ]] && printf '%s\n' "$e" | sed 's/^/      /'
            done
        fi
        return 1
    fi
    chk_pass "all JS files parse cleanly"

    if [[ "$SKIP_SMOKE" == 1 ]]; then
        chk_info "smoke launch skipped (--skip-smoke)"
        return 0
    fi
    say "test-launching the new release on a spare port…"
    if smoke_boot "$d"; then
        chk_pass "release boots and answers HTTP"
        return 0
    fi
    chk_fail "release fails to boot:"
    [[ -n "$SMOKE_LOG" ]] && printf '%s\n' "$SMOKE_LOG" | sed 's/^/      /'
    return 1
}

# Why did the service not come up? Show the logs (and name broken files).
dump_start_failure() {
    local unit="${SERVICE_NAME%.service}" l shown=0 f
    if systemd_available && unit_known; then
        say "last lines of journalctl -u $unit:"
        journalctl -u "$unit" -n 12 --no-pager 2>/dev/null | sed 's/^/    /' && shown=1
    fi
    for l in "$(logfile)" "$STATE_DIR/mirage.log" "$APP_DIR/mirage.log"; do
        [[ -f "$l" ]] || continue
        say "tail of $l:"
        tail -n 12 "$l" 2>/dev/null | sed 's/^/    /'
        shown=1
    done
    local -a broken=()
    while IFS= read -r f; do [[ -n "$f" ]] && broken+=("$f"); done < <(syntax_check_tree "$APP_DIR" || true)
    if (( ${#broken[@]} )); then
        err "installed tree has syntax errors in: ${broken[*]}"
        return 0
    fi
    if [[ "$shown" == 0 && -n "$NODE_BIN" ]]; then
        say "direct start attempt:"
        local out
        out="$("$NODE_BIN" --check "$APP_DIR/src/index.js" 2>&1 | head -n 6 || true)"
        [[ -n "$out" ]] && printf '%s\n' "$out" | sed 's/^/    /'
    fi
    return 0
}

# Pre-flight: checks every fact the update relies on, before anything is stopped.
preflight_update() {
    CHECKS_FAIL=0; CHECKS_WARN=0
    say "Pre-flight checks (nothing has been changed yet)…"

    # --- installation tree ---
    if is_mirage_dir "$APP_DIR"; then chk_pass "app dir: $APP_DIR"
    else chk_fail "app dir $APP_DIR does not look like a Mirage tree"; fi
    [[ -f "$APP_DIR/package.json" ]] && chk_pass "package.json present" || chk_fail "package.json is missing"
    if [[ -w "$APP_DIR" ]]; then chk_pass "app dir is writable"
    else chk_fail "app dir is not writable by the current user"; fi

    # --- service user ---
    if id "$APP_USER" >/dev/null 2>&1; then
        chk_pass "service user '$APP_USER' exists"
        local owner perms
        owner="$(stat -c %U "$APP_DIR" 2>/dev/null || true)"
        perms="$(stat -c %a "$APP_DIR" 2>/dev/null || true)"
        if [[ "$owner" == "$APP_USER" || "${perms:2:1}" =~ [rx] ]]; then
            chk_pass "service user can access the tree (owner ${owner:-?}, mode ${perms:-?})"
        else
            chk_warn "tree owner is ${owner:-?} (mode ${perms:-?}) — '$APP_USER' may not be able to read it"
        fi
    else
        chk_warn "service user '$APP_USER' does not exist on this machine"
    fi

    # --- runtimes ---
    if [[ -n "$NODE_BIN" ]] && node_ok "$NODE_BIN"; then
        chk_pass "node $("$NODE_BIN" -v 2>/dev/null) at $NODE_BIN"
    elif [[ -n "$NODE_BIN" ]]; then
        chk_fail "node at $NODE_BIN is older than 22.5 — Mirage needs node:sqlite"
    else
        chk_fail "node binary not found — set NODE_BIN=/path/to/node"
    fi
    local unit_node
    unit_node="$(unit_exec_node "${SERVICE_UNIT:-}")"
    if [[ -n "$unit_node" && -n "$NODE_BIN" && "$unit_node" != "$NODE_BIN" ]]; then
        chk_warn "the unit starts $unit_node, the checks used $NODE_BIN"
    fi
    if [[ -n "$CHROME" ]]; then chk_pass "chromium: $CHROME"
    else chk_warn "chromium not found — set CHROME_BIN=… or profiles will not launch"; fi
    have git || chk_warn "git is not installed"
    have rsync || chk_info "rsync not installed — falling back to cp for the payload sync"

    # --- systemd unit ---
    if [[ -n "$SERVICE_UNIT" ]]; then
        chk_pass "systemd unit: $SERVICE_UNIT"
        local wd es
        wd="$(unit_field "$SERVICE_UNIT" WorkingDirectory)"; wd="${wd%\"}"; wd="${wd#\"}"
        if [[ -z "$wd" || "${wd%/}" == "$APP_DIR" ]]; then chk_pass "unit WorkingDirectory matches the app dir"
        else chk_fail "unit WorkingDirectory is '$wd' but the app dir is '$APP_DIR'"; fi
        es="$(unit_exec_dir "$SERVICE_UNIT")"
        if [[ -z "$es" || "$es" == "$APP_DIR" ]]; then chk_pass "unit ExecStart points into the app dir"
        else chk_fail "unit ExecStart points at '$es' instead of '$APP_DIR'"; fi
        if systemd_available; then
            case "$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)" in
                enabled) chk_pass "unit is enabled" ;;
                masked)  chk_fail "unit is masked — unmask it: systemctl unmask $SERVICE_NAME" ;;
                *)       chk_warn "unit is not enabled (it will not come back after a reboot)" ;;
            esac
        else
            chk_warn "systemd is not running — the update will use the background-process fallback"
        fi
    else
        chk_warn "no systemd unit found for $APP_DIR (will use the fallback start)"
    fi

    # --- port / service state ---
    if service_active; then chk_pass "service is currently active"
    else chk_warn "service is not active — the update will start it afterwards"; fi
    if have ss && [[ -n "$PORT" ]] && ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; then
        if service_active; then chk_pass "port $PORT is held by this service"
        else chk_warn "port $PORT is already in use by another process — the service may fail to bind"; fi
    fi

    # --- data dir & disk space ---
    if [[ -d "$DATA_DIR" ]]; then
        chk_pass "data dir: $DATA_DIR"
        if [[ -w "$DATA_DIR" ]]; then chk_pass "data dir is writable"
        else chk_fail "data dir $DATA_DIR is not writable"; fi
    else
        chk_info "data dir $DATA_DIR does not exist yet (created on first run)"
    fi
    local broot need avail
    broot="${BACKUP_ROOT:-$(dirname "$APP_DIR")}"
    need="$(du -sk "$APP_DIR" 2>/dev/null | awk '{print $1+0}')"
    avail="$(df -Pk "$broot" 2>/dev/null | awk 'NR==2{print $4+0}')"
    if (( need > 0 && avail > 0 )); then
        if (( avail < need + 51200 )); then
            chk_warn "little free space in $broot: $((avail / 1024))MB free, the backup needs ~$((need / 1024))MB"
        else
            chk_pass "free space for the backup: $((avail / 1024))MB in $broot"
        fi
    fi

    # --- nginx ---
    if [[ -n "$NGINX_CONF" ]]; then
        if have nginx && nginx -t >/dev/null 2>&1; then chk_pass "nginx config is valid ($NGINX_CONF)"
        else chk_warn "nginx config test failed — the vhost will not be reloaded"; fi
    fi

    # --- payload source / git state ---
    GIT_BRANCH=""; GIT_BEHIND=0; GIT_AHEAD=0
    if [[ -d "$APP_DIR/.git" ]]; then
        if have git; then
            chk_pass "installation is a git checkout"
            GIT_BRANCH="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
            if [[ "$GIT_BRANCH" == "HEAD" ]]; then
                GIT_BRANCH="$(git -C "$APP_DIR" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
                [[ -n "$GIT_BRANCH" ]] || GIT_BRANCH="main"
                chk_warn "HEAD is detached — assuming branch '$GIT_BRANCH'"
            fi
            GIT_CUR_BRANCH="$GIT_BRANCH"
            if [[ -n "$BRANCH_ENV" && "$BRANCH_ENV" != "$GIT_BRANCH" ]]; then
                chk_info "target branch requested: $BRANCH_ENV (the checkout is on $GIT_BRANCH)"
                GIT_BRANCH="$BRANCH_ENV"
            fi
            if git -C "$APP_DIR" remote get-url origin >/dev/null 2>&1; then
                chk_pass "origin: $(git -C "$APP_DIR" remote get-url origin)"
            elif [[ -n "$REPO" ]]; then
                chk_warn "no 'origin' remote — falling back to REPO=$REPO"
            else
                chk_fail "no 'origin' remote and REPO is not set — there is nothing to pull from"
            fi
            PREFLIGHT_FETCHED=0
            if [[ "$OFFLINE" != 1 ]]; then
                if git -C "$APP_DIR" ls-remote --exit-code origin >/dev/null 2>&1; then
                    chk_pass "git remote is reachable"
                    if git -C "$APP_DIR" fetch --all --prune >/dev/null 2>&1; then
                        PREFLIGHT_FETCHED=1
                        chk_pass "fetched the latest refs"
                    else
                        chk_warn "git fetch failed — working with the refs known locally"
                    fi
                else
                    chk_fail "cannot reach the git remote (offline? credentials?) — fix it or re-run with --offline to update from the local tree"
                fi
            else
                chk_info "offline mode: no ls-remote/fetch, using the refs known locally"
            fi
            local dirty
            dirty="$(git -C "$APP_DIR" status --porcelain 2>/dev/null | head -n 5 || true)"
            if [[ -n "$dirty" ]]; then
                chk_warn "local changes in the tree — a fast-forward pull may refuse:"
                printf '%s\n' "$dirty" | sed 's/^/      /'
            else
                chk_pass "working tree is clean"
            fi
            GIT_REF=""
            if git -C "$APP_DIR" rev-parse --verify --quiet "origin/$GIT_BRANCH" >/dev/null 2>&1; then
                GIT_REF="origin/$GIT_BRANCH"
                chk_pass "target ref origin/$GIT_BRANCH ($(git -C "$APP_DIR" rev-parse --short "origin/$GIT_BRANCH" 2>/dev/null || echo '?'), $(git -C "$APP_DIR" log -1 --format=%ci "origin/$GIT_BRANCH" 2>/dev/null | cut -d' ' -f1))"
            elif git -C "$APP_DIR" rev-parse --verify --quiet "$GIT_BRANCH" >/dev/null 2>&1; then
                GIT_REF="$GIT_BRANCH"
                chk_pass "target ref $GIT_BRANCH exists (tag/commit)"
            else
                chk_fail "ref '$GIT_BRANCH' was not found locally or on origin"
            fi
            if [[ -n "$GIT_REF" ]]; then
                GIT_BEHIND="$(git -C "$APP_DIR" rev-list --count "HEAD..$GIT_REF" 2>/dev/null || echo 0)"
                GIT_AHEAD="$(git -C "$APP_DIR" rev-list --count "$GIT_REF..HEAD" 2>/dev/null || echo 0)"
                if [[ "$GIT_BRANCH" != "$GIT_CUR_BRANCH" ]]; then
                    chk_info "the checkout will switch from '$GIT_CUR_BRANCH' to '$GIT_BRANCH'"
                fi
                if (( GIT_BEHIND > 0 )); then chk_pass "$GIT_BEHIND commit(s) to pull from $GIT_REF"
                else chk_info "already at $GIT_REF"; fi
                if (( GIT_AHEAD > 0 )); then
                    if [[ "$GIT_BRANCH" == "$GIT_CUR_BRANCH" ]]; then
                        chk_fail "the checkout is $GIT_AHEAD commit(s) ahead of $GIT_REF — 'pull --ff-only' cannot fast-forward (commit/stash them, or re-run with MIRAGE_HARD_RESET=1 to discard)"
                    else
                        chk_warn "$GIT_AHEAD local commit(s) on $GIT_CUR_BRANCH are not part of $GIT_BRANCH and will not be deployed"
                    fi
                fi
            fi
        else
            chk_fail "the installation is a git checkout but git is not installed"
        fi
    elif [[ -n "$REPO" ]]; then
        chk_pass "payload source: REPO=$REPO"
        have git || chk_fail "git is required to fetch REPO"
    elif is_mirage_dir "$SELF_DIR"; then
        chk_pass "payload source: this tree ($SELF_DIR)"
    else
        chk_fail "no payload source: this script is not inside a Mirage tree — set REPO=<git url>"
    fi

    echo ""
    if (( CHECKS_FAIL )); then
        err "pre-flight: $CHECKS_FAIL problem(s), $CHECKS_WARN warning(s)"
        return 1
    fi
    if (( CHECKS_WARN )); then
        warn "pre-flight: all required checks passed, $CHECKS_WARN warning(s) above"
    else
        ok "pre-flight: everything the update needs is in place"
    fi
    return 0
}

# =============================================================================
#  Actions
# =============================================================================
ensure_root() {
    [[ "$(id -u)" -eq 0 ]] && return 0
    if [[ "${MIRAGE_NO_SUDO:-0}" != 1 ]] && have sudo; then
        say "root is required — re-running with sudo…"
        exec sudo -E -- bash "$SELF" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
    fi
    die "root is required. Run: sudo ./deploy.sh"
}

do_status() {
    resolve_installation
    say "Mirage status"
    print_discovery_report
    if (( INSTALLED )); then
        ok "installation found"
        if [[ -f "$APP_DIR/package.json" ]]; then
            local ver
            ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -n1 || true)"
            printf '  %-12s %s\n' "version" "${ver:-unknown}"
        fi
        if [[ -n "$NODE_BIN" ]]; then printf '  %-12s %s\n' "node" "$NODE_BIN ($("$NODE_BIN" -v 2>/dev/null || echo '?'))"; fi
        if systemd_available && unit_known; then
            printf '  %-12s %s\n' "service" "$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown) / $(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || echo unknown)"
        fi
        if health_check "$PORT" 3; then ok "app answers on 127.0.0.1:$PORT"
        else warn "no HTTP answer on 127.0.0.1:$PORT"; fi
    else
        warn "no Mirage installation detected"
        say "hint: point the script at it explicitly, e.g."
        say "      sudo ./deploy.sh --update --app-dir /path/to/mirage"
        say "      or set APP_DIR=/path/to/mirage ./deploy.sh --status"
        return 1
    fi
    return 0
}

do_install() {
    ensure_root
    say "Starting installation…"
    resolve_installation

    if (( INSTALLED )) && [[ "$FORCE" != 1 ]]; then
        warn "Mirage is already installed at $APP_DIR (detected via $DISCOVERY_SOURCE)"
        if confirm "Update the existing installation instead of reinstalling?" yes; then
            do_update
            return $?
        fi
    fi

    local PM PKG
    PM="$(detect_pm)"
    [[ "$PM" == none ]] && die "unsupported package manager (apt/dnf/yum/zypper/pacman expected)"
    say "package manager: $PM"

    case "$PM" in
        apt) PKG=(chromium xvfb nginx curl ca-certificates gnupg) ;;
        dnf|yum) PKG=(chromium xorg-x11-server-Xvfb nginx curl ca-certificates) ;;
        zypper) PKG=(chromium xvfb nginx curl ca-certificates) ;;
        pacman) PKG=(chromium xorg-server-xvfb nginx curl ca-certificates) ;;
    esac

    # ---- node >= 22.5 ----
    NODE_BIN="$(find_node_bin || true)"
    if [[ -n "$NODE_BIN" ]] && node_ok "$NODE_BIN"; then
        ok "node $("$NODE_BIN" -v 2>/dev/null) already present ($NODE_BIN)"
    else
        [[ -n "$NODE_BIN" ]] && warn "found $NODE_BIN but it is older than 22.5 — installing 22.x"
        have curl || install_system_packages "$PM" curl ca-certificates
        install_node_runtime "$PM" || warn "automatic Node install failed"
        NODE_BIN="$(find_node_bin || true)"
    fi
    if [[ -z "$NODE_BIN" ]] || ! node_ok "$NODE_BIN"; then
        die "node >= 22.5 is required but was not found/installed. Install it manually and re-run (NODE_BIN=/path/to/node)."
    fi
    ok "node $("$NODE_BIN" -v) → $NODE_BIN"

    # ---- system packages (only what is missing) ----
    install_system_packages "$PM" "${PKG[@]}"

    # chromium may be a snap or come from a cache — search everywhere
    CHROME="$(find_chromium_bin || true)"
    if [[ -n "$CHROME" ]]; then ok "chromium: $CHROME"; else
        warn "chromium not found after install — set CHROME_BIN=/path/to/chrome if it is elsewhere"
    fi

    # ---- app user ----
    if ! id "$APP_USER" >/dev/null 2>&1; then
        say "creating system user $APP_USER"
        useradd -r -m -s /usr/sbin/nologin "$APP_USER" 2>/dev/null || useradd -r -m -s /sbin/nologin "$APP_USER" 2>/dev/null || warn "could not create user $APP_USER"
    fi

    # ---- app files ----
    mkdir -p "$APP_DIR"
    if [[ -n "$REPO" ]]; then
        say "cloning $REPO${BRANCH_ENV:+ (branch $BRANCH_ENV)} → $APP_DIR"
        local tmp; tmp="$(mktemp -d)"
        if [[ -n "$BRANCH_ENV" ]]; then
            git clone --depth 1 --branch "$BRANCH_ENV" "$REPO" "$tmp" || die "git clone -b $BRANCH_ENV $REPO failed"
        else
            git clone --depth 1 "$REPO" "$tmp" || die "git clone $REPO failed"
        fi
        cp -a "$tmp/." "$APP_DIR/"; rm -rf "$tmp"
    else
        say "copying tree from $SELF_DIR → $APP_DIR"
        if ! is_mirage_dir "$SELF_DIR"; then
            die "deploy.sh is not inside a Mirage tree ($SELF_DIR). Use REPO=<git url> to install from git."
        fi
        if have rsync; then rsync -a --exclude '/data/' "$SELF_DIR/" "$APP_DIR/"; else cp -a "$SELF_DIR/." "$APP_DIR/"; fi
    fi
    grep -q '"type":[[:space:]]*"module"' "$APP_DIR/package.json" 2>/dev/null \
        || grep -q '"name":[[:space:]]*"mirage"' "$APP_DIR/package.json" 2>/dev/null \
        || die "package.json at $APP_DIR does not look like Mirage (wrong source?)"

    install_deps
    fix_ownership

    # ---- systemd unit ----
    if systemd_available || have systemctl; then
        SERVICE_UNIT="${SERVICE_UNIT:-/etc/systemd/system/${SERVICE_NAME%.service}.service}"
        SERVICE_NAME="$(basename "$SERVICE_UNIT")"
        say "writing systemd unit → $SERVICE_UNIT"
        if [[ -f "$SERVICE_UNIT" ]]; then cp -a "$SERVICE_UNIT" "$SERVICE_UNIT.bak.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true; fi
        cat >"$SERVICE_UNIT" <<EOF
[Unit]
Description=Mirage anti-detect browser
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=NODE_ENV=production
Environment=MIRAGE_DATA=$DATA_DIR
ExecStart=$NODE_BIN $APP_DIR/src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload 2>/dev/null || true
    else
        warn "systemd not available — the app will be started as a plain background process"
    fi

    # ---- nginx vhost ----
    if have nginx; then
        local conf="/etc/nginx/conf.d/mirage.conf"
        [[ -d /etc/nginx/sites-enabled ]] && [[ ! -d /etc/nginx/conf.d ]] && conf="/etc/nginx/sites-enabled/mirage.conf"
        say "writing nginx vhost → $conf"
        [[ -f "$conf" ]] && cp -a "$conf" "$conf.bak.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
        mkdir -p "$(dirname "$conf")"
        cat >"$conf" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
EOF
        NGINX_CONF="$conf"
        if nginx -t >/dev/null 2>&1; then
            systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
            ok "nginx reloaded"
        else
            warn "nginx config test failed — vhost written but not reloaded"
        fi
    else
        warn "nginx not installed — skipping the vhost (direct access stays on port $PORT)"
    fi

    # ---- /etc/hosts entry ----
    if [[ "$SET_HOSTS" == 1 && -n "$DOMAIN" ]]; then
        if ! grep -qE "[[:space:]]$DOMAIN([[:space:]]|$)" /etc/hosts 2>/dev/null; then
            echo "127.0.0.1 $DOMAIN" >>/etc/hosts && ok "added $DOMAIN to /etc/hosts"
        fi
    fi

    # ---- start ----
    say "starting service…"
    service_start
    if health_check "$PORT" 15 || service_active; then
        ok "mirage is up on port $PORT"
    else
        warn "mirage did not answer on port $PORT — see: journalctl -u ${SERVICE_NAME%.service} -n 50"
    fi

    write_marker
    write_state

    echo
    ok "Mirage deployed successfully."
    say "Open:        http://$DOMAIN  (or http://127.0.0.1:$PORT)"
    say "PIN:         printed in the server log on first run (change it in Team)"
    say "Logs:        journalctl -u ${SERVICE_NAME%.service} -f   (or $(logfile) without systemd)"
    [[ -n "$CHROME" ]] && say "Chromium:    $CHROME"
    return 0
}

explain_not_found() {
    err "Mirage installation directory was not found."
    echo ""
    say "Searched, in this order:"
    say "  1) APP_DIR env / --app-dir        ${APP_DIR_ENV:-<not set>}"
    say "  2) state file                     $STATE_FILE"
    say "  3) systemd units                  $(unit_dirs | tr '\n' ' ')"
    say "  4) running processes              /proc/*/cmdline → src/index.js"
    say "  5) common directories             /opt /srv /var/www /usr/local /root /home/* …"
    say "  6) filesystem walk                dirs named *mirage*, then package.json markers"
    local l
    for l in "${DISCOVERY_LOG[@]:-}"; do [[ -n "$l" ]] && dim "  · $l"; done
    echo ""
    say "Fix it by pointing the script at the tree explicitly:"
    say "  sudo ./deploy.sh --update --app-dir /path/to/mirage"
    say "  APP_DIR=/path/to/mirage sudo ./deploy.sh --update"
    if is_mirage_dir "$SELF_DIR"; then
        say "Note: this script itself sits inside a Mirage tree ($SELF_DIR)."
        say "      If that is your installation, use:  sudo ./deploy.sh --update --app-dir \"$SELF_DIR\""
    fi
    say "Inspect everything the script can see with:  sudo ./deploy.sh --status"
    return 1
}

do_update() {
    ensure_root
    resolve_installation
    if (( ! INSTALLED )); then
        explain_not_found
        return 1
    fi

    say "Updating installation at $APP_DIR"
    dim "  detected via: $DISCOVERY_SOURCE"
    print_discovery_report

    # ---- 1. diagnostics: is everything the update needs really there? -------
    if ! preflight_update; then
        if [[ "$FORCE" == 1 ]]; then
            warn "--force: continuing despite the failed checks"
        else
            err "nothing was changed — the running version is untouched."
            say "fix the items marked ✗ above and re-run:  sudo ./deploy.sh --update"
            say "(or re-run with --force to ignore them, --skip-smoke to skip the release launch test)"
            return 1
        fi
    fi

    # ---- 2. validate the candidate release BEFORE touching the service ------
    say "Loading and validating the new release…"
    if ! prepare_payload; then
        err "could not obtain the new release — nothing was changed."
        return 1
    fi
    if ! validate_payload "$STAGE_DIR"; then
        err "the new release was rejected — nothing was changed, the old version keeps running."
        local sha=""
        [[ -d "$APP_DIR/.git" ]] && sha="$(git -C "$APP_DIR" rev-parse --short "$STAGE_REF" 2>/dev/null || true)"
        say "release source:  $STAGE_REF${sha:+ (commit $sha)}"
        if [[ -d "$APP_DIR/.git" ]]; then
            say "installed:       $GIT_CUR_BRANCH $(git -C "$APP_DIR" log -1 --format='%h %s' HEAD 2>/dev/null || true)"
        fi
        echo ""
        say "This build is broken upstream — there is nothing to fix locally. Options:"
        say "  · wait for a fixed build on $STAGE_REF and re-run:  sudo ./deploy.sh --update"
        say "  · deploy another branch/tag that validates:          sudo ./deploy.sh --update --branch <name>"
        say "  · check what the release contains:                   git -C '$APP_DIR' log --oneline -5 $STAGE_REF"
        cleanup_stage
        return 1
    fi
    if [[ -n "$GIT_REF" && "$GIT_BRANCH" == "$GIT_CUR_BRANCH" && "$GIT_BEHIND" == 0 && "$FORCE" != 1 ]]; then
        ok "already at $STAGE_REF — there is nothing to pull, the installed version is the latest."
        dim "  (use --force to re-apply the tree and restart the service anyway)"
        cleanup_stage
        return 0
    fi
    cleanup_stage

    # ---- 3. swap: stop, back up, apply, start -------------------------------
    say "Plan: apply $STAGE_REF → $APP_DIR, back up to ${BACKUP_ROOT:-$(dirname "$APP_DIR")}, restart $SERVICE_NAME (port $PORT)"
    local was_active=0
    if service_active; then
        was_active=1
        service_stop
    else
        warn "service '$SERVICE_NAME' is not active — updating the files anyway"
    fi

    make_backup

    if ! apply_payload; then
        err "failed to apply the new version"
        if [[ -n "$BACKUP_DIR" ]]; then
            say "tree state is unchanged; backup is at $BACKUP_DIR"
        fi
        if (( was_active )); then service_start; fi
        _post_failure_health
        return 1
    fi

    install_deps
    fix_ownership
    write_marker
    write_state

    say "starting service…"
    service_start

    if health_check "$PORT" 15; then
        ok "Mirage updated successfully (port $PORT is answering)."
        [[ -n "$BACKUP_DIR" ]] && say "Backup: $BACKUP_DIR"
        return 0
    fi

    err "Mirage did not come up after the update."
    dump_start_failure
    if [[ -n "$BACKUP_DIR" ]]; then
        warn "rolling back from $BACKUP_DIR…"
        service_stop
        rm -rf "$APP_DIR"
        mkdir -p "$APP_DIR"
        cp -a "$BACKUP_DIR/." "$APP_DIR/" 2>/dev/null || warn "rollback copy failed"
        fix_ownership
        service_start
        if health_check "$PORT" 15; then
            ok "rolled back — the previous version is running again."
            say "nothing was lost; the failed release was NOT applied."
        else
            err "rollback done but the app still does not answer."
            dump_start_failure
        fi
    else
        warn "no backup was available for rollback."
    fi
    return 1
}

# After a failed start outside the rollback path: report whether the service is up.
_post_failure_health() {
    if health_check "$PORT" 5; then
        ok "the previous version is still serving on port $PORT."
    else
        err "the service is not answering on port $PORT."
        dump_start_failure
    fi
    return 0
}

do_doctor() {
    resolve_installation
    do_status || true
    echo ""
    preflight_update || true
    echo ""
    if (( CHECKS_FAIL )); then
        err "diagnostics: $CHECKS_FAIL problem(s) must be fixed before an update."
        return 1
    fi
    ok "diagnostics: the machine is ready for install/update."
    return 0
}

do_uninstall() {
    ensure_root
    resolve_installation
    print_discovery_report

    if (( ! INSTALLED )) && [[ -z "$SERVICE_UNIT" ]] && [[ -z "$NGINX_CONF" ]]; then
        warn "nothing to uninstall — no installation, unit or vhost detected."
        return 1
    fi

    if [[ "$PURGE_DATA" == 1 ]]; then
        warn "profile data will be deleted along with the installation (--purge-data)."
    else
        say "profile data will be backed up before removal."
    fi
    confirm "Uninstall Mirage from this machine?" no || { say "Uninstallation cancelled."; return 0; }

    service_stop
    if systemd_available && unit_known; then
        systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi

    # data backup
    local data_backup=""
    if [[ "$PURGE_DATA" != 1 ]]; then
        local src_data=""
        [[ -n "$DATA_DIR" && -d "$DATA_DIR" ]] && src_data="$DATA_DIR"
        [[ -z "$src_data" && -d "$APP_DIR/data" ]] && src_data="$APP_DIR/data"
        if [[ -n "$src_data" ]]; then
            local root="${BACKUP_ROOT:-/var/backups}"
            mkdir -p "$root" 2>/dev/null || root="$(dirname "$src_data")"
            data_backup="$root/mirage_data_$(date +%Y%m%d_%H%M%S)"
            if cp -a "$src_data" "$data_backup" 2>/dev/null; then
                ok "profile data saved to $data_backup"
            else
                warn "could not back up $src_data"
                data_backup=""
                confirm "Continue and DELETE the profile data?" no || { say "Aborted — nothing was removed."; return 0; }
            fi
        fi
    fi

    # systemd unit (discovered path, or the default one)
    local unit="${SERVICE_UNIT:-/etc/systemd/system/${SERVICE_NAME%.service}.service}"
    if [[ -f "$unit" ]]; then
        say "removing systemd unit $unit"
        rm -f "$unit"
        systemctl daemon-reload 2>/dev/null || true
        systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
    else
        dim "  no unit file at $unit"
    fi
    # leftover drop-ins
    rm -rf "/etc/systemd/system/${SERVICE_NAME%.service}.service.d" 2>/dev/null || true

    # nginx vhost
    local conf="${NGINX_CONF:-}"
    if [[ -n "$conf" && -f "$conf" ]]; then
        say "removing nginx vhost $conf"
        rm -f "$conf"
        if have nginx && nginx -t >/dev/null 2>&1; then
            systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
        fi
    fi

    # app directory
    if [[ -d "$APP_DIR" ]]; then
        say "removing application directory $APP_DIR"
        rm -rf "$APP_DIR"
    fi

    # app user (only when it is a system user and runs nothing else)
    if id "$APP_USER" >/dev/null 2>&1; then
        local uid
        uid="$(id -u "$APP_USER" 2>/dev/null || echo 0)"
        if (( uid >= 1000 )); then
            dim "  keeping user $APP_USER (regular user account, uid $uid)"
        elif pgrep -u "$APP_USER" >/dev/null 2>&1; then
            warn "user $APP_USER still has running processes — not removing"
        else
            say "removing system user $APP_USER"
            userdel -r "$APP_USER" 2>/dev/null || userdel "$APP_USER" 2>/dev/null || true
        fi
    fi

    # hosts entry
    if [[ "$SET_HOSTS" == 1 && -n "$DOMAIN" ]] && grep -qE "[[:space:]]$DOMAIN([[:space:]]|$)" /etc/hosts 2>/dev/null; then
        say "removing $DOMAIN from /etc/hosts"
        sed -i "\\|[[:space:]]$DOMAIN\\([[:space:]]\|$\\)|d" /etc/hosts 2>/dev/null || true
    fi

    rm -f "$(pidfile)" 2>/dev/null || true
    if [[ -f "$STATE_FILE" ]]; then
        say "removing state file $STATE_FILE"
        rm -f "$STATE_FILE"
    fi

    ok "Mirage uninstalled."
    [[ -n "$data_backup" ]] && say "Profile data kept at: $data_backup"
    say "Note: node/chromium/xvfb/nginx were NOT removed (may be used by other apps)."
    case "$(detect_pm)" in
        apt) say "  to remove them anyway: apt-get remove --purge nodejs chromium xvfb nginx" ;;
        dnf|yum) say "  to remove them anyway: dnf remove nodejs chromium xorg-x11-server-Xvfb nginx" ;;
    esac
    return 0
}

# =============================================================================
#  Menu / CLI
# =============================================================================
show_menu() {
    local detected
    MIRAGE_QUIET=1
    resolve_installation
    MIRAGE_QUIET=0
    if (( INSTALLED )); then
        detected="$APP_DIR  (via $DISCOVERY_SOURCE, port $PORT, user $APP_USER)"
    else
        detected="not found — install (1) or run diagnostics (4)"
    fi
    echo ""
    echo "=========================================="
    echo "  Mirage Deployment Manager"
    echo "=========================================="
    echo "  1) Install Mirage"
    echo "  2) Update Mirage"
    echo "  3) Uninstall Mirage"
    echo "  4) Status / diagnostics (pre-flight)"
    echo "  5) Exit"
    echo "------------------------------------------"
    printf '  detected: %s\n' "$detected"
    echo "=========================================="
    echo ""
}

menu_loop() {
    while true; do
        show_menu
        if [[ ! -t 0 ]]; then
            warn "no terminal for the interactive menu — use --install/--update/--uninstall/--status"
            return 2
        fi
        local choice=""
        read -r -p "Select an option (1-5): " choice || choice=""
        case "$choice" in
            1) do_install || true ;;
            2) do_update || true ;;
            3) do_uninstall || true ;;
            4) do_doctor || true ;;
            5) say "Exiting…"; return 0 ;;
            *) warn "Invalid option. Please select 1-5." ;;
        esac
        pause
    done
}

main() {
    ORIG_ARGS=("$@")
    local action=""
    while (($#)); do
        case "$1" in
            -h|--help|help) usage; return 0 ;;
            -i|--install)   action=install ;;
            -u|--update)    action=update ;;
            -U|--uninstall|--remove) action=uninstall ;;
            -s|--status|--find) action=status ;;
            -d|--doctor|--preflight|--diagnose) action=doctor ;;
            -m|--menu)      action=menu ;;
            -y|--yes|--assume-yes) MIRAGE_ASSUME_YES=1 ;;
            --purge-data)   PURGE_DATA=1 ;;
            --force)        FORCE=1 ;;
            --fast|--no-fs-scan) MIRAGE_NO_FS_SCAN=1 ;;
            --skip-smoke|--no-smoke) SKIP_SMOKE=1 ;;
            --offline) OFFLINE=1 ;;
            --no-hosts)     SET_HOSTS=0 ;;
            --no-sudo)      MIRAGE_NO_SUDO=1 ;;
            --app-dir|--dir|--path)
                [[ -n "${2:-}" ]] || die "--app-dir requires a value"
                APP_DIR_ENV="$2"; shift ;;
            --user)    [[ -n "${2:-}" ]] || die "--user requires a value";    APP_USER_ENV="$2"; shift ;;
            --port)    [[ -n "${2:-}" ]] || die "--port requires a value";    PORT_ENV="$2"; shift ;;
            --domain)  [[ -n "${2:-}" ]] || die "--domain requires a value";  DOMAIN_ENV="$2"; shift ;;
            --service) [[ -n "${2:-}" ]] || die "--service requires a value"; SERVICE_NAME_ENV="$2"; shift ;;
            --repo)    [[ -n "${2:-}" ]] || die "--repo requires a value";    REPO="$2"; shift ;;
            --branch|--ref|--tag)
                [[ -n "${2:-}" ]] || die "--branch requires a value"
                BRANCH_ENV="$2"; shift ;;
            *) warn "unknown option: $1"; usage; return 2 ;;
        esac
        shift
    done

    if [[ -z "$action" ]]; then
        if [[ -t 0 && -t 1 ]]; then action=menu; else usage; return 2; fi
    fi

    case "$action" in
        status)
            do_status || true
            ;;
        doctor)
            do_doctor || true
            ;;
        install|update|uninstall)
            ensure_root
            case "$action" in
                install)   do_install ;;
                update)    do_update ;;
                uninstall) do_uninstall ;;
            esac
            ;;
        menu) menu_loop ;;
    esac
    return 0
}

# Allow the discovery helpers to be unit-tested: `source deploy.sh` does not run main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
