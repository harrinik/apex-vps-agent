import { JobQueue } from './Queue';
import { Scheduler } from './Scheduler';
import { SupabaseService, EmailAccountRow, DomainRow } from '../services/SupabaseService';
import { MailboxService } from '../services/MailboxService';
import { DomainService } from '../services/DomainService';
import { DkimService } from '../services/DkimService';
import { handleMailboxCreate, handleMailboxDelete, handleMailboxUpdatePassword } from '../workers/MailboxWorker';
import { handleDomainAdd, handleDomainRemove } from '../workers/DomainWorker';
import { handleDkimGenerate, handleDkimRotate } from '../workers/DkimWorker';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Agent — the top-level orchestrator.
 *
 * Responsibilities:
 *   1. Wire job handlers onto the queue.
 *   2. Subscribe to Supabase Realtime for instant change processing.
 *   3. Schedule periodic full-sync to catch any missed Realtime events.
 *   4. Expose start() / stop() for graceful lifecycle management.
 */
export class Agent {
  private readonly queue     = new JobQueue(config.MAILBOX_WORKER_CONCURRENCY);
  private readonly scheduler = new Scheduler();
  readonly supabase          = new SupabaseService();

  // These are also used by the API routes
  readonly mailboxService = new MailboxService();
  readonly domainService  = new DomainService();
  readonly dkimService    = new DkimService();

  async start(): Promise<void> {
    logger.info('[Agent] starting…');

    this.registerHandlers();
    this.subscribeRealtime();
    this.schedulePeriodicSync();

    this.scheduler.start();
    logger.info('[Agent] running — waiting for events');
  }

  async stop(): Promise<void> {
    logger.info('[Agent] stopping…');
    this.scheduler.stop();
    await this.queue.drain();
    await this.supabase.disconnect();
    logger.info('[Agent] stopped cleanly');
  }

  // ── Job handler registration ─────────────────────────────────────────────

  private registerHandlers(): void {
    this.queue.handle('mailbox:create',          handleMailboxCreate);
    this.queue.handle('mailbox:delete',          handleMailboxDelete);
    this.queue.handle('mailbox:update_password', handleMailboxUpdatePassword);
    this.queue.handle('domain:add',              handleDomainAdd);
    this.queue.handle('domain:remove',           handleDomainRemove);
    this.queue.handle('dkim:generate',           handleDkimGenerate);
    this.queue.handle('dkim:rotate',             handleDkimRotate);
    this.queue.handle('postfix:reload',          async () => {
      const { exec } = await import('../utils/exec');
      await exec('postfix reload').catch(() => {});
    });
    this.queue.handle('full:sync', async () => {
      await this.fullSync();
    });

    this.queue.on('job:failed', (job, err) => {
      logger.error('[Agent] job permanently failed', {
        type:    job.type,
        id:      job.id,
        error:   err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ── Supabase Realtime subscriptions ─────────────────────────────────────

  private subscribeRealtime(): void {
    this.supabase.subscribeEmailAccounts((event, row, oldRow) => {
      this.handleAccountChange(event, row, oldRow);
    });

    this.supabase.subscribeDomains((event, row) => {
      this.handleDomainChange(event, row);
    });

    logger.info('[Agent] Realtime subscriptions active');
  }

  private handleAccountChange(
    event: 'INSERT' | 'UPDATE' | 'DELETE',
    row: EmailAccountRow,
    oldRow?: Partial<EmailAccountRow>,
  ): void {
    const email = row.email_address ?? oldRow?.email_address;
    if (!email) return;

    switch (event) {
      case 'INSERT':
        this.queue.enqueue('mailbox:create', {
          email,
          passwordHash: row.password_hash ?? undefined,
        }, { priority: 'high', idempotencyKey: `mailbox:create:${email}` });
        break;

      case 'UPDATE':
        if (row.is_active === false) {
          this.queue.enqueue('mailbox:delete', { email }, {
            priority: 'normal',
            idempotencyKey: `mailbox:delete:${email}`,
          });
        } else if (row.password_hash && row.password_hash !== oldRow?.password_hash) {
          this.queue.enqueue('mailbox:update_password', {
            email,
            passwordHash: row.password_hash,
          }, { priority: 'high', idempotencyKey: `mailbox:pwupdate:${email}:${Date.now()}` });
        }
        break;

      case 'DELETE':
        this.queue.enqueue('mailbox:delete', { email }, {
          priority: 'high',
          idempotencyKey: `mailbox:delete:${email}`,
        });
        break;
    }
  }

  private handleDomainChange(event: 'INSERT' | 'UPDATE' | 'DELETE', row: DomainRow): void {
    const domain = row.domain_name;

    switch (event) {
      case 'INSERT':
        if (row.is_verified) {
          this.queue.enqueue('domain:add', { domain }, { priority: 'high', idempotencyKey: `domain:add:${domain}` });
          this.queue.enqueue('dkim:generate', { domainId: row.id, domain }, { priority: 'normal', idempotencyKey: `dkim:gen:${domain}` });
        }
        break;

      case 'UPDATE':
        if (row.is_verified) {
          this.queue.enqueue('domain:add', { domain }, { priority: 'high', idempotencyKey: `domain:add:${domain}` });
          if (!row.dkim_public_key) {
            this.queue.enqueue('dkim:generate', { domainId: row.id, domain }, { priority: 'normal', idempotencyKey: `dkim:gen:${domain}` });
          }
        }
        break;

      case 'DELETE':
        this.queue.enqueue('domain:remove', { domain }, { priority: 'normal', idempotencyKey: `domain:rm:${domain}` });
        break;
    }
  }

  // ── Periodic full sync ───────────────────────────────────────────────────

  private schedulePeriodicSync(): void {
    this.scheduler.register('full-sync', config.FULL_SYNC_INTERVAL_MS, () => {
      this.queue.enqueue('full:sync', {}, {
        priority: 'low',
        idempotencyKey: `full:sync:${Math.floor(Date.now() / config.FULL_SYNC_INTERVAL_MS)}`,
      });
    });
  }

  /**
   * Full sync — reconcile Supabase state with VPS state.
   * Handles any events missed during downtime or Realtime disconnects.
   */
  async fullSync(): Promise<void> {
    logger.info('[Agent] full sync started');
    const [accounts, domains, vpsMailboxes, vpsDomains] = await Promise.all([
      this.supabase.fetchAllAccounts(),
      this.supabase.fetchAllDomains(),
      this.mailboxService.listMailboxes(),
      this.domainService.listDomains(),
    ]);

    const supabaseEmails   = new Set(accounts.map(a => a.email_address));
    const vpsMailboxSet    = new Set(vpsMailboxes);
    const vpsDomainSet     = new Set(vpsDomains);

    // Create missing mailboxes
    for (const account of accounts) {
      if (!vpsMailboxSet.has(account.email_address)) {
        logger.info('[Agent] sync: missing mailbox, scheduling create', { email: account.email_address });
        this.queue.enqueue('mailbox:create', {
          email: account.email_address,
          passwordHash: account.password_hash ?? undefined,
        }, { priority: 'normal', idempotencyKey: `sync:mailbox:create:${account.email_address}` });
      }
    }

    // Remove stale mailboxes (deleted from Supabase)
    for (const email of vpsMailboxSet) {
      if (!supabaseEmails.has(email)) {
        logger.info('[Agent] sync: stale mailbox, scheduling delete', { email });
        this.queue.enqueue('mailbox:delete', { email }, {
          priority: 'low',
          idempotencyKey: `sync:mailbox:delete:${email}`,
        });
      }
    }

    // Add missing domains
    for (const domain of domains) {
      if (!vpsDomainSet.has(domain.domain_name)) {
        this.queue.enqueue('domain:add', { domain: domain.domain_name }, {
          priority: 'normal',
          idempotencyKey: `sync:domain:add:${domain.domain_name}`,
        });
      }
      // Generate DKIM if missing
      if (!domain.dkim_public_key) {
        this.queue.enqueue('dkim:generate', { domainId: domain.id, domain: domain.domain_name }, {
          priority: 'low',
          idempotencyKey: `sync:dkim:gen:${domain.domain_name}`,
        });
      }
    }

    logger.info('[Agent] full sync enqueued', {
      accounts: accounts.length,
      domains:  domains.length,
      vpsMailboxes: vpsMailboxes.length,
      vpsDomains:   vpsDomains.length,
    });
  }

  get queueStats() {
    return { pending: this.queue.pending };
  }
}