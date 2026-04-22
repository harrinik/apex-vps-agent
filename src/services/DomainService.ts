import * as fs from 'fs/promises';
import { config } from '../config';
import { exec } from '../utils/exec';
import { logger } from '../utils/logger';

/**
 * Manages Postfix virtual domains list.
 * Atomic writes, postfix reload batching.
 */
export class DomainService {
  private reloadTimer?: NodeJS.Timeout;

  async addDomain(domain: string): Promise<void> {
    const lines = await this.readLines(config.POSTFIX_VDOMAINS);
    if (lines.includes(domain)) {
      logger.debug('[Domain] already in vdomains', { domain });
      return;
    }
    lines.push(domain);
    await this.writeAtomic(config.POSTFIX_VDOMAINS, lines.join('\n') + '\n');
    this.scheduleReload();
    logger.info('[Domain] added to vdomains', { domain });
  }

  async removeDomain(domain: string): Promise<void> {
    const lines    = await this.readLines(config.POSTFIX_VDOMAINS);
    const filtered = lines.filter(l => l.trim() !== domain);
    await this.writeAtomic(config.POSTFIX_VDOMAINS, filtered.join('\n') + '\n');
    this.scheduleReload();
    logger.info('[Domain] removed from vdomains', { domain });
  }

  async domainExists(domain: string): Promise<boolean> {
    const lines = await this.readLines(config.POSTFIX_VDOMAINS);
    return lines.includes(domain);
  }

  async listDomains(): Promise<string[]> {
    const lines = await this.readLines(config.POSTFIX_VDOMAINS);
    return lines.filter(l => l.trim() && !l.startsWith('#'));
  }

  async reloadPostfix(): Promise<void> {
    try {
      await exec('postfix reload');
      logger.info('[Domain] postfix reloaded');
    } catch (err) {
      logger.warn('[Domain] postfix reload failed (non-fatal in dev)', { error: (err as Error).message });
    }
  }

  /** Batch postfix reloads — coalesce multiple domain changes into 1 reload */
  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadPostfix().catch(() => {});
      this.reloadTimer = undefined;
    }, 2_000); // 2s debounce
  }

  private async readLines(filePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.split('\n').map(l => l.trim()).filter(Boolean);
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