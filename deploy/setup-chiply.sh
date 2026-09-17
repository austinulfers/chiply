#!/usr/bin/env bash
# Install chiply as an app on an already-provisioned OffHoursLab host.
# Run provision-server.sh first (nginx, certbot, ufw, swap).
#
# Creates:
#   - chiply            service user (nologin, runs the app, read-only on code)
#   - deploy-chiply     deploy user  (owns /opt/chiply, may restart ONLY chiply)
#   - /opt/chiply       git checkout
#   - /var/lib/chiply   rooms.json (service-owned; the ONE place the app can write)
#   - systemd unit chiply.service (PORT 3005 + MemoryMax + hardening)
#   - nginx vhost chiply.offhourslab.com -> 127.0.0.1:3005 (WebSockets on /ws)
#   - Let's Encrypt certificate
#
# No secrets, so no env file. No backups, by design: rooms expire after 24h idle
# and the server skips expired rooms on load, so any restore would be empty.
# rooms.json exists only so live games survive restarts and deploys.
#
# Idempotent — safe to re-run. Existing rooms are preserved.
#
# Usage (as root on the server):
#   GITHUB_DEPLOY_KEY="ssh-ed25519 AAAA… github-actions-deploy" ./setup-chiply.sh
#   SKIP_CERT=1 ./setup-chiply.sh          # e.g. DNS not pointed here yet
#   CERTBOT_EMAIL=you@example.com ./setup-chiply.sh   # a box with no Let's Encrypt account yet
#
# From your laptop:
#   scp deploy/setup-chiply.sh offhourslab:/root/ && ssh -t offhourslab /root/setup-chiply.sh

set -euo pipefail

APP=chiply
DOMAIN=${DOMAIN:-chiply.offhourslab.com}
# 3000 megahex, 3001 planta-notify, 3003 veritas-boat-logs, 3004 understudy-website;
# 3002 stays unused (parle-in-paris, decommissioned, still defaults to it).
# Registry lives in deploy/provision-server.sh.
PORT=${PORT:-3005}
MEMORY_MAX=${MEMORY_MAX:-192M}
REPO=${REPO:-https://github.com/austinulfers/chiply.git}
BRANCH=${BRANCH:-main}
APP_DIR=/opt/$APP
DATA_DIR=/var/lib/$APP
DEPLOY_USER=deploy-$APP
SKIP_CERT=${SKIP_CERT:-0}

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root." >&2
  exit 1
fi
command -v nginx >/dev/null || { echo "nginx missing — run provision-server.sh first." >&2; exit 1; }
command -v node >/dev/null || { echo "node missing — run provision-server.sh first." >&2; exit 1; }

# MemoryHigh (soft throttle) at 75% of MemoryMax (hard kill).
[[ $MEMORY_MAX =~ ^[0-9]+M$ ]] || { echo "MEMORY_MAX must look like 192M" >&2; exit 1; }
MEMORY_HIGH=$(( ${MEMORY_MAX%M} * 3 / 4 ))M

# Refuse to steal a port another app is already serving on.
if ss -tlnpH 2>/dev/null | grep -q ":$PORT .*users:" && \
   ! systemctl is-active --quiet "$APP"; then
  echo "Port $PORT is already in use by another process. Pick a free PORT." >&2
  ss -tlnp | grep ":$PORT " >&2 || true
  exit 1
fi

log "Creating users"
id -u "$APP" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP"
id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"

log "Preparing $APP_DIR"
mkdir -p "$APP_DIR"
chown -R "$DEPLOY_USER:$APP" "$APP_DIR"
sudo -u "$DEPLOY_USER" git config --global --add safe.directory "$APP_DIR"

if [[ -d $APP_DIR/.git ]]; then
  echo "checkout exists, fetching"
  sudo -u "$DEPLOY_USER" git -C "$APP_DIR" fetch --all --quiet
  sudo -u "$DEPLOY_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH" --quiet
else
  sudo -u "$DEPLOY_USER" git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

# Deploy user writes; service user only reads (group). No world access.
chown -R "$DEPLOY_USER:$APP" "$APP_DIR"
chmod -R g+rX,o-rwx "$APP_DIR"

log "Installing production dependencies"
sudo -u "$DEPLOY_USER" env -C "$APP_DIR" npm install --omit=dev --no-audit --no-fund

log "Preparing data dir $DATA_DIR"
# Unlike the code dir, this is owned by the SERVICE user — it is the one
# path the app may write (enforced by ReadWritePaths in the unit).
install -d -m 750 -o "$APP" -g "$APP" "$DATA_DIR"

log "Granting $DEPLOY_USER permission to restart ONLY $APP"
cat >"/etc/sudoers.d/$DEPLOY_USER" <<EOF
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $APP, /usr/bin/systemctl is-active $APP, /usr/bin/systemctl status $APP
EOF
chmod 440 "/etc/sudoers.d/$DEPLOY_USER"
visudo -cqf "/etc/sudoers.d/$DEPLOY_USER"

log "Writing systemd unit"
cat >"/etc/systemd/system/$APP.service" <<EOF
[Unit]
Description=Chiply poker chip tracker
After=network.target

[Service]
Type=simple
User=$APP
Group=$APP
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
# Loopback only — nginx is the only thing that should reach this port.
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

# Cap memory so one app cannot OOM-kill its neighbours on a small box.
MemoryMax=$MEMORY_MAX
MemoryHigh=$MEMORY_HIGH

# Hardening. ProtectSystem=strict makes the whole FS read-only for the
# service; ReadWritePaths carves out the single directory rooms.json lives in.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
RestrictSUIDSGID=true
# NOTE: MemoryDenyWriteExecute is deliberately NOT set — V8's JIT needs
# write+execute pages and Node dies with SIGTRAP during startup if it is on.

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$APP"
systemctl restart "$APP"

# Restart=always means a crash-looping unit reports "activating", not "failed",
# so poll for a genuinely running state instead of trusting one is-active call.
state=unknown
for _ in $(seq 1 10); do
  state=$(systemctl is-active "$APP" || true)
  [[ $state == active ]] && break
  sleep 1
done
if [[ $state != active ]]; then
  echo "ERROR: $APP did not come up (state=$state)" >&2
  journalctl -u "$APP" -n 30 --no-pager >&2
  exit 1
fi
echo "$APP is active"

log "Writing nginx vhost"
# Plain HTTP only here; certbot adds the TLS server block and the redirect.
cat >"/etc/nginx/sites-available/$APP" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # The app accepts no HTTP request bodies; game traffic is WebSocket frames,
    # which the app itself caps at 16 KB.
    client_max_body_size 16k;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        # \$connection_upgrade comes from conf.d/websocket-upgrade.conf
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # WebSockets are long-lived and idle between hands.
        proxy_read_timeout 300s;
    }

    # A lapsed cert kills the PWA's service worker, so HSTS doubles as
    # insurance against accidental plain-HTTP regressions.
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
}
EOF
ln -sfn "/etc/nginx/sites-available/$APP" "/etc/nginx/sites-enabled/$APP"
nginx -t
systemctl reload nginx

if [[ $SKIP_CERT == 1 ]]; then
  log "SKIP_CERT=1 — serving plain HTTP only. Add TLS later with:"
  echo "  certbot --nginx -d $DOMAIN --redirect"
elif [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  # The vhost above was just overwritten as HTTP-only, so an existing cert still
  # needs its server block re-installed — otherwise the site drops to port 80.
  log "Certificate exists for $DOMAIN — reinstalling into the vhost"
  certbot install --nginx --cert-name "$DOMAIN" --redirect -n
  nginx -t && systemctl reload nginx
else
  log "Requesting certificate for $DOMAIN"
  # -n keeps this non-interactive when run over plain ssh; a box that already
  # has a Let's Encrypt account needs no email, a fresh one does.
  cert_args=(--nginx -d "$DOMAIN" --redirect --agree-tos --no-eff-email -n)
  [[ -n ${CERTBOT_EMAIL:-} ]] && cert_args+=(--email "$CERTBOT_EMAIL")
  certbot "${cert_args[@]}"
fi

log "Installing deploy key (if provided)"
# Add the CI public key with GITHUB_DEPLOY_KEY="ssh-ed25519 AAAA... github-actions-deploy"
if [[ -n ${GITHUB_DEPLOY_KEY:-} ]]; then
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  AK="/home/$DEPLOY_USER/.ssh/authorized_keys"
  touch "$AK"
  LINE="restrict,pty $GITHUB_DEPLOY_KEY"
  grep -qF "$GITHUB_DEPLOY_KEY" "$AK" || echo "$LINE" >>"$AK"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$AK"
  chmod 600 "$AK"
  echo "installed"
else
  echo "GITHUB_DEPLOY_KEY not set — add the CI public key to /home/$DEPLOY_USER/.ssh/authorized_keys manually."
fi

log "Done"
cat <<EOF

  App:      https://$DOMAIN
  Service:  systemctl status $APP   |   journalctl -u $APP -f
  Port:     127.0.0.1:$PORT (not internet-reachable)
  Code:     $APP_DIR (owned by $DEPLOY_USER, read by $APP)
  Data:     $DATA_DIR/rooms.json (ephemeral: rooms expire after 24h idle; not backed up)

  GitHub secrets for the deploy workflow:
    DEPLOY_HOST     = this server's IP
    DEPLOY_USER     = $DEPLOY_USER
    DEPLOY_SSH_KEY  = private half of the CI deploy key
EOF
