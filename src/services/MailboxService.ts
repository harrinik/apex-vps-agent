import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { exec } from '../utils/exec';
import { logger } from '../utils/logger';

/**
 * Manages Dovecot passwd file entries and Postfix vmailbox entries.
 * All file writes are atomic (write to .tmp → rename) to avoid partial reads.
 */
export class MailboxService {
  // --- Dovecot passwd format: user@domain:{PLAIN}password:uid:gid::/var/mail/vhosts/domain/user
  // We store the hash from Supabase. If not available we create a locked account.
  private readonly LOCKED = '{PLAIN}LOCKED_ACCOUNT';

  async createMailbox(email: string, passwordHash?: string): Promise<void> {
    const [_local, domain] = email.split('@');
    if (!domain) throw new Error(`Invalid email: ${email}`);

    await this.ensureMaildir(email);
    await this.addToDovecotPasswd(email, passwordHash ?? this.LOCKED);
    await this.addToPostfixVmailbox(email);
    logger.info('[Mailbox] created', { email });
  }

  async deleteMailbox(email: string): Promise<void> {
    await this.removeFromDovecotPasswd(email);
    await this.removeFromPostfixVmailbox(email);
    logger.info('[Mailbox] deleted', { email });
  }

  async updatePassword(email: string, newHash: string): Promise<void> {
    const lines = await this.readLines(config.DOVECOT_PASSWD);
    const updated = lines.map(line => {
      if (!line.startsWith(`${email}:`)) return line;
      const parts = line.split(':');
      parts[1] = newHash;
      return parts.join(':');
    });
    await this.writeAtomic(config.DOVECOT_PASSWD, updated.join('\n') + '\n');
    logger.info('[Mailbox] password updated', { email });
  }

  async mailboxExists(email: string): Promise<boolean> {
    const lines = await this.readLines(config.DOVECOT_PASSWD);
    return lines.some(l => l.startsWith(`${email}:`));
  }

  async listMailboxes(): Promise<string[]> {
    const lines = await this.readLines(config.DOVECOT_PASSWD);
    return lines
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => l.split(':')[0]);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async ensureMaildir(email: string): Promise<void> {
    const [_local, domain] = email.split('@');
    const maildir = `/var/mail/vhosts/${domain}/${_local}`;
    await fs.mkdir(path.join(maildir, 'Maildir', 'new'), { recursive: true });
    await fs.mkdir(path.join(maildir, 'Maildir', 'cur'), { recursive: true });
    await fs.mkdir(path.join(maildir, 'Maildir', 'tmp'), { recursive: true });
    // Set correct ownership for vmail user (uid 5000 by convention)
    try {
      await exec(`chown -R 5000:5000 /var/mail/vhosts/${domain}/${_local}`);
    } catch {
      // Non-fatal: may not have chown access in dev
    }
  }

  private async addToDovecotPasswd(email: string, hash: string): Promise<void> {
    const [_local, domain] = email.split('@');
    const entry = `${email}:${hash}:5000:5000::/var/mail/vhosts/${domain}/${_local}::`;
    const lines  = await this.readLines(config.DOVECOT_PASSWD);
    // Remove any existing entry, then append
    const filtered = lines.filter(l => !l.startsWith(`${email}:`));
    filtered.push(entry);
    await this.writeAtomic(config.DOVECOT_PASSWD, filtered.join('\n') + '\n');
  }

  private async removeFromDovecotPasswd(email: string): Promise<void> {
    const lines   = await this.readLines(config.DOVECOT_PASSWD);
    const filtered = lines.filter(l => !l.startsWith(`${email}:`));
    await this.writeAtomic(config.DOVECOT_PASSWD, filtered.join('\n') + '\n');
  }

  private async addToPostfixVmailbox(email: string): Promise<void> {
    const [_local, domain] = email.split('@');
    const entry  = `${email}   ${domain}/${_local}/Maildir/`;
    const lines  = await this.readLines(config.POSTFIX_VMAILBOX);
    const filtered = lines.filter(l => !l.startsWith(`${email} `));
    filtered.push(entry);
    await this.writeAtomic(config.POSTFIX_VMAILBOX, filtered.join('\n') + '\n');
    await this.rebuildPostfixMap(config.POSTFIX_VMAILBOX);
  }

  private async removeFromPostfixVmailbox(email: string): Promise<void> {
    const lines   = await this.readLines(config.POSTFIX_VMAILBOX);
    const filtered = lines.filter(l => !l.startsWith(`${email} `));
    await this.writeAtomic(config.POSTFIX_VMAILBOX, filtered.join('\n') + '\n');
    await this.rebuildPostfixMap(config.POSTFIX_VMAILBOX);
  }

  private async rebuildPostfixMap(filePath: string): Promise<void> {
    try {
      await exec(`postmap ${filePath}`);
    } catch (err) {
      logger.warn('[Mailbox] postmap failed (non-fatal in dev)', { filePath, error: (err as Error).message });
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