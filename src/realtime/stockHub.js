import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { loadAuth } from '../middleware/auth.js';

// shopId -> Set<ws>
const rooms = new Map();

function join(shopId, ws) {
  if (!rooms.has(shopId)) rooms.set(shopId, new Set());
  rooms.get(shopId).add(ws);
}

function leave(shopId, ws) {
  const room = rooms.get(shopId);
  if (!room) return;
  room.delete(ws);
  if (!room.size) rooms.delete(shopId);
}

/** Pushes fresh stock rows to every screen currently open on that shop. */
export function broadcastStock(shopId, rows) {
  const room = rooms.get(String(shopId));
  if (!room || !room.size || !rows.length) return;
  const payload = JSON.stringify({ type: 'stock', items: rows });
  for (const ws of room) if (ws.readyState === 1) ws.send(payload);
}

/** Attaches the stock-updates WebSocket to the existing HTTP server, on /ws/stock. */
export function attachStockSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/stock' });

  wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    try {
      const { searchParams } = new URL(req.url, 'http://internal');
      const token = searchParams.get('token');
      const shopId = searchParams.get('shopId');
      if (!token || !shopId) return ws.close(1008, 'Missing credentials');

      const payload = jwt.verify(token, env.jwtSecret);
      const auth = await loadAuth(String(payload.sub));
      if (!auth || !auth.business || auth.user.status !== 'ACTIVE') return ws.close(1008, 'Unauthorized');

      const { user, shops } = auth;
      const allowed = user.role === 'ADMIN' ? shops : shops.filter((s) => user.shopIds.some((id) => String(id) === String(s._id)));
      if (!allowed.some((s) => String(s._id) === shopId)) return ws.close(1008, 'No access to this shop');

      ws.shopId = shopId;
      join(shopId, ws);
      ws.on('close', () => leave(shopId, ws));
    } catch {
      ws.close(1008, 'Unauthorized');
    }
  });

  // Drop dead connections (e.g. laptop went to sleep) so rooms don't leak.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        if (ws.shopId) leave(ws.shopId, ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
