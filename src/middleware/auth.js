import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User, Shop, Business } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { can } from '../config/roles.js';
import { checkStaffAccess } from '../utils/staffAccess.js';

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

/*
 * Every request needs the user, their business and their shops. With a remote
 * database each lookup is a network round trip, so they are cached briefly.
 * Anything that changes a user, business or shop calls invalidateAuthCache().
 */
const CACHE_TTL_MS = 60_000;
const authCache = new Map(); // userId -> { user, business, shops, expires }

export function invalidateAuthCache(userId) {
  if (userId) authCache.delete(String(userId));
  else authCache.clear();
}

export async function loadAuth(userId) {
  const hit = authCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit;
  const user = await User.findById(userId).lean();
  if (!user) return null;
  const [business, shops] = await Promise.all([
    Business.findById(user.businessId).lean(),
    Shop.find({ businessId: user.businessId, isActive: true }).sort({ createdAt: 1 }).lean(),
  ]);
  const entry = { user, business, shops, expires: Date.now() + CACHE_TTL_MS };
  authCache.set(userId, entry);
  return entry;
}

/** Verifies the Bearer token and loads the current user. Rejects deactivated accounts. */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw ApiError.unauthorized('Your session has expired. Please sign in again.');
  }

  const auth = await loadAuth(String(payload.sub));
  if (!auth || !auth.business) throw ApiError.unauthorized();
  const { user } = auth;
  if (user.status !== 'ACTIVE') throw ApiError.unauthorized('This account has been deactivated.');
  if (user.role === 'STAFF') {
    const gate = checkStaffAccess(auth.business);
    if (!gate.allowed) throw ApiError.unauthorized(gate.reason);
  }
  if (user.passwordChangedAt && payload.iat * 1000 < new Date(user.passwordChangedAt).getTime() - 1000) {
    throw ApiError.unauthorized('Your password was changed. Please sign in again.');
  }

  // Throttle lastActiveAt writes to once a minute, without waiting for them
  if (!user.lastActiveAt || Date.now() - new Date(user.lastActiveAt).getTime() > 60_000) {
    user.lastActiveAt = new Date();
    User.updateOne({ _id: user._id }, { $set: { lastActiveAt: user.lastActiveAt } }).catch(() => {});
  }

  req.user = user;
  req.auth = auth;
  next();
});

/**
 * Resolves the active shop from the X-Shop-Id header (or the user's first shop)
 * and checks the user may act in it. Sets req.ctx for services.
 */
export const shopContext = (req, _res, next) => {
  const { user, business, shops } = req.auth;
  const requested = req.get('X-Shop-Id');
  const allowedShops = user.role === 'ADMIN' ? shops : shops.filter((s) => user.shopIds.some((id) => String(id) === String(s._id)));

  let shop;
  if (requested) {
    if (!/^[a-f\d]{24}$/i.test(requested)) return next(ApiError.badRequest('Invalid shop.'));
    shop = allowedShops.find((s) => String(s._id) === requested);
    if (!shop) return next(ApiError.forbidden('You do not have access to this shop.'));
  } else {
    shop = allowedShops[0];
    if (!shop) return next(ApiError.forbidden('No shop is assigned to your account.'));
  }

  // Stock-changing calls record which variants they touched here, so a single
  // middleware can push live updates for them after the response is sent.
  req.ctx = { user, userId: user._id, businessId: user.businessId, business, shopId: shop._id, shop, touchedVariantIds: new Set() };
  next();
};

/** Allows the request only if the user's role grants every listed permission. */
export const requirePermission =
  (...permissions) =>
  (req, _res, next) => {
    if (!permissions.every((p) => can(req.user, p))) return next(ApiError.forbidden());
    next();
  };
