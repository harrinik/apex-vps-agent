import { Job } from '../core/Queue';
import { DomainService } from '../services/DomainService';
import { logger } from '../utils/logger';

export interface DomainAddPayload    { domain: string }
export interface DomainRemovePayload { domain: string }

const domainService = new DomainService();

export async function handleDomainAdd(job: Job<DomainAddPayload>): Promise<void> {
  const { domain } = job.payload;
  const exists = await domainService.domainExists(domain);
  if (exists) {
    logger.info('[DomainWorker] domain already exists — skipped', { domain });
    return;
  }
  await domainService.addDomain(domain);
}

export async function handleDomainRemove(job: Job<DomainRemovePayload>): Promise<void> {
  const { domain } = job.payload;
  await domainService.removeDomain(domain);
}