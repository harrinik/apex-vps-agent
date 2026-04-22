import { Router, Request, Response } from 'express';
import { Agent } from '../../core/Agent';
import { HealthService } from '../../services/HealthService';

export function createHealthRouter(agent: Agent): Router {
  const router         = Router();
  const healthService  = new HealthService();

  // Liveness — just return 200 if the process is alive
  router.get('/live', (_req: Request, res: Response) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // Readiness — full health check
  router.get('/ready', async (_req: Request, res: Response) => {
    const status = await healthService.check();
    const code   = status.status === 'unhealthy' ? 503 : 200;
    res.status(code).json(status);
  });

  // Prometheus-compatible metrics
  router.get('/metrics', (_req: Request, res: Response) => {
    const mem  = process.memoryUsage();
    const stats = agent.queueStats;
    const lines = [
      `# HELP vps_agent_queue_pending Number of pending jobs in queue`,
      `# TYPE vps_agent_queue_pending gauge`,
      `vps_agent_queue_pending ${stats.pending}`,
      ``,
      `# HELP vps_agent_uptime_seconds Process uptime in seconds`,
      `# TYPE vps_agent_uptime_seconds gauge`,
      `vps_agent_uptime_seconds ${Math.floor(process.uptime())}`,
      ``,
      `# HELP vps_agent_memory_heap_bytes Heap memory used`,
      `# TYPE vps_agent_memory_heap_bytes gauge`,
      `vps_agent_memory_heap_bytes ${mem.heapUsed}`,
    ];
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(lines.join('\n'));
  });

  return router;
}