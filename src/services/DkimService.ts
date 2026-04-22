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
 * DKIM key management using system openssl (always available on Linux).
 * Keys are stored in /etc/opendkim/keys/<domain>/<selector>.{private,txt}
 * OpenDKIM config files (KeyTable, SigningTable, TrustedHosts) are updated atomically.
 */
export class DkimService {
  async generateKeys(domain: string): Promise<DkimKeyPair> {
    const keysDir     = path.join(config.OPENDKIM_KEYS_DIR, domain);
    const selector    = config.DKIM_SELECTOR;
    const privatePath = path.join(keysDir, `${selector}.private`);
    const publicPath  = path.join(keysDir, `${selector}.txt`);

    await fs.mkdir(keysDir, { recursive: true });

    // Generate 2048-bit RSA key pair via openssl
    await exec(`openssl genrsa -out "${privatePath}" 2048`);
    await exec(`chmod 600 "${privatePath}"`);

    // Extract public key in PKCS#8 PEM, then convert to DNS TXT format
    const pubPem = await exec(`openssl rsa -in "${privatePath}" -pubout -outform PEM`);
    const dnsRecord = this.pemToDnsTxt(pubPem.stdout);

    // Write DNS record file
    const txtContent = `${selector}._domainkey.${domain} IN TXT "v=DKIM1; k=rsa; p=${dnsRecord}"`;
    await fs.writeFile(publicPath, txtContent, 'utf8');

    // Update OpenDKIM config
    await this.updateKeyTable(domain, selector, privatePath);
    await this.updateSigningTable(domain, selector);
    await this.updateTrustedHosts(domain);

    // Reload OpenDKIM
    await this.reloadOpendkim();

    logger.info('[DKIM] keys generated', { domain, selector });
    return { publicKey: dnsRecord, privateKeyPath: privatePath };
  }

  async rotateKeys(domain: string): Promise<DkimKeyPair> {
    logger.info('[DKIM] rotating keys', { domain });
    // Archive old keys
    const keysDir  = path.join(config.OPENDKIM_KEYS_DIR, domain);
    const ts       = Date.now();
    try {
      await exec(`cp -r "${keysDir}" "${keysDir}.backup.${ts}"`);
    } catch { /* non-fatal */ }
    return this.generateKeys(domain);
  }

  async keyExists(domain: string): Promise<boolean> {
    const selector    = config.DKIM_SELECTOR;
    const privatePath = path.join(config.OPENDKIM_KEYS_DIR, domain, `${selector}.private`);
    try {
      await fs.access(privatePath);
      return true;
    } catch {
      return false;
    }
  }

  async getPublicKeyRecord(domain: string): Promise<string | null> {
    const selector   = config.DKIM_SELECTOR;
    const publicPath = path.join(config.OPENDKIM_KEYS_DIR, domain, `${selector}.txt`);
    try {
      const content = await fs.readFile(publicPath, 'utf8');
      const match   = content.match(/p=([A-Za-z0-9+/=]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
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