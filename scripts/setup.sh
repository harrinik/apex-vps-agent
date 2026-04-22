#!/usr/bin/env bash
# Apex Mail Cloud — VPS Agent v2 Setup Script
# Run as root on a fresh Ubuntu 22.04 VPS
# Usage: ./scripts/setup.sh
set -euo pipefail

AGENT_DIR="/opt/apex-vps-agent"
LOG_DIR="/var/log/apex-vps-agent"
NODE_MAJOR=20

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*" >&2; }

# ── 0. Root check ─────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root"
  exit 1
fi

info "Apex VPS Agent v2 setup starting..."

# ── 1. Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'console.log(parseInt(process.version.slice(1)))')" -lt "$NODE_MAJOR" ]]; then
  info "Installing Node.js ${NODE_MAJOR}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
info "Node.js $(node -v) — OK"

# ── 2. PM2 ────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2..."
  npm install -g pm2
fi
info "PM2 $(pm2 -v) — OK"

# ── 3. Log directory ──────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
info "Log dir $LOG_DIR — OK"

# ── 4. OpenDKIM directories ───────────────────────────────────────────────────
mkdir -p /etc/opendkim/keys
touch /etc/opendkim/KeyTable /etc/opendkim/SigningTable /etc/opendkim/TrustedHosts
info "OpenDKIM dirs — OK"

# ── 5. Postfix virtual files ──────────────────────────────────────────────────
touch /etc/postfix/vmailbox /etc/postfix/vdomains /etc/postfix/virtual
info "Postfix virtual files — OK"

# ── 6. Dovecot passwd ─────────────────────────────────────────────────────────
if [[ ! -f /etc/dovecot/passwd ]]; then
  touch /etc/dovecot/passwd
  chown root:dovecot /etc/dovecot/passwd
  chmod 640 /etc/dovecot/passwd
fi
info "Dovecot passwd file — OK"

# ── 7. Install agent dependencies ────────────────────────────────────────────
info "Installing npm dependencies..."
cd "$AGENT_DIR"
npm ci --omit=dev

# ── 8. Build TypeScript ───────────────────────────────────────────────────────
info "Building TypeScript..."
npm run build

# ── 9. .env check ────────────────────────────────────────────────────────────
if [[ ! -f "$AGENT_DIR/.env" ]]; then
  warn ".env not found — copying from .env.example"
  cp "$AGENT_DIR/.env.example" "$AGENT_DIR/.env"
  warn "IMPORTANT: Edit $AGENT_DIR/.env with your Supabase credentials before starting"
fi

# ── 10. PM2 setup ─────────────────────────────────────────────────────────────
pm2 start "$AGENT_DIR/ecosystem.config.cjs" --env production
pm2 save
pm2 startup | tail -1 | bash || true

info ""
info "========================================="
info " Apex VPS Agent v2 installed successfully"
info "========================================="
info ""
info "  Status:  pm2 status"
info "  Logs:    pm2 logs apex-vps-agent"
info "  Health:  curl http://localhost:3001/health/ready"
info "  Restart: pm2 restart apex-vps-agent"
info ""
info "NEXT: Edit /opt/apex-vps-agent/.env with your credentials, then:"
info "  pm2 restart apex-vps-agent"