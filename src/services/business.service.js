import { Business, Shop } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from './audit.service.js';
import { invalidateAuthCache } from '../middleware/auth.js';

export async function getBusiness(ctx) {
  const business = await Business.findById(ctx.businessId).lean();
  return { ...business, id: String(business._id) };
}

/** Unauthenticated: just enough for the staff signup page (never settings, never money). */
export async function getPublicBusiness(businessId) {
  const business = await Business.findById(businessId, 'name').lean();
  if (!business) throw ApiError.notFound('That signup link isn’t valid. Ask your admin for a new one.');
  const shops = await Shop.find({ businessId, isActive: true }, 'name address').sort({ createdAt: 1 }).lean();
  return { id: String(business._id), name: business.name, shops: shops.map((s) => ({ id: String(s._id), name: s.name, address: s.address })) };
}

export async function updateBusiness(ctx, input) {
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
    } catch {
      throw ApiError.badRequest('Unknown time zone.');
    }
  }
  const business = await Business.findByIdAndUpdate(ctx.businessId, { $set: input }, { new: true, runValidators: true }).lean();
  invalidateAuthCache();
  await logAudit(ctx, { category: 'settings', action: 'settings.updated', summary: 'updated business settings', target: '', detail: Object.keys(input).join(', ') });
  return { ...business, id: String(business._id) };
}

export async function listShops(ctx) {
  const filter = { businessId: ctx.businessId };
  if (ctx.user.role !== 'ADMIN') filter._id = { $in: ctx.user.shopIds };
  const shops = await Shop.find(filter).sort({ createdAt: 1 }).lean();
  return shops.map((s) => ({ ...s, id: String(s._id) }));
}

/** Multi-shop ready: new shops get stock rows on first movement, so nothing else is needed here. */
export async function createShop(ctx, input) {
  const shop = await Shop.create({ ...input, businessId: ctx.businessId });
  invalidateAuthCache();
  await logAudit(ctx, { category: 'settings', action: 'shop.created', summary: 'added shop', target: shop.name, entityType: 'Shop', entityId: shop._id });
  return { ...shop.toJSON() };
}

export async function updateShop(ctx, id, input) {
  const shop = await Shop.findOneAndUpdate({ _id: id, businessId: ctx.businessId }, { $set: input }, { new: true, runValidators: true }).lean();
  if (!shop) throw ApiError.notFound('Shop not found.');
  invalidateAuthCache();
  await logAudit(ctx, { category: 'settings', action: 'shop.updated', summary: 'updated shop', target: shop.name, entityType: 'Shop', entityId: shop._id });
  return { ...shop, id: String(shop._id) };
}
