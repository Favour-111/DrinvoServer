import crypto from 'node:crypto';
import { StaffInvitation, Shop } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from './audit.service.js';

const EXPIRY_DAYS = 7;

const generateToken = () => crypto.randomBytes(32).toString('hex');

function serializeInvitation(inv) {
  return {
    id: String(inv._id),
    token: inv.token,
    status: inv.status,
    shopId: inv.shopId ? String(inv.shopId) : null,
    usedByName: inv.usedBy?.name || null,
    usedAt: inv.usedAt,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
  };
}

export async function createInvitation(ctx, input = {}) {
  let shopId = input.shopId || null;
  if (shopId) {
    const shop = await Shop.findOne({ _id: shopId, businessId: ctx.businessId });
    if (!shop) throw ApiError.badRequest('Choose a valid shop.');
  }
  const invite = await StaffInvitation.create({
    businessId: ctx.businessId,
    shopId,
    token: generateToken(),
    status: 'PENDING',
    createdBy: ctx.userId,
    expiresAt: new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000),
  });
  await logAudit(ctx, { category: 'staff', action: 'staff.invitation_generated', summary: 'generated a staff sign-up link', entityType: 'StaffInvitation', entityId: invite._id });
  return serializeInvitation(invite);
}

/** Lazily flips stale PENDING invitations to EXPIRED before listing, since nothing else sweeps them. */
export async function listInvitations(ctx) {
  await StaffInvitation.updateMany({ businessId: ctx.businessId, status: 'PENDING', expiresAt: { $lte: new Date() } }, { $set: { status: 'EXPIRED' } });
  const invites = await StaffInvitation.find({ businessId: ctx.businessId }).sort({ createdAt: -1 }).limit(200).populate('usedBy', 'name').lean();
  return invites.map(serializeInvitation);
}

export async function revokeInvitation(ctx, id) {
  const invite = await StaffInvitation.findOneAndUpdate({ _id: id, businessId: ctx.businessId, status: 'PENDING' }, { $set: { status: 'REVOKED' } }, { new: true });
  if (!invite) throw ApiError.badRequest('This invitation can’t be revoked.');
  await logAudit(ctx, { category: 'staff', action: 'staff.invitation_revoked', summary: 'revoked a staff sign-up link', entityType: 'StaffInvitation', entityId: invite._id });
  return serializeInvitation(invite);
}

const STATUS_MESSAGE = {
  USED: 'This sign-up link has already been used. Ask your admin for a new one.',
  EXPIRED: 'This sign-up link has expired. Ask your admin for a new one.',
  REVOKED: 'This sign-up link is no longer valid. Ask your admin for a new one.',
};

export async function getPublicInvitation(token) {
  const invite = await StaffInvitation.findOne({ token }).populate('businessId', 'name').lean();
  if (!invite) throw ApiError.notFound('That sign-up link isn’t valid. Ask your admin for a new one.');
  if (invite.status === 'PENDING' && invite.expiresAt <= new Date()) {
    await StaffInvitation.updateOne({ _id: invite._id }, { $set: { status: 'EXPIRED' } });
    invite.status = 'EXPIRED';
  }
  if (invite.status !== 'PENDING') throw ApiError.conflict(STATUS_MESSAGE[invite.status] || 'This sign-up link is no longer valid.');
  const shops = await Shop.find({ businessId: invite.businessId._id, isActive: true }, 'name address').sort({ createdAt: 1 }).lean();
  return {
    businessName: invite.businessId.name,
    shopId: invite.shopId ? String(invite.shopId) : null,
    shops: shops.map((s) => ({ id: String(s._id), name: s.name, address: s.address })),
  };
}

/** Atomically claims a PENDING invitation via a single guarded update, so it can never be redeemed twice. */
export async function claimInvitation(token) {
  const invite = await StaffInvitation.findOneAndUpdate(
    { token, status: 'PENDING', expiresAt: { $gt: new Date() } },
    { $set: { status: 'USED', usedAt: new Date() } },
    { new: true }
  );
  if (invite) return invite;

  const existing = await StaffInvitation.findOne({ token });
  if (!existing) throw ApiError.notFound('That sign-up link isn’t valid. Ask your admin for a new one.');
  if (existing.status === 'PENDING' && existing.expiresAt <= new Date()) {
    await StaffInvitation.updateOne({ _id: existing._id }, { $set: { status: 'EXPIRED' } });
    throw ApiError.conflict(STATUS_MESSAGE.EXPIRED);
  }
  throw ApiError.conflict(STATUS_MESSAGE[existing.status] || 'This sign-up link is no longer valid.');
}

/** Releases a claimed invitation back to PENDING — used only if account creation fails right after the claim. */
export async function releaseInvitation(id) {
  await StaffInvitation.updateOne({ _id: id, status: 'USED', usedBy: null }, { $set: { status: 'PENDING' }, $unset: { usedAt: 1 } });
}

export async function markInvitationUsedBy(id, userId) {
  await StaffInvitation.updateOne({ _id: id }, { $set: { usedBy: userId } });
}
