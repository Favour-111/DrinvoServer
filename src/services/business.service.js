import { Business, Shop } from '../models/index.js';
import { can, P } from '../config/roles.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from './audit.service.js';
import { invalidateAuthCache } from '../middleware/auth.js';
import { recheckBusinessAccess } from '../realtime/stockHub.js';

export async function getBusiness(ctx) {
  const business = await Business.findById(ctx.businessId).lean();
  return { ...business, id: String(business._id) };
}

export async function updateBusiness(ctx, input) {
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
    } catch {
      throw ApiError.badRequest('Unknown time zone.');
    }
  }

  const { staffAccess, ...rest } = input;
  const set = { ...rest };
  let shutdownChanged;
  if (staffAccess) {
    const current = await Business.findById(ctx.businessId, 'staffAccess').lean();
    for (const [key, value] of Object.entries(staffAccess)) set[`staffAccess.${key}`] = value;
    if (Object.prototype.hasOwnProperty.call(staffAccess, 'shutdown') && staffAccess.shutdown !== Boolean(current?.staffAccess?.shutdown)) {
      shutdownChanged = staffAccess.shutdown;
    }
  }

  const business = await Business.findByIdAndUpdate(ctx.businessId, { $set: set }, { new: true, runValidators: true }).lean();
  invalidateAuthCache();

  if (shutdownChanged !== undefined) {
    await logAudit(ctx, {
      category: 'auth',
      action: shutdownChanged ? 'staff.access_disabled' : 'staff.access_enabled',
      summary: shutdownChanged ? 'disabled staff access' : 'enabled staff access',
    });
  } else if (staffAccess) {
    await logAudit(ctx, { category: 'auth', action: 'staff.access_schedule_updated', summary: 'updated the staff access schedule' });
  }
  if (Object.keys(rest).length) {
    await logAudit(ctx, { category: 'settings', action: 'settings.updated', summary: 'updated business settings', target: '', detail: Object.keys(rest).join(', ') });
  }
  if (staffAccess) recheckBusinessAccess(ctx.businessId);

  return { ...business, id: String(business._id) };
}

export async function listShops(ctx) {
  const filter = { businessId: ctx.businessId };
  // Anyone who can move stock between shops needs to see every shop, not just their own assignment.
  if (ctx.user.role !== 'ADMIN' && !can(ctx.user, P.INVENTORY_TRANSFER)) filter._id = { $in: ctx.user.shopIds };
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
