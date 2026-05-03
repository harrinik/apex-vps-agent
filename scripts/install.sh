#!/usr/bin/env bash
# ==============================================================================
#  Apex Mail Cloud — Full Stack Installer v2
#  Installs + configures: Postfix, Dovecot, OpenDKIM, UFW, Node.js, PM2,
#  and the vps-agent. Writes .env from interactive prompts.
#
#  OS Support: Ubuntu 20.04 / 22.04 / 24.04, Debian 11 / 12
#  Run as:     root
#  Usage:      ./install.sh [--resume]
# ==============================================================================
set -euo pipefail
IFS=$'\n\t'

# ── Globals ───────────────────────────────────────────────────────────────────
SCRIPT_VERSION="2.0.0"
AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/var/log/apex-install-$(date +%Y%m%d-%H%M%S).log"
STEP_FILE="/var/lib/apex-install-progress"
BACKUP_DIR="/var/backups/apex-pre-install-$(date +%Y%m%d)"
NODE_MAJOR=20
RESUME=false
[[ "${1:-}" == "--resume" ]] && RESUME=true

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
BLU='\033[0;34m'; CYN='\033[0;36m'; BLD='\033[1m'; NC='\033[0m'

log()     { echo -e "${BLU}[INFO]${NC}    $*" | tee -a "$LOG_FILE"; }
success() { echo -e "${GRN}[OK]${NC}      $*" | tee -a "$LOG_FILE"; }
warn()    { echo -e "${YLW}[WARN]${NC}    $*" | tee -a "$LOG_FILE"; }
error()   { echo -e "${RED}[ERROR]${NC}   $*" | tee -a "$LOG_FILE" >&2; }
step()    { echo -e "\n${BLD}${CYN}━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" | tee -a "$LOG_FILE"; }
die()     { error "$*"; exit 1; }

# ── Init log ─────────────────────────────────────────────────────────────────
mkdir -p /var/log /var/lib /var/backups
touch "$LOG_FILE"
log "Apex Mail Cloud Installer v${SCRIPT_VERSION} started at $(date)"
log "Log: $LOG_FILE"

# ── Trap: print log path on error ────────────────────────────────────────────
trap 'error "Install failed at line ${LINENO}. See $LOG_FILE for details."' ERR

# ── Step tracking (idempotent resume) ────────────────────────────────────────
step_done() { grep -qxF "$1" "$STEP_FILE" 2>/dev/null; }
mark_done() { echo "$1" >> "$STEP_FILE"; }
skip_if_done() {
  if step_done "$1"; then
    warn "Step '$1' already completed — skipping (use fresh run to redo)"
    return 0
  fi
  return 1
}

# ── Retry wrapper ─────────────────────────────────────────────────────────────
retry() {
  local n=0 max=5 delay=5 cmd=("$@")
  until "${cmd[@]}"; do
    ((n++)) && [[ $n -ge $max ]] && die "Command failed after ${max} attempts: ${cmd[*]}"
    warn "Attempt $n/$max failed, retrying in ${delay}s…"
    sleep $delay
    delay=$((delay * 2))
  done
}

# ── Service control with verification ────────────────────────────────────────
svc_stop() {
  local svc="$1"
  log "Stopping $svc…"
  systemctl stop "$svc" 2>>"$LOG_FILE" || true
}

svc_start() {
  local svc="$1"
  log "Starting $svc…"
  systemctl start "$svc" 2>>"$LOG_FILE" || {
    warn "$svc failed to start — check: journalctl -u $svc -n 50"
  }
  sleep 1
  if systemctl is-active --quiet "$svc"; then
    success "$svc is running"
  else
    warn "$svc may not be running — check: journalctl -u $svc -n 50"
  fi
}

svc_restart() {
  local svc="$1"
  log "Restarting $svc…"
  systemctl restart "$svc" 2>>"$LOG_FILE" || systemctl start "$svc" 2>>"$LOG_FILE" || {
    warn "$svc failed to restart — attempting reload"
    systemctl reload "$svc" 2>>"$LOG_FILE" || true
  }
  sleep 1
  if systemctl is-active --quiet "$svc"; then
    success "$svc is running"
  else
    warn "$svc may not be running — check: journalctl -u $svc -n 50"
  fi
}

svc_enable() {
  systemctl enable "$1" 2>>"$LOG_FILE" || true
}

# ── Backup a file before modifying ────────────────────────────────────────────
backup_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  mkdir -p "$BACKUP_DIR"
  local dest="${BACKUP_DIR}${f//\//_}"
  cp "$f" "$dest" 2>>"$LOG_FILE" && log "Backed up $f → $dest"
}

# ── Strip CRLF from a file (safe when script itself was cloned on Windows) ────
strip_crlf() { sed -i 's/\r//' "$1" 2>/dev/null || true; }

# ── Port listening check ───────────────────────────────────────────────────────
port_listening() {
  ss -tlnp 2>/dev/null | grep -q ":${1} " || \
  netstat -tlnp 2>/dev/null | grep -q ":${1} " || \
  nc -z 127.0.0.1 "$1" 2>/dev/null
}

# ==============================================================================
# 0. Pre-flight checks
# ==============================================================================
step "Pre-flight checks"

[[ $EUID -ne 0 ]] && die "Must be run as root. Use: sudo $0"

# OS check
OS_ID=$(grep -oP '(?<=^ID=).+' /etc/os-release | tr -d '"' || echo "unknown")
OS_VER=$(grep -oP '(?<=^VERSION_ID=).+' /etc/os-release | tr -d '"' || echo "0")
log "Detected OS: $OS_ID $OS_VER"
case "$OS_ID" in
  ubuntu|debian) ;;
  *) warn "Untested OS '$OS_ID'. Proceeding anyway — results may vary." ;;
esac

# Architecture
ARCH=$(uname -m)
[[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]] && warn "Untested architecture: $ARCH"

# Disk space (require 2GB free)
FREE_MB=$(df / --output=avail -BM | tail -1 | tr -d 'M ')
[[ "$FREE_MB" -lt 2048 ]] && die "Less than 2GB free disk space (${FREE_MB}MB). Aborting."
log "Free disk: ${FREE_MB}MB — OK"

# Memory (warn < 1GB)
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
[[ "$MEM_MB" -lt 1024 ]] && warn "Only ${MEM_MB}MB RAM detected. 1GB+ recommended."

# Internet connectivity
if ! curl -fsS --max-time 10 https://google.com >/dev/null 2>&1; then
  die "No internet connectivity detected. Check your network and try again."
fi
success "Pre-flight checks passed"

# ==============================================================================
# 1. Interactive Configuration
# ==============================================================================
if ! step_done "config_collected" || [[ "$RESUME" == false ]]; then

  clear
  echo -e "${BLD}"
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║         Apex Mail Cloud — Full Stack Setup Wizard           ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo -e "${NC}"

  # Helper: prompt with default
  ask() {
    local var="$1" prompt="$2" default="$3"
    local input
    while true; do
      read -rp "$(echo -e "${CYN}?${NC} $prompt${default:+ [${default}]}: ")" input
      input="${input:-$default}"
      [[ -n "$input" ]] && { printf -v "$var" '%s' "$input"; break; }
      warn "Value required."
    done
  }

  # Helper: silent prompt with confirmation
  ask_pass() {
    local var="$1" prompt="$2"
    local p1 p2
    while true; do
      read -rsp "$(echo -e "${CYN}?${NC} $prompt: ")" p1; echo
      read -rsp "$(echo -e "${CYN}?${NC} Confirm $prompt: ")" p2; echo
      [[ "$p1" == "$p2" && -n "$p1" ]] && { printf -v "$var" '%s' "$p1"; break; }
      warn "Passwords don't match or empty. Try again."
    done
  }

  echo -e "\n${BLD}── Mail Server ─────────────────────────────────────────${NC}"
  ask HOSTNAME      "Full hostname (FQDN)"              "mx1.yourdomain.com"
  ask DOMAIN        "Primary domain"                    "$(echo "$HOSTNAME" | cut -d. -f2-)"
  ask CERT_EMAIL    "Email for SSL certificate"         "admin@${DOMAIN}"

  echo -e "\n${BLD}── Dovecot Master User ─────────────────────────────────${NC}"
  ask MASTER_USER   "Master user email"                 "masteradmin@${DOMAIN}"
  ask_pass MASTER_PASS "Master user password"

  echo -e "\n${BLD}── VPS Agent ───────────────────────────────────────────${NC}"
  ask SUPABASE_URL        "Supabase project URL"        "https://your-project.supabase.co"
  ask SUPABASE_SERVICE_KEY "Supabase service role key"  ""
  ask API_BEARER_TOKEN    "Agent API bearer token (leave blank to auto-generate)" ""
  [[ -z "$API_BEARER_TOKEN" ]] && API_BEARER_TOKEN=$(openssl rand -hex 32)
  ask API_PORT           "Agent API port"               "3001"
  ask DKIM_SELECTOR      "DKIM selector"                "apexmail"

  echo ""
  echo -e "${BLD}── Summary ─────────────────────────────────────────────${NC}"
  echo "  Hostname:         $HOSTNAME"
  echo "  Primary domain:   $DOMAIN"
  echo "  SSL email:        $CERT_EMAIL"
  echo "  Master user:      $MASTER_USER"
  echo "  Supabase URL:     $SUPABASE_URL"
  echo "  Agent port:       $API_PORT"
  echo "  DKIM selector:    $DKIM_SELECTOR"
  echo -e "${BLD}────────────────────────────────────────────────────────${NC}"
  read -rp "$(echo -e "${CYN}?${NC} Proceed with installation? [y/N]: ")" CONFIRM
  [[ ! "$CONFIRM" =~ ^[Yy]$ ]] && die "Aborted by user."

  # Persist values for resume
  cat > /var/lib/apex-install-vars <<VARSEOF
HOSTNAME="${HOSTNAME}"
DOMAIN="${DOMAIN}"
CERT_EMAIL="${CERT_EMAIL}"
MASTER_USER="${MASTER_USER}"
MASTER_PASS="${MASTER_PASS}"
SUPABASE_URL="${SUPABASE_URL}"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_KEY}"
API_BEARER_TOKEN="${API_BEARER_TOKEN}"
API_PORT="${API_PORT}"
DKIM_SELECTOR="${DKIM_SELECTOR}"
VARSEOF
  chmod 600 /var/lib/apex-install-vars
  mark_done "config_collected"

else
  log "Resuming — loading saved config"
  # shellcheck disable=SC1091
  source /var/lib/apex-install-vars
fi

log "Config loaded. Hostname=$HOSTNAME Domain=$DOMAIN"

# ==============================================================================
# 2. System update + package install
# ==============================================================================
step "System update and package installation"
if ! skip_if_done "packages_installed"; then
  log "Updating apt cache…"
  retry apt-get update -qq

  log "Upgrading existing packages…"
  DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq 2>>"$LOG_FILE" || \
    warn "Some packages failed to upgrade — continuing"

  log "Installing required packages…"
  DEBIAN_FRONTEND=noninteractive retry apt-get install -y -qq \
    postfix postfix-pgsql \
    dovecot-core dovecot-imapd dovecot-pop3d dovecot-lmtpd \
    opendkim opendkim-tools \
    certbot \
    ufw \
    curl wget ca-certificates gnupg2 \
    openssl dnsutils \
    logrotate fail2ban \
    net-tools 2>>"$LOG_FILE"

  success "Packages installed"
  mark_done "packages_installed"
fi

# ==============================================================================
# 3. Hostname
# ==============================================================================
step "Hostname configuration"
if ! skip_if_done "hostname_set"; then
  log "Setting hostname to $HOSTNAME"
  hostnamectl set-hostname "$HOSTNAME" 2>>"$LOG_FILE"
  backup_file /etc/hosts

  # Idempotent hosts update
  sed -i "/^127\.0\.1\.1 /d" /etc/hosts
  echo "127.0.1.1 $HOSTNAME" >> /etc/hosts

  echo "$DOMAIN" > /etc/mailname
  success "Hostname: $(hostname --fqdn)"
  mark_done "hostname_set"
fi

# ==============================================================================
# 4. vmail system user
# ==============================================================================
step "vmail user"
if ! skip_if_done "vmail_user"; then
  if ! id vmail &>/dev/null; then
    groupadd -g 5000 vmail 2>>"$LOG_FILE" || true
    useradd -g vmail -u 5000 vmail -d /var/mail/vhosts -m -s /sbin/nologin 2>>"$LOG_FILE" || true
    success "vmail user created (uid=5000)"
  else
    success "vmail user already exists"
  fi
  mkdir -p /var/mail/vhosts
  chown -R vmail:vmail /var/mail/vhosts
  mark_done "vmail_user"
fi

# ==============================================================================
# 5. SSL / TLS Certificate
# ==============================================================================
step "SSL certificate"
if ! skip_if_done "ssl_cert"; then
  CERT_DIR="/etc/letsencrypt/live/$HOSTNAME"
  CERT_OK=false

  # Stop services that bind port 80 to allow standalone certbot
  systemctl stop apache2 nginx 2>/dev/null || true

  log "Requesting Let's Encrypt certificate for $HOSTNAME…"
  ATTEMPTS=0
  while [[ $ATTEMPTS -lt 3 && "$CERT_OK" == false ]]; do
    if certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "$CERT_EMAIL" \
        -d "$HOSTNAME" \
        2>>"$LOG_FILE"; then
      CERT_OK=true
      success "Let's Encrypt certificate obtained"
    else
      ATTEMPTS=$((ATTEMPTS + 1))
      warn "Certbot attempt $ATTEMPTS/3 failed. Retrying in 30s…"
      [[ $ATTEMPTS -lt 3 ]] && sleep 30
    fi
  done

  if [[ "$CERT_OK" == false ]]; then
    warn "Let's Encrypt failed (DNS not yet propagated or port 80 blocked)"
    warn "Generating self-signed certificate as fallback — replace when DNS is ready"
    mkdir -p "$CERT_DIR"
    openssl req -new -newkey rsa:4096 -days 3650 -nodes -x509 \
      -subj "/C=US/O=ApexCloud/CN=$HOSTNAME" \
      -keyout "$CERT_DIR/privkey.pem" \
      -out "$CERT_DIR/fullchain.pem" 2>>"$LOG_FILE"
    cp "$CERT_DIR/fullchain.pem" "$CERT_DIR/chain.pem"
    success "Self-signed certificate generated (valid 10 years)"
    warn "⚠  Run 'certbot certonly --standalone -d $HOSTNAME' later to get a real cert"
  fi

  # Set up auto-renewal cron (idempotent)
  if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
    # Create temp file with cron job
    TMP_CRON=$(mktemp)
    crontab -l 2>/dev/null > "$TMP_CRON" || true
    echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload postfix dovecot' >> /var/log/certbot-renew.log 2>&1" >> "$TMP_CRON"
    crontab "$TMP_CRON"
    rm -f "$TMP_CRON"
    success "Certbot auto-renewal cron installed"
  fi

  mark_done "ssl_cert"
fi

# ==============================================================================
# 6. Postfix
# ==============================================================================
step "Postfix configuration"
if ! skip_if_done "postfix_configured"; then
  backup_file /etc/postfix/main.cf
  backup_file /etc/postfix/master.cf

  CERT_DIR="/etc/letsencrypt/live/$HOSTNAME"

  cat > /etc/postfix/main.cf <<PFEOF
# ── Apex Mail Cloud — Postfix main.cf ─────────────────────────────────────────
myhostname = $HOSTNAME
mydomain   = $DOMAIN
myorigin   = /etc/mailname
mydestination = localhost, $DOMAIN
relayhost =
mynetworks = 127.0.0.0/8 [::ffff:127.0.0.0]/104 [::1]/128
mailbox_size_limit = 0
recipient_delimiter = +
inet_interfaces = all
inet_protocols = all

# ── TLS ───────────────────────────────────────────────────────────────────────
smtpd_tls_cert_file = ${CERT_DIR}/fullchain.pem
smtpd_tls_key_file  = ${CERT_DIR}/privkey.pem
smtpd_tls_security_level = may
smtpd_tls_auth_only = yes
smtpd_tls_loglevel  = 1
smtpd_tls_protocols = !SSLv2,!SSLv3,!TLSv1,!TLSv1.1
smtpd_tls_ciphers   = high
smtpd_tls_session_cache_database = btree:\${data_directory}/smtpd_scache

smtp_tls_security_level          = may
smtp_tls_session_cache_database  = btree:\${data_directory}/smtp_scache

# ── SASL (Dovecot) ────────────────────────────────────────────────────────────
smtpd_sasl_type        = dovecot
smtpd_sasl_path        = private/auth
smtpd_sasl_auth_enable = yes

# ── SMTP Restrictions ─────────────────────────────────────────────────────────
smtpd_recipient_restrictions =
    permit_sasl_authenticated,
    permit_mynetworks,
    reject_unauth_destination

smtpd_relay_restrictions =
    permit_sasl_authenticated,
    permit_mynetworks,
    reject_unauth_destination

# ── Virtual Mailboxes ─────────────────────────────────────────────────────────
virtual_mailbox_domains = /etc/postfix/vdomains
virtual_mailbox_base    = /var/mail/vhosts
virtual_mailbox_maps    = hash:/etc/postfix/vmailbox
virtual_minimum_uid     = 100
virtual_uid_maps        = static:5000
virtual_gid_maps        = static:5000
virtual_transport       = lmtp:unix:private/dovecot-lmtp

# ── DKIM (AWS SES handles DKIM for outgoing emails) ─────────────────────────
# No OpenDKIM milter needed - AWS SES signs outgoing emails
# VPS only handles incoming mail reception

# ── RSPAMD Milter (Spam Filtering) ───────────────────────────────────────────
smtpd_milters = inet:localhost:11332
non_smtpd_milters = $smtpd_milters
milter_default_action = accept
milter_protocol = 6
milter_connect_timeout = 30s
milter_command_timeout = 30s
milter_content_timeout = 300s
milter_data_timeout = 30s

# ── Rate limiting & anti-spam ─────────────────────────────────────────────────
smtpd_client_connection_count_limit = 50
smtpd_client_connection_rate_limit  = 60
smtpd_error_sleep_time              = 1s
smtpd_soft_error_limit              = 10
smtpd_hard_error_limit              = 20

# ── Detailed Logging for Abuse Control ───────────────────────────────────────
smtpd_data_restrictions = reject_unauth_pipelining, permit
smtpd_recipient_limit = 1000
smtpd_sender_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_non_fqdn_sender, reject_sender_login_mismatch

# Log all headers for abuse control
smtpd_delay_reject = yes
disable_vrfy_command = yes
smtpd_helo_required = yes
smtpd_helo_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_invalid_helo_hostname, reject_non_fqdn_helo_hostname

# Log message ID, client IP, size, and all headers
header_checks = pcre:/etc/postfix/header_checks.pcre
body_checks = pcre:/etc/postfix/body_checks.pcre
PFEOF
  strip_crlf /etc/postfix/main.cf

  # Create header_checks for logging
  cat > /etc/postfix/header_checks.pcre <<'HEADER'
# Log all headers for abuse control
/^(From|To|Cc|Bcc|Subject|Message-ID|Date|X-Spam-|X-Virus-|Received|Return-Path):/ WARN
HEADER
  strip_crlf /etc/postfix/header_checks.pcre

  # Create body_checks for logging
  cat > /etc/postfix/body_checks.pcre <<'BODY'
# Log suspicious patterns in body
/^(http|https):/ WARN
BODY
  strip_crlf /etc/postfix/body_checks.pcre

  # Add submission (587) and smtps (465) services to master.cf
  backup_file /etc/postfix/master.cf
  if ! grep -q "^submission" /etc/postfix/master.cf; then
    cat >> /etc/postfix/master.cf <<'MSTEOF'
submission inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_security_level=encrypt
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_reject_unlisted_recipient=no
  -o smtpd_recipient_restrictions=permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING

smtps inet  n       -       y       -       -       smtpd
  -o syslog_name=postfix/smtps
  -o smtpd_tls_wrappermode=yes
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_recipient_restrictions=permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING
MSTEOF
  fi

  # Create virtual mailbox files
  touch /etc/postfix/vdomains /etc/postfix/vmailbox /etc/postfix/virtual
  postmap /etc/postfix/vmailbox 2>>"$LOG_FILE" || true
  postmap /etc/postfix/virtual  2>>"$LOG_FILE" || true

  success "Postfix configured"
  mark_done "postfix_configured"
fi

# ==============================================================================
# 7. Dovecot
# ==============================================================================
step "Dovecot configuration"
if ! skip_if_done "dovecot_configured"; then
  backup_file /etc/dovecot/conf.d/10-auth.conf
  backup_file /etc/dovecot/conf.d/10-master.conf
  backup_file /etc/dovecot/conf.d/10-ssl.conf
  backup_file /etc/dovecot/conf.d/10-mail.conf

  CERT_DIR="/etc/letsencrypt/live/$HOSTNAME"

  cat > /etc/dovecot/conf.d/10-auth.conf <<'DCAUTH'
disable_plaintext_auth = yes
auth_mechanisms = plain login
auth_master_user_separator = *

passdb {
  driver = passwd-file
  args   = /etc/dovecot/passwd.masterusers
  master = yes
  pass   = yes
}
passdb {
  driver = passwd-file
  args   = scheme=SHA512-CRYPT username_format=%u /etc/dovecot/passwd
}
userdb {
  driver = static
  args   = uid=vmail gid=vmail home=/var/mail/vhosts/%d/%n
}
DCAUTH
  strip_crlf /etc/dovecot/conf.d/10-auth.conf

  cat > /etc/dovecot/conf.d/10-master.conf <<'DCMASTER'
service imap-login {
  inet_listener imap {
    port = 143
  }
  inet_listener imaps {
    port = 993
    ssl = yes
  }
}
service pop3-login {
  inet_listener pop3 {
    port = 110
  }
  inet_listener pop3s {
    port = 995
    ssl = yes
  }
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0666
    user = postfix
    group = postfix
  }
  unix_listener auth-userdb {
    mode = 0600
    user = vmail
  }
}
service auth-worker {
  user = vmail
}
DCMASTER
  strip_crlf /etc/dovecot/conf.d/10-master.conf

  cat > /etc/dovecot/conf.d/10-ssl.conf <<DCSSL
ssl           = required
ssl_cert      = <${CERT_DIR}/fullchain.pem
ssl_key       = <${CERT_DIR}/privkey.pem
ssl_min_protocol = TLSv1.2
ssl_cipher_list  = EECDH+AESGCM:EDH+AESGCM:AES256+EECDH:AES256+EDH
DCSSL
  strip_crlf /etc/dovecot/conf.d/10-ssl.conf

  # Enable Sieve plugin for spam filtering
  cat > /etc/dovecot/conf.d/90-sieve.conf <<SIEVE
plugin {
  sieve = /var/mail/vhosts/%d/%n/.dovecot.sieve
  sieve_dir = /var/mail/vhosts/%d/%n/sieve
  sieve_global_dir = /var/mail/vhosts/sieve
  sieve_global_path = /var/mail/vhosts/sieve/default.sieve
}
SIEVE
  strip_crlf /etc/dovecot/conf.d/90-sieve.conf

  # Create global sieve script for spam folder
  mkdir -p /var/mail/vhosts/sieve
  cat > /var/mail/vhosts/sieve/default.sieve <<'SIEVE_SCRIPT'
require ["fileinto", "imapflags"];

# Move spam to Spam folder
if header :contains "X-Spam-Flag" "YES" {
  fileinto "Spam";
  stop;
}

# Move messages with ***SPAM*** in subject
if header :contains "Subject" "***SPAM***" {
  fileinto "Spam";
  stop;
}
SIEVE_SCRIPT

  # Compile sieve script
  sievec /var/mail/vhosts/sieve/default.sieve /var/mail/vhosts/sieve/default.svbin 2>>"$LOG_FILE" || true
  chown -R vmail:vmail /var/mail/vhosts/sieve

  cat > /etc/dovecot/conf.d/10-mail.conf <<'DCMAIL'
mail_location = maildir:/var/mail/vhosts/%d/%n/Maildir
mail_privileged_group = vmail
namespace inbox {
  inbox = yes
}
DCMAIL
  strip_crlf /etc/dovecot/conf.d/10-mail.conf

  # Master user password
  if command -v doveadm &>/dev/null; then
    MASTER_HASH=$(doveadm pw -s SHA512-CRYPT -p "$MASTER_PASS" 2>>"$LOG_FILE")
    echo "$MASTER_USER:$MASTER_HASH" > /etc/dovecot/passwd.masterusers
    chmod 600 /etc/dovecot/passwd.masterusers
    chown dovecot:dovecot /etc/dovecot/passwd.masterusers
    success "Dovecot master user created"
  else
    warn "doveadm not found — create master user manually after install"
  fi

  touch /etc/dovecot/passwd
  chmod 640 /etc/dovecot/passwd
  chown root:dovecot /etc/dovecot/passwd

  success "Dovecot configured"
  mark_done "dovecot_configured"
fi

# ==============================================================================
# 8. OpenDKIM (SKIPPED - AWS SES handles DKIM for outgoing emails)
# ==============================================================================
log "Skipping OpenDKIM configuration — AWS SES handles DKIM signing for outgoing emails"
log "VPS only handles incoming mail (Postfix/Dovecot)"
mark_done "opendkim_configured"
mark_done "dkim_keys_primary"

# ==============================================================================
# 9. DKIM Key Generation (SKIPPED - AWS SES handles DKIM)
# ==============================================================================
log "Skipping DKIM key generation — AWS SES provides DKIM tokens via API"
log "Add AWS SES DKIM CNAME records to DNS for outgoing email signing"

# ==============================================================================
# 10. ClamAV — Virus Scanner
# ==============================================================================
step "ClamAV installation"
if ! skip_if_done "clamav_configured"; then
  log "Installing ClamAV for virus scanning..."
  retry apt-get install -y clamav clamav-daemon clamav-freshclam 2>>"$LOG_FILE"

  # Configure clamd to listen on local socket (faster than clamscan)
  backup_file /etc/clamav/clamd.conf
  cat > /etc/clamav/clamd.conf <<'CLAMD'
# Apex Mail Cloud - ClamAV Configuration
LogFile /var/log/clamav/clamd.log
LogTime yes
LogSyslog yes
PidFile /var/run/clamav/clamd.pid
TemporaryDirectory /var/tmp
DatabaseDirectory /var/lib/clamav
LocalSocket /var/run/clamav/clamd.sock
FixStaleSocket yes
MaxThreads 50
MaxQueue 100
MaxFileSize 100M
CLAMD
  strip_crlf /etc/clamav/clamd.conf

  # Stop freshclam before updating to avoid lock conflict
  svc_stop clamav-freshclam
  svc_stop clamav-daemon

  # Remove stale lock files
  rm -f /var/run/clamav/freshclam.pid /var/run/clamav/clamd.pid /var/lock/subsys/clamav-freshclam /var/log/clamav/freshclam.log.lock 2>/dev/null || true

  # Update virus definitions
  log "Updating ClamAV virus definitions..."
  retry freshclam 2>>"$LOG_FILE"

  # Start and enable services
  svc_start clamav-freshclam
  svc_start clamav-daemon
  svc_enable clamav-freshclam
  svc_enable clamav-daemon

  success "ClamAV installed and running"
  mark_done "clamav_configured"
fi

# ==============================================================================
# 11. Redis — for RSPAMD learning
# ==============================================================================
step "Redis installation"
if ! skip_if_done "redis_configured"; then
  log "Installing Redis for RSPAMD learning..."
  retry apt-get install -y redis-server 2>>"$LOG_FILE"

  # Configure Redis
  backup_file /etc/redis/redis.conf
  cat > /etc/redis/redis.conf <<'REDIS'
# Apex Mail Cloud - Redis Configuration
bind 127.0.0.1
port 6379
daemonize yes
pidfile /var/run/redis/redis-server.pid
logfile /var/log/redis/redis.log
databases 16
save 900 1
save 300 10
save 60 10000
maxmemory 256mb
maxmemory-policy allkeys-lru
REDIS
  strip_crlf /etc/redis/redis.conf

  svc_start redis-server
  svc_enable redis-server

  success "Redis installed and running"
  mark_done "redis_configured"
fi

# ==============================================================================
# 12. RSPAMD — Spam Filtering
# ==============================================================================
step "RSPAMD installation"
if ! skip_if_done "rspamd_configured"; then
  log "Installing RSPAMD for spam filtering..."
  retry apt-get install -y rspamd redis-tools 2>>"$LOG_FILE"

  # Configure RSPAMD
  backup_file /etc/rspamd/rspamd.conf
  cat > /etc/rspamd/rspamd.conf <<'RSPAMD'
# Apex Mail Cloud - RSPAMD Configuration
worker {
    count = 4;
    max_tasks = 1000;
}

options {
    pidfile = "/var/run/rspamd/rspamd.pid";
    grpc {
        enabled = true;
    }
    redis {
        servers = "127.0.0.1:6379";
        dbname = 0;
        timeout = 1s;
        expand_keys = true;
    }
}

logging {
    type = "syslog";
    level = "info";
    debug = false;
}

# Redis for statistics and learning
redis {
    servers = "127.0.0.1:6379";
    dbname = 0;
}

# Spam learning
classifier "bayes" {
    backend = "redis";
    servers = "127.0.0.1:6379";
    dbname = 1;
    autolearn = true;
}
RSPAMD
  strip_crlf /etc/rspamd/rspamd.conf

  # Configure actions
  backup_file /etc/rspamd/actions.conf
  cat > /etc/rspamd/actions.conf <<'ACTIONS'
# Apex Mail Cloud - RSPAMD Actions
subject = "***SPAM*** %s";
greylist = "4h:15m:30m";
spam_action = "rewrite subject";
reject_action = "reject";
rewrite_subject = true;
ACTIONS
  strip_crlf /etc/rspamd/actions.conf

  # Configure antivirus (ClamAV)
  backup_file /etc/rspamd/antivirus.conf
  cat > /etc/rspamd/antivirus.conf <<'AV'
# Apex Mail Cloud - RSPAMD Antivirus
clamav {
    symbol = "CLAM_VIRUS";
    type = "clamav";
    servers = "/var/run/clamav/clamd.sock";
    scan_mime_parts = true;
    scan_size_mimes = 0;
    scan_text_mime = false;
    scan_image = false;
}
AV
  strip_crlf /etc/rspamd/antivirus.conf

  # Add rspamd user to clamav group
  usermod -aG clamav rspamd 2>>"$LOG_FILE"

  svc_start rspamd
  svc_enable rspamd

  success "RSPAMD installed and configured"
  mark_done "rspamd_configured"
fi

# ==============================================================================
# 13. Fail2Ban — basic protection
# ==============================================================================
step "Fail2Ban"
if ! skip_if_done "fail2ban_configured"; then
  cat > /etc/fail2ban/jail.d/apex-mail.conf <<'F2B'
[sshd]
enabled  = true
maxretry = 5
bantime  = 3600

[postfix]
enabled  = true
maxretry = 5
bantime  = 3600

[dovecot]
enabled  = true
maxretry = 5
bantime  = 3600
F2B
  svc_restart fail2ban
  svc_enable fail2ban
  mark_done "fail2ban_configured"
fi

# ==============================================================================
# 11. UFW Firewall
# ==============================================================================
step "Firewall (UFW)"
if ! skip_if_done "ufw_configured"; then
  # Detect SSH port before enabling — safety first
  SSH_PORT=$(ss -tlnp | grep sshd | grep -oP ':\K[0-9]+' | head -1 || echo "22")
  log "Detected SSH port: $SSH_PORT"

  ufw --force reset 2>>"$LOG_FILE"
  ufw default deny incoming  2>>"$LOG_FILE"
  ufw default allow outgoing 2>>"$LOG_FILE"

  # SSH (detected port + standard 22 as fallback safety)
  ufw allow "$SSH_PORT/tcp"  comment 'SSH'
  [[ "$SSH_PORT" != "22" ]] && ufw allow 22/tcp comment 'SSH fallback'

  # Mail ports
  ufw allow 25/tcp   comment 'SMTP'
  ufw allow 465/tcp  comment 'SMTPS'
  ufw allow 587/tcp  comment 'Submission'
  ufw allow 110/tcp  comment 'POP3'
  ufw allow 143/tcp  comment 'IMAP'
  ufw allow 993/tcp  comment 'IMAPS'
  ufw allow 995/tcp  comment 'POP3S'

  # HTTP/S for certbot
  ufw allow 80/tcp   comment 'HTTP/Certbot'
  ufw allow 443/tcp  comment 'HTTPS'

  # VPS Agent API (localhost only — not exposed to internet)
  # Agents port is internal; don't open it publicly

  echo "y" | ufw enable 2>>"$LOG_FILE" || warn "UFW enable failed — check manually"
  ufw status verbose 2>>"$LOG_FILE" | tee -a "$LOG_FILE"
  success "UFW configured and enabled"
  mark_done "ufw_configured"
fi

# ==============================================================================
# 12. Nginx — virus-scanner.apexcloudconsole.com
# ==============================================================================
step "Nginx configuration"
if ! skip_if_done "nginx_configured"; then
  # Install Nginx
  retry apt-get install -y nginx 2>>"$LOG_FILE"

  # Get SSL certificate for virus-scanner subdomain
  VIRUS_HOST="virus-scanner.apexcloudconsole.com"
  CERT_DIR="/etc/letsencrypt/live/$VIRUS_HOST"

  if [ ! -d "$CERT_DIR" ]; then
    log "Requesting Let's Encrypt certificate for $VIRUS_HOST…"
    certbot certonly --standalone -d "$VIRUS_HOST" --email "$CERT_EMAIL" --agree-tos --non-interactive 2>>"$LOG_FILE"
    success "Let's Encrypt certificate obtained for $VIRUS_HOST"
  else
    success "SSL certificate already exists for $VIRUS_HOST"
  fi

  # Configure Nginx for virus scanner API
  cat > /etc/nginx/sites-available/virus-scanner <<'NGINX'
# Apex Mail Cloud - Virus Scanner API
server {
    listen 80;
    server_name virus-scanner.apexcloudconsole.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name virus-scanner.apexcloudconsole.com;

    ssl_certificate /etc/letsencrypt/live/virus-scanner.apexcloudconsole.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/virus-scanner.apexcloudconsole.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Proxy to vps-agent API
    location / {
        proxy_pass http://127.0.0.1:3001/api/scan;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Increase timeouts for large file scans
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://127.0.0.1:3001/api/scan/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
NGINX
  strip_crlf /etc/nginx/sites-available/virus-scanner

  # Enable site
  ln -sf /etc/nginx/sites-available/virus-scanner /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default

  # Test and reload Nginx
  nginx -t 2>>"$LOG_FILE"
  systemctl reload nginx 2>>"$LOG_FILE"
  systemctl enable nginx 2>>"$LOG_FILE"

  success "Nginx configured for virus-scanner.apexcloudconsole.com"
  mark_done "nginx_configured"
fi

# ==============================================================================
# 13. Node.js
# ==============================================================================
step "Node.js ${NODE_MAJOR}"
if ! skip_if_done "nodejs_installed"; then
  INSTALLED_NODE=""
  command -v node &>/dev/null && INSTALLED_NODE=$(node -e 'console.log(parseInt(process.version.slice(1)))' 2>/dev/null || echo "0")

  if [[ "${INSTALLED_NODE:-0}" -ge "$NODE_MAJOR" ]]; then
    success "Node.js $(node -v) already installed"
  else
    log "Installing Node.js ${NODE_MAJOR}…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - 2>>"$LOG_FILE"
    retry apt-get install -y nodejs 2>>"$LOG_FILE"
    success "Node.js $(node -v) installed"
  fi
  mark_done "nodejs_installed"
fi

# ==============================================================================
# 13. PM2
# ==============================================================================
step "PM2"
if ! skip_if_done "pm2_installed"; then
  if ! command -v pm2 &>/dev/null; then
    retry npm install -g pm2 2>>"$LOG_FILE"
    success "PM2 $(pm2 -v) installed"
  else
    success "PM2 $(pm2 -v) already installed"
  fi
  mark_done "pm2_installed"
fi

# ==============================================================================
# 14. VPS Agent — install + build
# ==============================================================================
step "VPS Agent npm install + build"
if ! skip_if_done "agent_built"; then
  log "Agent dir: $AGENT_DIR"
  cd "$AGENT_DIR"

  log "Installing all npm dependencies (including devDeps for TypeScript build)…"
  retry npm ci 2>>"$LOG_FILE"

  log "Building TypeScript…"
  npm run build 2>&1 | tee -a "$LOG_FILE"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && die "TypeScript build failed — check $LOG_FILE"

  log "Pruning devDependencies from production install…"
  npm prune --omit=dev 2>>"$LOG_FILE"

  success "Agent built: $AGENT_DIR/dist/index.js"
  mark_done "agent_built"
fi

# ==============================================================================
# 15. .env file
# ==============================================================================
step "Writing .env"
if ! skip_if_done "env_written"; then
  ENV_FILE="$AGENT_DIR/.env"
  # Don't overwrite if exists unless fresh install
  if [[ -f "$ENV_FILE" ]]; then
    backup_file "$ENV_FILE"
    warn "Existing .env backed up to $BACKUP_DIR — overwriting"
  fi

  cat > "$ENV_FILE" <<ENVEOF
# ── Apex Mail Cloud VPS Agent — Generated $(date) ─────────────────────────────

# ── Supabase ──────────────────────────────────────────────────────────────────
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}

# ── Agent HTTP API ────────────────────────────────────────────────────────────
API_PORT=${API_PORT}
API_BEARER_TOKEN=${API_BEARER_TOKEN}
NODE_ENV=production
LOG_LEVEL=info

# ── Mail server paths ─────────────────────────────────────────────────────────
POSTFIX_VMAILBOX=/etc/postfix/vmailbox
POSTFIX_VDOMAINS=/etc/postfix/vdomains
POSTFIX_VMAPS=/etc/postfix/virtual
DOVECOT_PASSWD=/etc/dovecot/passwd
OPENDKIM_KEYS_DIR=/etc/opendkim/keys
OPENDKIM_KEYTABLE=/etc/opendkim/KeyTable
OPENDKIM_SIGNTABLE=/etc/opendkim/SigningTable
OPENDKIM_TRUSTED=/etc/opendkim/TrustedHosts
DKIM_SELECTOR=${DKIM_SELECTOR}

# ── Behaviour ─────────────────────────────────────────────────────────────────
FULL_SYNC_INTERVAL_MS=300000
MAILBOX_WORKER_CONCURRENCY=10
DOMAIN_WORKER_CONCURRENCY=5
DKIM_WORKER_CONCURRENCY=3
MAX_JOB_RETRIES=5
INITIAL_RETRY_DELAY_MS=1000
ENVEOF

  chmod 600 "$ENV_FILE"
  success ".env written to $ENV_FILE"
  mark_done "env_written"
fi

# ==============================================================================
# 16. Start / restart all services
# ==============================================================================
step "Starting services"
if ! skip_if_done "services_started"; then
  svc_enable postfix
  svc_enable dovecot
  svc_enable opendkim

  svc_restart opendkim
  svc_restart postfix
  svc_restart dovecot

  mark_done "services_started"
fi

# ==============================================================================
# 17. VPS Agent via PM2
# ==============================================================================
step "VPS Agent (PM2)"
if ! skip_if_done "agent_started"; then
  cd "$AGENT_DIR"

  # Stop existing instance if running
  pm2 delete apex-vps-agent 2>/dev/null || true

  log "Starting vps-agent with PM2…"
  pm2 start ecosystem.config.cjs --env production 2>>"$LOG_FILE"
  pm2 save 2>>"$LOG_FILE"

  # Register PM2 startup (survives reboots)
  PM2_STARTUP=$(pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 || true)
  if [[ "$PM2_STARTUP" == sudo* || "$PM2_STARTUP" == env* ]]; then
    eval "$PM2_STARTUP" 2>>"$LOG_FILE" || true
  fi

  success "vps-agent started via PM2"
  mark_done "agent_started"
fi

# ==============================================================================
# 18. Verification
# ==============================================================================
step "Verification"

ALL_OK=true
ISSUES=()

check_service() {
  local svc="$1"
  if systemctl is-active --quiet "$svc"; then
    success "Service $svc — running"
  else
    warn "Service $svc — NOT running"
    ISSUES+=("$svc not running")
    ALL_OK=false
  fi
}

check_port() {
  local port="$1" label="$2"
  sleep 1
  if port_listening "$port"; then
    success "Port $port ($label) — listening"
  else
    warn "Port $port ($label) — NOT listening"
    ISSUES+=("Port $port ($label) not listening")
    ALL_OK=false
  fi
}

check_service postfix
check_service dovecot
check_service opendkim
check_service fail2ban
check_service ufw

check_port 25  "SMTP"
check_port 143 "IMAP"
check_port 993 "IMAPS"
check_port 587 "Submission"

# Agent health check — wait up to 20s for it to start
log "Waiting for agent API on port $API_PORT…"
AGENT_UP=false
for i in $(seq 1 10); do
  if curl -fsS "http://localhost:${API_PORT}/health/live" >/dev/null 2>&1; then
    AGENT_UP=true
    break
  fi
  sleep 2
done

if [[ "$AGENT_UP" == true ]]; then
  success "VPS Agent API — healthy (http://localhost:$API_PORT/health/live)"
else
  warn "VPS Agent API not responding on port $API_PORT"
  ISSUES+=("vps-agent not responding — check: pm2 logs apex-vps-agent")
  ALL_OK=false
fi

# ==============================================================================
# 19. Final Report
# ==============================================================================
echo ""
echo -e "${BLD}${CYN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLD}${CYN}║              Apex Mail Cloud — Install Complete              ║${NC}"
echo -e "${BLD}${CYN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLD}Server Details:${NC}"
echo "  Hostname:        $HOSTNAME"
echo "  Domain:          $DOMAIN"
echo "  Master user:     $MASTER_USER"
echo "  Agent API:       http://localhost:$API_PORT"
echo "  Agent token:     $API_BEARER_TOKEN"
echo "  Install log:     $LOG_FILE"
echo "  Backups:         $BACKUP_DIR"
echo ""

if [[ "${#ISSUES[@]}" -gt 0 ]]; then
  echo -e "${YLW}${BLD}⚠  Issues to resolve:${NC}"
  for issue in "${ISSUES[@]}"; do
    echo -e "  ${YLW}•${NC} $issue"
  done
  echo ""
fi

DKIM_TXT_FILE="/etc/opendkim/keys/$DOMAIN/$DKIM_SELECTOR.txt"
if [[ -f "$DKIM_TXT_FILE" ]]; then
  echo -e "${BLD}DNS Records to add for $DOMAIN:${NC}"
  echo ""
  echo -e "  ${BLD}MX${NC}   @        → $HOSTNAME  (priority 10)"
  echo -e "  ${BLD}TXT${NC}  @        → \"v=spf1 ip4:$(curl -4s ifconfig.me 2>/dev/null || echo YOUR_IP) a mx ~all\""
  echo -e "  ${BLD}TXT${NC}  _dmarc   → \"v=DMARC1; p=quarantine; rua=mailto:dmarc@$DOMAIN\""
  echo ""
  echo -e "  ${BLD}DKIM TXT record:${NC}"
  cat "$DKIM_TXT_FILE"
  echo ""
fi

echo -e "${BLD}Useful Commands:${NC}"
echo "  pm2 status                        — agent status"
echo "  pm2 logs apex-vps-agent           — agent logs"
echo "  pm2 restart apex-vps-agent        — restart agent"
echo "  curl http://localhost:$API_PORT/health/ready — health check"
echo "  journalctl -u postfix -f          — postfix logs"
echo "  journalctl -u dovecot -f          — dovecot logs"
echo ""

if [[ "$ALL_OK" == true ]]; then
  echo -e "${GRN}${BLD}✓ All systems operational.${NC}"
else
  echo -e "${YLW}${BLD}⚠  Installation complete with warnings. Review issues above.${NC}"
fi

# Clean up saved vars (contain credentials)
rm -f /var/lib/apex-install-vars
echo ""