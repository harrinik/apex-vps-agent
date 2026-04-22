# Apex Mail Cloud — VPS Agent v2

Production-ready autonomous daemon that bridges **Supabase** with **Postfix / Dovecot / OpenDKIM** on your VPS.

## Architecture

```
Supabase Realtime (WebSocket)
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│                      Agent (Orchestrator)               │
│                                                         │
│  ┌─────────────┐   ┌───────────────┐  ┌─────────────┐  │
│  │  Priority   │   │   Scheduler   │  │  Supabase   │  │
│  │  Job Queue  │   │  (Full sync   │  │  Realtime   │  │
│  │ (idempotent │   │   every 5min) │  │  listener   │  │
│  │  + retries) │   └───────────────┘  └─────────────┘  │
│  └──────┬──────┘                                        │
└─────────┼───────────────────────────────────────────────┘
          │
    ┌─────┴──────────────────────────────┐
    │           Workers                  │
    │  MailboxWorker  DomainWorker  DKIM  │
    └─────┬──────────────────────────────┘
          │
    ┌─────┴────────────────────────────────┐
    │           VPS Mail Stack             │
    │  Postfix  │  Dovecot  │  OpenDKIM    │
    └──────────────────────────────────────┘
```

## Key Design Decisions

| Feature | Implementation |
|---|---|
| **Realtime vs polling** | Supabase Realtime WebSocket (zero DB load at rest) |
| **Idempotency** | Every job has a unique key — duplicates silently dropped |
| **Retry strategy** | Exponential backoff + full jitter (avoids thundering herd) |
| **Atomic writes** | All config files written via tmp→rename (no partial reads) |
| **Batch Postfix reloads** | 2s debounce — N domain changes = 1 reload |
| **Graceful shutdown** | SIGTERM drains queue, completes in-flight jobs, then exits |
| **Observability** | Prometheus metrics at `/health/metrics`, JSON structured logs |
| **Circuit safety** | Unopened health endpoints return `degraded` not 500 |

## Quick Start (Production VPS)

```bash
# 1. Upload to VPS
scp -r ./vps-agent root@your-vps:/opt/apex-vps-agent

# 2. Run setup (installs Node.js, PM2, creates dirs)
cd /opt/apex-vps-agent
chmod +x scripts/setup.sh
./scripts/setup.sh

# 3. Configure credentials
cp .env.example .env
nano .env   # Set SUPABASE_URL, SUPABASE_SERVICE_KEY, API_BEARER_TOKEN

# 4. Start
pm2 restart apex-vps-agent

# 5. Verify
curl http://localhost:3001/health/ready
```

## API Endpoints

All write endpoints require `Authorization: Bearer <API_BEARER_TOKEN>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health/live` | Liveness probe (always 200 if process is alive) |
| `GET` | `/health/ready` | Readiness probe (checks Postfix, Dovecot, Supabase, disk) |
| `GET` | `/health/metrics` | Prometheus metrics |
| `GET` | `/api/mailboxes` | List all VPS mailboxes |
| `POST` | `/api/mailboxes` | Create a mailbox `{ email, passwordHash? }` |
| `DELETE` | `/api/mailboxes` | Delete a mailbox `{ email }` |
| `GET` | `/api/domains` | List all virtual domains |
| `POST` | `/api/domains` | Add a domain `{ domain }` |
| `DELETE` | `/api/domains/:domain` | Remove a domain |
| `POST` | `/api/domains/:domain/dkim` | Regenerate DKIM keys |
| `POST` | `/api/domains/sync` | Trigger immediate full sync |

## Environment Variables

See `.env.example` for full reference. Minimum required:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
API_BEARER_TOKEN=long-random-secret-min-16-chars
```

## PM2 Commands

```bash
pm2 status                        # Check running status
pm2 logs apex-vps-agent           # Tail logs
pm2 restart apex-vps-agent        # Restart after .env changes
pm2 reload apex-vps-agent         # Zero-downtime reload
```

## Docker

```bash
# Build
docker build -t apex-vps-agent .

# Run (requires host networking to access Postfix/Dovecot)
docker-compose up -d
```