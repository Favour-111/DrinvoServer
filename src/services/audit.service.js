import { AuditLog } from '../models/index.js';
import { createDoc } from '../utils/atomic.js';
import { pageParams } from '../utils/serialize.js';

/**
 * Records an audit entry. Pass `tx` to make it part of the same atomic write.
 * entry: { category, action, summary, target?, detail?, entityType?, entityId? }
 */
export async function logAudit(ctx, entry, tx) {
  const data = {
    businessId: ctx.businessId,
    shopId: ctx.shopId ?? null,
    userId: ctx.userId,
    target: '',
    detail: '',
    ...entry,
  };
  if (tx) return createDoc(AuditLog, data, tx);
  return AuditLog.create(data);
}

export async function listAudit(ctx, query) {
  const { page, limit, skip } = pageParams(query, { defaultLimit: 50 });
  const filter = { businessId: ctx.businessId, $or: [{ shopId: ctx.shopId }, { shopId: null }] };
  if (query.category && query.category !== 'all') filter.category = query.category;
  const [items, total] = await Promise.all([
    AuditLog.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user', pipeline: [{ $project: { name: 1, color: 1, role: 1 } }] } },
      { $set: { userId: { $first: '$user' } } },
    ]),
    AuditLog.countDocuments(filter),
  ]);
  return {
    items: items.map((a) => ({
      id: String(a._id),
      category: a.category,
      action: a.action,
      summary: a.summary,
      target: a.target,
      detail: a.detail,
      entityType: a.entityType,
      entityId: a.entityId ? String(a.entityId) : null,
      createdAt: a.createdAt,
      user: a.userId ? { id: String(a.userId._id), name: a.userId.name, color: a.userId.color, role: a.userId.role } : null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
  };
}
