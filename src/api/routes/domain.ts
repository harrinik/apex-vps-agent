import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Agent } from '../../core/Agent';
import { bearerAuth } from '../middleware/auth';

const addSchema = z.object({ domain: z.string().min(3) });

export function createDomainRouter(agent: Agent): Router {
  const router = Router();

  // GET /api/domains — list all domains
  router.get('/', bearerAuth, async (_req: Request, res: Response) => {
    const domains = await agent.domainService.listDomains();
    res.json({ ok: true, domains });
  });

  // POST /api/domains — add a domain
  router.post('/', bearerAuth, async (req: Request, res: Response) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    await agent.domainService.addDomain(parsed.data.domain);
    res.json({ ok: true, domain: parsed.data.domain });
  });

  // DELETE /api/domains/:domain — remove a domain
  router.delete('/:domain', bearerAuth, async (req: Request, res: Response) => {
    const { domain } = req.params;
    await agent.domainService.removeDomain(domain);
    res.json({ ok: true, domain });
  });

  // POST /api/domains/:domain/dkim — regenerate DKIM keys
  router.post('/:domain/dkim', bearerAuth, async (req: Request, res: Response) => {
    const { domain } = req.params;
    const result = await agent.dkimService.generateKeys(domain);
    res.json({ ok: true, domain, publicKey: result.publicKey });
  });

  // POST /api/sync — trigger a full sync immediately
  router.post('/sync', bearerAuth, async (_req: Request, res: Response) => {
    await agent.fullSync();
    res.json({ ok: true, message: 'Full sync triggered' });
  });

  return router;
}