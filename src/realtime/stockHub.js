import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { loadAuth } from '../middleware/auth.js';
import { checkStaffAccess } from '../utils/staffAccess.js';

// shopId -> Set<ws>
const rooms = new Map();
// businessId -> Set<ws>, staff connections only, so an access-rules change can kick them immediately
const staffByBusiness = new Map();

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

function joinStaffBusiness(businessId, ws) {
  const key = String(businessId);
  if (!staffByBusiness.has(key)) staffByBusiness.set(key, new Set());
  staffByBusiness.get(key).add(ws);
}

function leaveStaffBusiness(businessId, ws) {
  const key = String(businessId);
  const set = staffByBusiness.get(key);
  if (!set) return;
  set.delete(ws);
  if (!set.size) staffByBusiness.delete(key);
}

/** Pushes fresh stock rows to every screen currently open on that shop. */
export function broadcastStock(shopId, rows) {
  const room = rooms.get(String(shopId));
  if (!room || !room.size || !rows.length) return;
  const payload = JSON.stringify({ type: 'stock', items: rows });
  for (const ws of room) if (ws.readyState === 1) ws.send(payload);
}

/** Re-verifies staff access for every connected staff socket of a business and kicks anyone no longer allowed. */
export async function recheckBusinessAccess(businessId) {
  const set = staffByBusiness.get(String(businessId));
  if (!set || !set.size) return;
  await Promise.all([...set].map(enforceAccess));
}

async function enforceAccess(ws) {
  if (ws.role !== 'STAFF') return true;
  const auth = await loadAuth(ws.userId).catch(() => null);
  if (!auth || !auth.business || auth.user.status !== 'ACTIVE') {
    ws.close(4001, 'Session ended');
    return false;
  }
  const gate = checkStaffAccess(auth.business);
  if (!gate.allowed) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'access-denied', reason: gate.reason }));
    ws.close(4001, gate.reason.slice(0, 120));
    return false;
  }
  return true;
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

      const { user, shops, business } = auth;
      const allowed = user.role === 'ADMIN' ? shops : shops.filter((s) => user.shopIds.some((id) => String(id) === String(s._id)));
      if (!allowed.some((s) => String(s._id) === shopId)) return ws.close(1008, 'No access to this shop');

      if (user.role === 'STAFF') {
        const gate = checkStaffAccess(business);
        if (!gate.allowed) return ws.close(4001, gate.reason.slice(0, 120));
      }

      ws.shopId = shopId;
      ws.userId = String(user._id);
      ws.role = user.role;
      ws.businessId = String(user.businessId);
      join(shopId, ws);
      if (user.role === 'STAFF') joinStaffBusiness(ws.businessId, ws);
      ws.on('close', () => {
        leave(shopId, ws);
        if (ws.role === 'STAFF') leaveStaffBusiness(ws.businessId, ws);
      });
    } catch {
      ws.close(1008, 'Unauthorized');
    }
  });

  // Drop dead connections (e.g. laptop went to sleep) and re-verify staff access rules on every tick,
  // so a staff member logged in when business hours close is kicked within one heartbeat interval.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        if (ws.shopId) leave(ws.shopId, ws);
        if (ws.role === 'STAFF') leaveStaffBusiness(ws.businessId, ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
      if (ws.role === 'STAFF') enforceAccess(ws);
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
