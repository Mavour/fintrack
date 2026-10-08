import type { FastifyInstance } from 'fastify';
import { addSseClient } from '../services/sse.js';

/** SSE live updates: GET /api/events (auth via existing session cookie hook). */
export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/api/events', async (req, reply) => {
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write(': connected\n\n');
    const done = addSseClient(raw);
    // Biarkan koneksi terbuka; fastify tidak boleh menutup reply.
    req.raw.on('close', done);
    return reply.hijack();
  });
}
