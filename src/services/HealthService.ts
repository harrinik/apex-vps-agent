import { exec, commandExists } from '../utils/exec';
import { config } from '../config';
import { createClient } from '@supabase/supabase-js';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  checks: Record<string, CheckResult>;
  timestamp: string;
}

interface CheckResult {
  ok: boolean;
  message?: string;
  durationMs?: number;
}

export class HealthService {
  private readonly startTime = Date.now();

  async check(): Promise<HealthStatus> {
    const [postfix, dovecot, opendkim, supabase, disk] = await Promise.allSettled([
      this.checkPostfix(),
      this.checkDovecot(),
      this.checkOpendkim(),
      this.checkSupabaseConnectivity(),
      this.checkDiskSpace(),
    ]);

    const checks: Record<string, CheckResult> = {
      postfix:   this.settle(postfix),
      dovecot:   this.settle(dovecot),
      opendkim:  this.settle(opendkim),
      supabase:  this.settle(supabase),
      disk:      this.settle(disk),
    };

    const allOk      = Object.values(checks).every(c => c.ok);
    const anyFailed  = Object.values(checks).filter(c => !c.ok).length;

    return {
      status:    allOk ? 'healthy' : anyFailed >= 2 ? 'unhealthy' : 'degraded',
      uptime:    Date.now() - this.startTime,
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  private settle(result: PromiseSettledResult<CheckResult>): CheckResult {
    if (result.status === 'fulfilled') return result.value;
    return { ok: false, message: result.reason?.message ?? 'unknown error' };
  }

  private async checkPostfix(): Promise<CheckResult> {
    const t = Date.now();
    try {
      if (!await commandExists('postfix')) return { ok: true, message: 'postfix not installed (dev mode)' };
      await exec('postfix status');
      return { ok: true, durationMs: Date.now() - t };
    } catch (err) {
      return { ok: false, message: (err as Error).message, durationMs: Date.now() - t };
    }
  }

  private async checkDovecot(): Promise<CheckResult> {
    const t = Date.now();
    try {
      if (!await commandExists('doveadm')) return { ok: true, message: 'dovecot not installed (dev mode)' };
      await exec('doveadm log find');
      return { ok: true, durationMs: Date.now() - t };
    } catch (err) {
      return { ok: false, message: (err as Error).message, durationMs: Date.now() - t };
    }
  }

  private async checkOpendkim(): Promise<CheckResult> {
    const t = Date.now();
    try {
      if (!await commandExists('opendkim')) return { ok: true, message: 'opendkim not installed (dev mode)' };
      const result = await exec('systemctl is-active opendkim');
      return { ok: result.stdout === 'active', message: result.stdout, durationMs: Date.now() - t };
    } catch (err) {
      return { ok: false, message: (err as Error).message, durationMs: Date.now() - t };
    }
  }

  private async checkSupabaseConnectivity(): Promise<CheckResult> {
    const t = Date.now();
    try {
      const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
      const { error } = await supabase.from('email_accounts').select('id').limit(1);
      return { ok: !error, message: error ? error.message : 'connected', durationMs: Date.now() - t };
    } catch (err) {
      return { ok: false, message: (err as Error).message, durationMs: Date.now() - t };
    }
  }

  private async checkDiskSpace(): Promise<CheckResult> {
    const t = Date.now();
    try {
      const result = await exec("df /var/mail --output=pcent | tail -1 | tr -d ' %'");
      const pct    = parseInt(result.stdout, 10);
      return {
        ok:         pct < 90,
        message:    `${pct}% used`,
        durationMs: Date.now() - t,
      };
    } catch {
      // Non-fatal if /var/mail doesn't exist yet
      return { ok: true, message: 'disk check skipped (maildir not found)' };
    }
  }
}