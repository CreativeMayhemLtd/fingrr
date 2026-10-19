import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

// Minimal relay server.
// - Knows NOTHING about users' real identities.
// - Clients register by pseudonymous session ID (HKDF-derived).
// - Routes SignalingMessage blobs by `to` session ID.
// - Does not log message contents.

const PORT = Number(process.env.PORT ?? 3001);

interface Client {
  ws: WebSocket;
  sessionId: string;
  connectedAt: number;
}

const clients = new Map<string, Client>();

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const sessionId = url.searchParams.get('sid');

  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId)) {
    ws.close(4000, 'invalid session id');
    return;
  }

  // Evict any existing connection with the same session ID
  const existing = clients.get(sessionId);
  if (existing) existing.ws.close(4001, 'replaced');

  clients.set(sessionId, { ws, sessionId, connectedAt: Date.now() });
  console.log(`[relay] +${sessionId.slice(0, 8)} (${clients.size} connected)`);

  ws.on('message', (data) => {
    let msg: { to?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const target = clients.get(msg.to as string);
    if (target?.ws.readyState === WebSocket.OPEN) {
      target.ws.send(JSON.stringify(msg));
    }
  });

  ws.on('close', () => {
    clients.delete(sessionId);
    console.log(`[relay] -${sessionId.slice(0, 8)} (${clients.size} connected)`);
  });
});

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
});
