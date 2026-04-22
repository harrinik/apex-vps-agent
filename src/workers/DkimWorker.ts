import { Job } from '../core/Queue';
import { DkimService } from '../services/DkimService';
import { SupabaseService } from '../services/SupabaseService';
import { logger } from '../utils/logger';

export interface DkimGeneratePayload { domainId: string; domain: string }
export interface DkimRotatePayload   { domainId: string; domain: string }

const dkimService    = new DkimService();
const supabaseService = new SupabaseService();

export async function handleDkimGenerate(job: Job<DkimGeneratePayload>): Promise<void> {
  const { domainId, domain } = job.payload;

  const exists = await dkimService.keyExists(domain);
  if (exists) {
    logger.info('[DkimWorker] keys already exist — skipped', { domain });
    return;
  }

  const { publicKey } = await dkimService.generateKeys(domain);
  await supabaseService.saveDkimPublicKey(domainId, publicKey);
  logger.info('[DkimWorker] DKIM keys generated + synced', { domain });
}

export async function handleDkimRotate(job: Job<DkimRotatePayload>): Promise<void> {
  const { domainId, domain } = job.payload;
  const { publicKey } = await dkimService.rotateKeys(domain);
  await supabaseService.saveDkimPublicKey(domainId, publicKey);
  logger.info('[DkimWorker] DKIM keys rotated + synced', { domain });
}