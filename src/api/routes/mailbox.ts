import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Agent } from '../../core/Agent';
import { bearerAuth } from '../middleware/auth';

const createSchema = z.object({
  email:        z.string().email(),
  passwordHash: z.string().optional(),
});

const deleteSchema = z.object({
  email: z.string().email(),
});

export function createMailboxRouter(agent: Agent): Router {
  const router = Router();

  // POST /api/mailboxes — trigger mailbox creation
  router.post('/', bearerAuth, async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { email, passwordHash } = parsed.data;
    await agent.mailboxService.createMailbox(email, passwordHash);
    res.json({ ok: true, email });
  });

  // DELETE /api/mailboxes — trigger mailbox deletion
  router.delete('/', bearerAuth, async (req: Request, res: Response) => {
    const parsed = deleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { email } = parsed.data;
    await agent.mailboxService.deleteMailbox(email);
    res.json({ ok: true, email });
  });

  // GET /api/mailboxes — list all mailboxes
  router.get('/', bearerAuth, async (_req: Request, res: Response) => {
    const mailboxes = await agent.mailboxService.listMailboxes();
    res.json({ ok: true, mailboxes, count: mailboxes.length });
  });

  return router;
}