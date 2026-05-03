import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { exec } from '../utils/exec';
import { logger } from '../utils/logger';

export interface DkimKeyPair {
  publicKey: string;  // DNS TXT record value
  privateKeyPath: string;
}

/**
 * DKIM key management DISABLED - AWS SES handles DKIM signing for outgoing emails.
 * This service is kept for backward compatibility but does nothing.
 * AWS SES provides DKIM tokens that should be added as CNAME records in DNS.
 */
export class DkimService {
  async generateKeys(domain: string): Promise<DkimKeyPair> {
    logger.warn('[DKIM] DKIM key generation disabled - AWS SES handles DKIM signing for outgoing emails', { domain });
    // Return empty placeholder - actual DKIM keys are managed by AWS SES
    return { publicKey: '', privateKeyPath: '' };
  }

  async rotateKeys(domain: string): Promise<DkimKeyPair> {
    logger.warn('[DKIM] DKIM key rotation disabled - AWS SES handles DKIM signing for outgoing emails', { domain });
    return { publicKey: '', privateKeyPath: '' };
  }

  async keyExists(domain: string): Promise<boolean> {
    // Always return false since we don't manage local DKIM keys anymore
    return false;
  }

  async getPublicKeyRecord(domain: string): Promise<string | null> {
    // Return null - AWS SES provides DKIM tokens via API
    return null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private pemToDnsTxt(pem: string): string {
    // Strip PEM headers and newlines to get raw base64
    return pem
      .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, '')
      .replace(/\s/g, '');
  }

  private async updateKeyTable(domain: string, selector: string, privatePath: string): Promise<void> {
    const entry    = `${selector}._domainkey.${domain} ${domain}:${selector}:${privatePath}`;
    const existing = await this.readLines(config.OPENDKIM_KEYTABLE);
    const filtered = existing.filter(l => !l.includes(`._domainkey.${domain}`));
    filtered.push(entry);
    await this.writeAtomic(config.OPENDKIM_KEYTABLE, filtered.join('\n') + '\n');
  }

  private async updateSigningTable(domain: string, selector: string): Promise<void> {
    const entry    = `*@${domain} ${selector}._domainkey.${domain}`;
    const existing = await this.readLines(config.OPENDKIM_SIGNTABLE);
    const filtered = existing.filter(l => !l.includes(`@${domain}`));
    filtered.push(entry);
    await this.writeAtomic(config.OPENDKIM_SIGNTABLE, filtered.join('\n') + '\n');
  }

  private async updateTrustedHosts(domain: string): Promise<void> {
    const existing = await this.readLines(config.OPENDKIM_TRUSTED);
    if (!existing.includes(domain)) {
      existing.push(domain);
      await this.writeAtomic(config.OPENDKIM_TRUSTED, existing.join('\n') + '\n');
    }
  }

  private async reloadOpendkim(): Promise<void> {
    try {
      await exec('systemctl reload opendkim || service opendkim reload');
    } catch (err) {
      logger.warn('[DKIM] opendkim reload failed (non-fatal in dev)', { error: (err as Error).message });
    }
  }

  private async readLines(filePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  private async writeAtomic(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
  }
}