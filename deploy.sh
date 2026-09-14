#!/usr/bin/env bash
# Mirage — one-shot deploy on any Linux server (Debian/Ubuntu/RHEL).
# Idempotent: safe to re-run. Installs node 22 + chromium + Xvfb + nginx, drops a systemd unit
# and an nginx vhost, and starts the service. Edit the vars below or override via env.
set -euo pipefail

DOMAIN="${DOMAIN:-mirage.local}"
APP_USER="${APP_USER:-mirage}"
PORT="${PORT:-7788}"
APP_DIR="${APP_DIR:-/opt/mirage}"
REPO="${REPO:-}"                 # optional git URL to clone instead of copying this tree
RUN_AS_ROOT_OK="${RUN_AS_ROOT_OK:-0}"

say()  { printf '\033[36m[mirage]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[fatal]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo bash deploy.sh)"

# ---- package manager ----
if   command -v apt-get >/dev/null 2>&1; then PM=apt;  PKG=("chromium" "xvfb" "nginx" "curl" "ca-certificates" "gnupg")
elif command -v dnf >/dev/null 2>&1;     then PM=dnf;  PKG=("chromium" "xorg-x11-server-Xvfb" "nginx" "curl" "ca-certificates")
else die "unsupported package manager (need apt or dnf)"; fi
say "package manager: $PM"

# ---- node >= 22 ----
if command -v node >/dev/null 2>&1 && node -e 'process.exit(process.versions.node.split(".")[0]>=22?0:1)' 2>/dev/null; then
  ok "node $(node -v) already present"
else
  say "installing node 22…"
  if [[ "$PM" == apt ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get update -y; apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null
    dnf install -y nodejs
  fi
  ok "node $(node -v)"
fi
command -v node >/dev/null 2>&1 || die "node not found after install"
NODE_BIN="$(command -v node)"

# ---- system deps ----
say "installing $PM packages: ${PKG[*]}"
if [[ "$PM" == apt ]]; then apt-get update -y; apt-get install -y "${PKG[@]}"; else dnf install -y "${PKG[@]}"; fi

# chromium binary name normalisation
CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
[[ -n "$CHROME" ]] || die "chromium not found after install"

# ---- app user ----
if ! id "$APP_USER" >/dev/null 2>&1; then useradd -r -m -s /usr/sbin/nologin "$APP_USER"; fi

# ---- app files ----
mkdir -p "$APP_DIR"
if [[ -n "$REPO" ]]; then
  say "cloning $REPO → $APP_DIR"
  TMP="$(mktemp -d)"; git clone --depth 1 "$REPO" "$TMP"; cp -r "$TMP/." "$APP_DIR/"; rm -rf "$TMP"
else
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  say "copying tree from $SRC → $APP_DIR"
  cp -r "$SRC/." "$APP_DIR/"
fi
grep -q '"type":"module"' "$APP_DIR/package.json" 2>/dev/null || die "package.json not found at $APP_DIR (wrong source?)"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---- systemd unit ----
say "writing systemd unit → /etc/systemd/system/mirage.service"
cat >/etc/systemd/system/mirage.service <<EOF
[Unit]
Description=Mirage anti-detect browser
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# ---- nginx vhost ----
say "writing nginx vhost → /etc/nginx/conf.d/mirage.conf"
cat >/etc/nginx/conf.d/mirage.conf <<EOF
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

# ---- /etc/hosts for local name ----
if ! grep -q "$DOMAIN" /etc/hosts; then echo "127.0.0.1 $DOMAIN" >>/etc/hosts; fi

# ---- start ----
say "enabling & starting services"
systemctl daemon-reload
systemctl enable --now mirage
nginx -t && systemctl reload nginx || systemctl restart nginx

sleep 2
if systemctl is-active --quiet mirage; then ok "mirage service is up"; else die "mirage failed to start — see: journalctl -u mirage -n 50"; fi

echo
ok "Mirage deployed."
say "Open:        http://$DOMAIN  (or http://127.0.0.1:$PORT)"
say "Default PIN: mirage   — change it in Team immediately."
say "Logs:        journalctl -u mirage -f"
say "Chromium:    $CHROME"
