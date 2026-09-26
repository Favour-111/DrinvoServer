import mongoose from 'mongoose';
import { Sale, Shop, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { resolveRange } from '../utils/dates.js';
import { logAudit } from './audit.service.js';
import { invalidateAuthCache } from '../middleware/auth.js';

const COLORS = ['#1D5FD6', '#B45309', '#7C3AED', '#BE185D', '#0E7490', '#4D7C0F', '#C2410C'];
export const pickStaffColor = (count) => COLORS[count % COLORS.length];

export function publicUser(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    color: u.color,
    shopIds: (u.shopIds || []).map(String),
    lastActiveAt: u.lastActiveAt || null,
    createdAt: u.createdAt,
  };
}

const netExpr = { $cond: [{ $eq: ['$status', 'VOIDED'] }, 0, { $subtract: ['$total', { $add: ['$returnedAmount', '$refundedAmount'] }] }] };

/** Sales totals per staff member for today and this month at the current shop. */
export async function salesByStaff(ctx, staffIds) {
  const tz = ctx.business.timezone;
  const today = resolveRange({ range: 'today' }, tz);
  const month = resolveRange({ range: 'month' }, tz);
  const match = { shopId: ctx.shopId, createdAt: { $gte: month.start < today.start ? month.start : today.start } };
  if (staffIds) match.staffId = { $in: staffIds.map((id) => new mongoose.Types.ObjectId(String(id))) };
  const rows = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$staffId',
        monthSales: { $sum: { $cond: [{ $gte: ['$createdAt', month.start] }, netExpr, 0] } },
        todaySales: { $sum: { $cond: [{ $gte: ['$createdAt', today.start] }, netExpr, 0] } },
        todayTransactions: {
          $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', today.start] }, { $ne: ['$status', 'VOIDED'] }] }, 1, 0] },
        },
        monthTransactions: {
          $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', month.start] }, { $ne: ['$status', 'VOIDED'] }] }, 1, 0] },
        },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

export async function listStaff(ctx) {
  const users = await User.find({ businessId: ctx.businessId }).sort({ role: 1, name: 1 }).lean();
  const stats = await salesByStaff(ctx);
  return users.map((u) => {
    const s = stats.get(String(u._id));
    return {
      ...publicUser(u),
      todaySales: s?.todaySales || 0,
      todayTransactions: s?.todayTransactions || 0,
      monthSales: s?.monthSales || 0,
      monthTransactions: s?.monthTransactions || 0,
    };
  });
}

export async function getStaff(ctx, id) {
  const user = await User.findOne({ _id: id, businessId: ctx.businessId }).lean();
  if (!user) throw ApiError.notFound('Staff member not found.');
  const stats = (await salesByStaff(ctx, [user._id])).get(String(user._id));
  const recent = await Sale.find({ shopId: ctx.shopId, staffId: user._id }).sort({ createdAt: -1 }).limit(10).lean();
  return {
    user: publicUser(user),
    stats: {
      todaySales: stats?.todaySales || 0,
      todayTransactions: stats?.todayTransactions || 0,
      monthSales: stats?.monthSales || 0,
      monthTransactions: stats?.monthTransactions || 0,
    },
    recentSales: recent.map((s) => ({
      id: String(s._id),
      receiptNumber: s.receiptNumber,
      total: s.total,
      paymentMethod: s.paymentMethod,
      status: s.status,
      itemCount: s.itemCount,
      createdAt: s.createdAt,
    })),
  };
}

async function validShopIds(ctx, shopIds) {
  if (!shopIds?.length) return [ctx.shopId];
  const count = await Shop.countDocuments({ _id: { $in: shopIds }, businessId: ctx.businessId });
  if (count !== shopIds.length) throw ApiError.badRequest('Choose a valid shop.');
  return shopIds;
}

export async function createStaff(ctx, input) {
  const exists = await User.exists({ email: input.email });
  if (exists) throw ApiError.conflict('An account with this email already exists.', { fields: { email: 'Already in use' } });
  const count = await User.countDocuments({ businessId: ctx.businessId });
  const user = await User.create({
    ...input,
    businessId: ctx.businessId,
    shopIds: await validShopIds(ctx, input.shopIds),
    color: pickStaffColor(count),
  });
  await logAudit(ctx, { category: 'staff', action: 'staff.created', summary: 'added staff', target: user.name, detail: `${user.role === 'ADMIN' ? 'Admin' : 'Staff'} · ${ctx.shop.name}`, entityType: 'User', entityId: user._id });
  return publicUser(user);
}

export async function updateStaff(ctx, id, input) {
  const user = await User.findOne({ _id: id, businessId: ctx.businessId });
  if (!user) throw ApiError.notFound('Staff member not found.');
  if (String(user._id) === String(ctx.userId) && input.role && input.role !== user.role) {
    throw ApiError.badRequest('You can’t change your own role.');
  }
  if (input.email && input.email !== user.email && (await User.exists({ email: input.email }))) {
    throw ApiError.conflict('An account with this email already exists.');
  }
  if (input.shopIds) input.shopIds = await validShopIds(ctx, input.shopIds);
  Object.assign(user, input);
  await user.save();
  invalidateAuthCache(user._id);
  await logAudit(ctx, { category: 'staff', action: 'staff.updated', summary: 'updated staff', target: user.name, entityType: 'User', entityId: user._id });
  return publicUser(user);
}

export async function setStaffStatus(ctx, id, status) {
  if (String(id) === String(ctx.userId)) throw ApiError.badRequest('You can’t deactivate your own account.');
  const user = await User.findOneAndUpdate({ _id: id, businessId: ctx.businessId }, { $set: { status } }, { new: true });
  if (!user) throw ApiError.notFound('Staff member not found.');
  invalidateAuthCache(user._id);
  if (status === 'INACTIVE' && user.role === 'ADMIN') {
    const admins = await User.countDocuments({ businessId: ctx.businessId, role: 'ADMIN', status: 'ACTIVE' });
    if (admins === 0) {
      await User.updateOne({ _id: id }, { $set: { status: 'ACTIVE' } });
      throw ApiError.badRequest('At least one admin must stay active.');
    }
  }
  await logAudit(ctx, {
    category: 'staff',
    action: status === 'ACTIVE' ? 'staff.reactivated' : 'staff.deactivated',
    summary: status === 'ACTIVE' ? 'reactivated staff' : 'deactivated staff',
    target: user.name,
    entityType: 'User',
    entityId: user._id,
  });
  return publicUser(user);
}

export async function resetStaffPassword(ctx, id, password) {
  const user = await User.findOne({ _id: id, businessId: ctx.businessId }).select('+password');
  if (!user) throw ApiError.notFound('Staff member not found.');
  user.password = password;
  await user.save();
  invalidateAuthCache(user._id);
  await logAudit(ctx, { category: 'staff', action: 'staff.password_reset', summary: 'reset password for', target: user.name, entityType: 'User', entityId: user._id });
  return { ok: true };
}
