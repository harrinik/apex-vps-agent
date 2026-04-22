import { Job } from '../core/Queue';
import { MailboxService } from '../services/MailboxService';
import { logger } from '../utils/logger';

export interface MailboxCreatePayload {
  email: string;
  passwordHash?: string;
}

export interface MailboxDeletePayload {
  email: string;
}

export interface MailboxUpdatePasswordPayload {
  email: string;
  passwordHash: string;
}

const mailboxService = new MailboxService();

export async function handleMailboxCreate(job: Job<MailboxCreatePayload>): Promise<void> {
  const { email, passwordHash } = job.payload;
  const exists = await mailboxService.mailboxExists(email);
  if (exists) {
    logger.info('[MailboxWorker] mailbox already exists — skipped', { email });
    return;
  }
  await mailboxService.createMailbox(email, passwordHash);
}

export async function handleMailboxDelete(job: Job<MailboxDeletePayload>): Promise<void> {
  const { email } = job.payload;
  const exists = await mailboxService.mailboxExists(email);
  if (!exists) {
    logger.info('[MailboxWorker] mailbox not found — skipped', { email });
    return;
  }
  await mailboxService.deleteMailbox(email);
}

export async function handleMailboxUpdatePassword(job: Job<MailboxUpdatePasswordPayload>): Promise<void> {
  const { email, passwordHash } = job.payload;
  await mailboxService.updatePassword(email, passwordHash);
}