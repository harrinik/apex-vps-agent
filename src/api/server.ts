import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Agent } from '../core/Agent';
import { createHealthRouter } from './routes/health';
import { createMailboxRouter } from './routes/mailbox';
import { createDomainRouter } from './routes/domain';
import scanRouter from './routes/scan';
import { logger } from '../utils/logger';
import { config } from '../config';

export function createApiServer(agent: Agent) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  // Strict rate limiting — this API is only hit by Supabase webhooks or ops tooling
  app.use(rateLimit({
    windowMs: 60_000,
    max:      300,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Too many requests' },
  }));

  // Request logging (request ID injected for tracing)
  app.use((req, _res, next) => {
    (req as express.Request & { requestId: string }).requestId = Math.random().toString(36).slice(2, 10);
    logger.debug('[API]', { method: req.method, path: req.path, ip: req.ip });
    next();
  });

  // Routes
  app.use('/health',        createHealthRouter(agent));
  app.use('/api/mailboxes', createMailboxRouter(agent));
  app.use('/api/domains',   createDomainRouter(agent));
  app.use('/api/scan',      scanRouter);

  // Root
  app.get('/', (_req, res) => res.json({ name: 'apex-vps-agent', version: '2.0.0' }));

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('[API] unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export async function startApiServer(agent: Agent): Promise<void> {
  const app    = createApiServer(agent);
  const port   = config.API_PORT;

  await new Promise<void>((resolve) => {
    app.listen(port, '0.0.0.0', () => {
      logger.info(`[API] listening on port ${port}`);
      resolve();
    });
  });
}