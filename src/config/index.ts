import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const schema = z.object({
  // Supabase
  SUPABASE_URL:          z.string().url(),
  SUPABASE_SERVICE_KEY:  z.string().min(20),

  // Agent API
  API_PORT:              z.coerce.number().default(3001),
  API_BEARER_TOKEN:      z.string().min(16),

  // Mail server paths
  POSTFIX_VMAILBOX:      z.string().default('/etc/postfix/vmailbox'),
  POSTFIX_VDOMAINS:      z.string().default('/etc/postfix/vdomains'),
  POSTFIX_VMAPS:         z.string().default('/etc/postfix/virtual'),
  DOVECOT_PASSWD:        z.string().default('/etc/dovecot/passwd'),
  OPENDKIM_KEYS_DIR:     z.string().default('/etc/opendkim/keys'),
  OPENDKIM_KEYTABLE:     z.string().default('/etc/opendkim/KeyTable'),
  OPENDKIM_SIGNTABLE:    z.string().default('/etc/opendkim/SigningTable'),
  OPENDKIM_TRUSTED:      z.string().default('/etc/opendkim/TrustedHosts'),
  DKIM_SELECTOR:         z.string().default('apexmail'),

  // Behaviour
  FULL_SYNC_INTERVAL_MS:        z.coerce.number().default(300_000),
  MAILBOX_WORKER_CONCURRENCY:   z.coerce.number().default(10),
  DOMAIN_WORKER_CONCURRENCY:    z.coerce.number().default(5),
  DKIM_WORKER_CONCURRENCY:      z.coerce.number().default(3),
  MAX_JOB_RETRIES:              z.coerce.number().default(5),
  INITIAL_RETRY_DELAY_MS:       z.coerce.number().default(1_000),

  // Observability
  LOG_LEVEL:  z.enum(['error','warn','info','debug']).default('info'),
  NODE_ENV:   z.string().default('production'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[Config] Invalid environment variables:\n', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;