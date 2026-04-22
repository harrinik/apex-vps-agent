import { Request, Response, NextFunction } from 'express';
import { config } from '../../config';

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }
  const token = authHeader.slice(7);
  if (token !== config.API_BEARER_TOKEN) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }
  next();
}