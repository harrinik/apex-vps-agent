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
  async generateKeys(_domain: string): Promise<DkimKeyPair> {
    logger.warn('[DKIM] DKIM key generation disabled - AWS SES handles DKIM signing for outgoing emails', { domain: _domain });
    // Return empty placeholder - actual DKIM keys are managed by AWS SES
    return { publicKey: '', privateKeyPath: '' };
  }

  async rotateKeys(_domain: string): Promise<DkimKeyPair> {
    logger.warn('[DKIM] DKIM key rotation disabled - AWS SES handles DKIM signing for outgoing emails', { domain: _domain });
    return { publicKey: '', privateKeyPath: '' };
  }

  async keyExists(_domain: string): Promise<boolean> {
    // Always return false since we don't manage local DKIM keys anymore
    return false;
  }

  async getPublicKeyRecord(_domain: string): Promise<string | null> {
    // Return null - AWS SES provides DKIM tokens via API
    return null;
  }
}