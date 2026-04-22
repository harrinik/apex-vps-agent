import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface EmailAccountRow {
  id: string;
  user_id: string;
  email_address: string;
  display_name: string | null;
  password_hash: string | null;
  is_active: boolean;
  created_at: string;
}

export interface DomainRow {
  id: string;
  domain_name: string;
  user_id: string;
  is_verified: boolean;
  dkim_public_key: string | null;
  dkim_private_key: string | null;
  dkim_selector: string;
  created_at: string;
}

type ChangeHandler<T> = (event: 'INSERT' | 'UPDATE' | 'DELETE', row: T, oldRow?: Partial<T>) => void;

/**
 * Supabase service — provides a service-role client and manages
 * Realtime channel subscriptions for email_accounts and domains.
 *
 * Uses automatic reconnect with exponential backoff built into @supabase/supabase-js v2.
 */
export class SupabaseService {
  readonly client: SupabaseClient;
  private channels: RealtimeChannel[] = [];

  constructor() {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      realtime: {
        params: { eventsPerSecond: 100 },
      },
    });
  }

  /** Subscribe to email_accounts table changes */
  subscribeEmailAccounts(handler: ChangeHandler<EmailAccountRow>): void {
    const channel = this.client
      .channel('vps-agent:email_accounts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'email_accounts' },
        (payload) => {
          const event = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
          const row = (payload.new ?? payload.old) as EmailAccountRow;
          const oldRow = payload.old as Partial<EmailAccountRow> | undefined;
          logger.debug('[Supabase] email_accounts change', { event, id: row?.id });
          handler(event, row, oldRow);
        },
      )
      .subscribe((status) => {
        logger.info('[Supabase] email_accounts channel', { status });
      });

    this.channels.push(channel);
  }

  /** Subscribe to domains table changes */
  subscribeDomains(handler: ChangeHandler<DomainRow>): void {
    const channel = this.client
      .channel('vps-agent:domains')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'domains' },
        (payload) => {
          const event = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
          const row = (payload.new ?? payload.old) as DomainRow;
          const oldRow = payload.old as Partial<DomainRow> | undefined;
          logger.debug('[Supabase] domains change', { event, id: row?.id });
          handler(event, row, oldRow);
        },
      )
      .subscribe((status) => {
        logger.info('[Supabase] domains channel', { status });
      });

    this.channels.push(channel);
  }

  /** Fetch all active email accounts */
  async fetchAllAccounts(): Promise<EmailAccountRow[]> {
    const { data, error } = await this.client
      .from('email_accounts')
      .select('*')
      .eq('is_active', true);
    if (error) throw new Error(`fetchAllAccounts: ${error.message}`);
    return (data ?? []) as EmailAccountRow[];
  }

  /** Fetch all verified domains */
  async fetchAllDomains(): Promise<DomainRow[]> {
    const { data, error } = await this.client
      .from('domains')
      .select('*')
      .eq('is_verified', true);
    if (error) throw new Error(`fetchAllDomains: ${error.message}`);
    return (data ?? []) as DomainRow[];
  }

  /** Persist DKIM public key back to Supabase */
  async saveDkimPublicKey(domainId: string, publicKey: string): Promise<void> {
    const { error } = await this.client
      .from('domains')
      .update({ dkim_public_key: publicKey })
      .eq('id', domainId);
    if (error) throw new Error(`saveDkimPublicKey: ${error.message}`);
  }

  /** Unsubscribe all channels */
  async disconnect(): Promise<void> {
    for (const ch of this.channels) {
      await this.client.removeChannel(ch);
    }
    this.channels = [];
    logger.info('[Supabase] disconnected');
  }
}