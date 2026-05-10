import { Router, Request, Response } from 'express';
import { simpleParser } from 'mailparser';
import { logger } from '../../utils/logger';

export function createInboundRouter(): Router {
  const router = Router();

  // POST /api/internal/inbound — Receives raw email stream from Postfix, parses it, and forwards to Supabase
  router.post('/', async (req: Request, res: Response) => {
    try {
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

      if (!supabaseUrl || !supabaseKey) {
        logger.error('[Inbound] Missing Supabase credentials in vps-agent environment');
        res.status(500).json({ error: 'Server configuration error' });
        return;
      }

      logger.info('[Inbound] Received raw email stream from Postfix. Parsing...');

      // Parse the raw MIME stream
      const parsed = await simpleParser(req);

      // Construct the InboundEmail JSON payload expected by receive-email Edge Function
      const inboundPayload = {
        from: parsed.from?.value[0]?.address || '',
        from_name: parsed.from?.value[0]?.name || '',
        to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap(t => t.value.map(v => v.address)) : [],
        cc: parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap(t => t.value.map(v => v.address)) : [],
        subject: parsed.subject || '',
        text: parsed.text || '',
        html: parsed.html || parsed.textAsHtml || '',
        message_id: parsed.messageId || '',
        in_reply_to: parsed.inReplyTo || '',
        references: parsed.references || [],
        raw: '', // We omit raw text to save DB space and network payload size, unless explicitly needed
        attachments: [] // Not handling binary attachments in JSON right now to prevent memory bloat
      };

      if (!inboundPayload.from || inboundPayload.to.length === 0) {
        logger.warn('[Inbound] Missing from/to fields after parsing email', { messageId: parsed.messageId });
        res.status(400).json({ error: 'Missing from/to fields' });
        return;
      }

      logger.info(`[Inbound] Parsed successfully. Forwarding to Supabase (from: ${inboundPayload.from}, subject: ${inboundPayload.subject})`);

      // Forward to Supabase Edge Function
      const functionUrl = `${supabaseUrl}/functions/v1/receive-email`;
      const edgeResponse = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}` // Using service key so it bypasses RLS and triggers webhook correctly
        },
        body: JSON.stringify(inboundPayload)
      });

      if (!edgeResponse.ok) {
        const errorText = await edgeResponse.text();
        logger.error('[Inbound] Supabase Edge Function rejected the email', { status: edgeResponse.status, errorText });
        res.status(502).json({ error: 'Failed to forward to Supabase', details: errorText });
        return;
      }

      logger.info('[Inbound] Email successfully forwarded and queued in Supabase DB.');
      
      // Return 200 OK to Postfix so it dequeues the email
      res.status(200).json({ ok: true });

    } catch (error) {
      logger.error('[Inbound] Exception during email processing', { error: (error as Error).message });
      // Return 500 so Postfix will defer and retry later if needed
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
