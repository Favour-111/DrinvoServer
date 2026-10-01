import { Business, Shop, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { invalidateAuthCache, signToken } from '../middleware/auth.js';
import { can, P, permissionsFor } from '../config/roles.js';
import { publicUser, pickStaffColor } from './staff.service.js';
import { logAudit } from './audit.service.js';
import { checkStaffAccess } from '../utils/staffAccess.js';
import * as invitations from './invitation.service.js';

async function session(user) {
  const [business, shops] = await Promise.all([
    Business.findById(user.businessId).lean(),
    Shop.find({
      businessId: user.businessId,
      isActive: true,
      // Anyone who can move stock between shops needs to see every shop, not just their own assignment.
      ...(user.role === 'ADMIN' || can(user, P.INVENTORY_TRANSFER) ? {} : { _id: { $in: user.shopIds } }),
    })
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  return {
    user: publicUser(user),
    permissions: permissionsFor(user.role),
    business: {
      id: String(business._id),
      name: business.name,
      currency: business.currency,
      timezone: business.timezone,
      receiptPrefix: business.receiptPrefix,
      receiptFooter: business.receiptFooter,
      showStaffOnReceipt: business.showStaffOnReceipt,
      showDiscountOnReceipt: business.showDiscountOnReceipt,
      categories: business.categories,
      staffAccess: business.staffAccess,
    },
    shops: shops.map((s) => ({ id: String(s._id), name: s.name, address: s.address, phone: s.phone })),
  };
}

export async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+password');
  // Same message for unknown email and wrong password
  if (!user || !(await user.comparePassword(password))) {
    if (user) {
      await logAudit(
        { businessId: user.businessId, shopId: null, userId: user._id },
        { category: 'auth', action: 'auth.login_failed', summary: 'failed sign-in attempt', target: user.email }
      );
    }
    throw ApiError.unauthorized('That email and password don’t match. Check them and try again.');
  }
  if (user.status === 'PENDING') throw ApiError.unauthorized('Your account is waiting on admin approval. We’ll get back to you soon.');
  if (user.status !== 'ACTIVE') throw ApiError.unauthorized('This account has been deactivated. Ask your admin to reactivate it.');

  if (user.role === 'STAFF') {
    const business = await Business.findById(user.businessId).lean();
    const gate = checkStaffAccess(business);
    if (!gate.allowed) {
      await logAudit(
        { businessId: user.businessId, shopId: null, userId: user._id },
        { category: 'auth', action: 'auth.login_blocked', summary: 'was blocked from signing in by staff access rules', target: user.email }
      );
      throw ApiError.unauthorized(gate.reason);
    }
  }

  user.lastActiveAt = new Date();
  await user.save();
  await logAudit({ businessId: user.businessId, shopId: null, userId: user._id }, { category: 'auth', action: 'auth.login', summary: 'signed in', target: user.email });
  return { token: signToken(user), ...(await session(user)) };
}

export async function logout(user) {
  await logAudit({ businessId: user.businessId, shopId: null, userId: user._id }, { category: 'auth', action: 'auth.logout', summary: 'signed out', target: user.email });
  return { ok: true };
}

/** Public self-signup for staff via a one-time invitation link: always STAFF role, always PENDING until an admin approves it. */
export async function signup({ token, name, email, phone, password, shopId }) {
  const invite = await invitations.claimInvitation(token);
  try {
    const business = await Business.findById(invite.businessId).lean();
    if (!business) throw ApiError.badRequest('That signup link isn’t valid. Ask your admin for a new one.');

    const shops = await Shop.find({ businessId: invite.businessId, isActive: true }).sort({ createdAt: 1 }).lean();
    if (!shops.length) throw ApiError.badRequest('This business has no shop set up yet. Ask your admin to add one first.');

    let shopIds;
    if (invite.shopId) {
      shopIds = [invite.shopId];
    } else if (shops.length === 1) {
      shopIds = [shops[0]._id];
    } else {
      const shop = shops.find((s) => String(s._id) === shopId);
      if (!shop) throw ApiError.badRequest('Choose a shop.', { fields: { shopId: 'Choose a shop' } });
      shopIds = [shop._id];
    }

    if (await User.exists({ email })) throw ApiError.conflict('An account with this email already exists.', { fields: { email: 'Already in use' } });

    const count = await User.countDocuments({ businessId: invite.businessId });
    const user = await User.create({ businessId: invite.businessId, name, email, phone, password, shopIds, role: 'STAFF', status: 'PENDING', color: pickStaffColor(count) });
    await invitations.markInvitationUsedBy(invite._id, user._id);
    await logAudit(
      { businessId: invite.businessId, shopId: shopIds[0], userId: user._id },
      { category: 'staff', action: 'staff.invitation_used', summary: 'used a sign-up link to request a staff account', target: user.name, entityType: 'User', entityId: user._id }
    );
    return { name: user.name };
  } catch (err) {
    await invitations.releaseInvitation(invite._id).catch(() => {});
    throw err;
  }
}

export const me = (user) => session(user);

export async function changePassword(user, { currentPassword, newPassword }) {
  const full = await User.findById(user._id).select('+password');
  if (!(await full.comparePassword(currentPassword))) {
    throw ApiError.badRequest('Your current password is incorrect.');
  }
  full.password = newPassword;
  await full.save();
  invalidateAuthCache(full._id);
  // Old tokens are rejected after a password change, so issue a fresh one
  return { token: signToken(full) };
}

export async function updateMe(user, input) {
  const updated = await User.findByIdAndUpdate(user._id, { $set: input }, { new: true, runValidators: true }).lean();
  invalidateAuthCache(user._id);
  return publicUser(updated);
}
