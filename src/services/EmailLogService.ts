import { SupabaseService } from './SupabaseService';
import { logger } from '../utils/logger';

export interface EmailLogEntry {
  direction: 'incoming' | 'outgoing';
  message_id?: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses?: string[];
  bcc_addresses?: string[];
  subject: string;
  size_bytes?: number;
  client_ip?: string;
  helo?: string;
  sender_domain?: string;
  recipient_domain?: string;
  spam_score?: number;
  spam_flag?: boolean;
  virus_detected?: boolean;
  threat_name?: string;
  headers?: Record<string, string>;
  timestamp: string;
  email_account_id?: string;
  domain_id?: string;
  user_id?: string;
  postqueue_id?: string;
  delivery_status?: 'sent' | 'deferred' | 'bounced' | 'rejected';
  bounce_reason?: string;
  tls_used?: boolean;
  tls_version?: string;
  tls_cipher?: string;
}

/**
 * Email Logging Service for Abuse Control
 * Logs all incoming/outgoing emails with detailed metadata
 * Stores in Supabase for audit trail and abuse investigation
 */
export class EmailLogService {
  private supabaseService: SupabaseService;
  private batchSize = 100;
  private logQueue: EmailLogEntry[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(supabaseService: SupabaseService) {
    this.supabaseService = supabaseService;
    this.startBatchFlush();
  }

  /**
   * Log incoming email
   */
  async logIncoming(entry: Omit<EmailLogEntry, 'direction' | 'timestamp'>): Promise<void> {
    const logEntry: EmailLogEntry = {
      ...entry,
      direction: 'incoming',
      timestamp: new Date().toISOString(),
    };

    this.logQueue.push(logEntry);
    logger.info('[EmailLog] Incoming email logged', { 
      from: entry.from_address, 
      to: entry.to_addresses[0],
      ip: entry.client_ip 
    });

    if (this.logQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Log outgoing email
   */
  async logOutgoing(entry: Omit<EmailLogEntry, 'direction' | 'timestamp'>): Promise<void> {
    const logEntry: EmailLogEntry = {
      ...entry,
      direction: 'outgoing',
      timestamp: new Date().toISOString(),
    };

    this.logQueue.push(logEntry);
    logger.info('[EmailLog] Outgoing email logged', { 
      from: entry.from_address, 
      to: entry.to_addresses[0] 
    });

    if (this.logQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Log email delivery status change
   */
  async logDeliveryStatus(
    messageId: string,
    status: EmailLogEntry['delivery_status'],
    reason?: string
  ): Promise<void> {
    logger.info('[EmailLog] Delivery status updated', { messageId, status, reason });
    
    // In production, this would update the existing log entry
    // For now, we log it to stdout/syslog
  }

  /**
   * Log spam detection
   */
  async logSpam(entry: Omit<EmailLogEntry, 'spam_flag' | 'timestamp'>, spamScore: number): Promise<void> {
    const logEntry: EmailLogEntry = {
      ...entry,
      spam_flag: true,
      spam_score: spamScore,
      timestamp: new Date().toISOString(),
    };

    this.logQueue.push(logEntry);
    logger.warn('[EmailLog] Spam detected', { 
      from: entry.from_address,
      score: spamScore,
      ip: entry.client_ip 
    });

    if (this.logQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Log virus detection
   */
  async logVirus(entry: Omit<EmailLogEntry, 'virus_detected' | 'timestamp'>, threatName: string): Promise<void> {
    const logEntry: EmailLogEntry = {
      ...entry,
      virus_detected: true,
      threat_name: threatName,
      timestamp: new Date().toISOString(),
    };

    this.logQueue.push(logEntry);
    logger.error('[EmailLog] Virus detected', { 
      from: entry.from_address,
      threat: threatName 
    });

    // Flush immediately for security events
    await this.flush();
  }

  /**
   * Log bounce/rejection
   */
  async logBounce(entry: Omit<EmailLogEntry, 'delivery_status' | 'timestamp'>, reason: string): Promise<void> {
    const logEntry: EmailLogEntry = {
      ...entry,
      delivery_status: 'bounced',
      bounce_reason: reason,
      timestamp: new Date().toISOString(),
    };

    this.logQueue.push(logEntry);
    logger.warn('[EmailLog] Email bounced', { 
      from: entry.from_address,
      to: entry.to_addresses[0],
      reason 
    });

    await this.flush();
  }

  /**
   * Flush log queue to Supabase
   */
  async flush(): Promise<void> {
    if (this.logQueue.length === 0) return;

    const batch = this.logQueue.splice(0, this.batchSize);
    
    try {
      await this.supabaseService.client
        .from('email_logs')
        .insert(batch);
      
      logger.debug('[EmailLog] Flushed batch', { count: batch.length });
    } catch (error) {
      logger.error('[EmailLog] Failed to flush logs', { 
        error: (error as Error).message,
        count: batch.length 
      });
      
      // Re-add failed entries to queue for retry
      this.logQueue.unshift(...batch);
    }
  }

  /**
   * Start periodic batch flush (every 5 seconds)
   */
  private startBatchFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flush().catch(err => {
        logger.error('[EmailLog] Periodic flush failed', { error: (err as Error).message });
      });
    }, 5000);
  }

  /**
   * Stop periodic flush and flush remaining logs
   */
  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
    logger.info('[EmailLog] Service shutdown complete');
  }
}
