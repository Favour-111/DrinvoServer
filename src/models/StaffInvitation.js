import mongoose from 'mongoose';
import { Schema, baseOptions, ref } from './_base.js';

export const INVITATION_STATUSES = ['PENDING', 'USED', 'EXPIRED', 'REVOKED'];

const staffInvitationSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop'),
    token: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: INVITATION_STATUSES, default: 'PENDING', index: true },
    createdBy: ref('User', true),
    usedBy: ref('User'),
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  baseOptions()
);
staffInvitationSchema.index({ businessId: 1, createdAt: -1 });

export const StaffInvitation = mongoose.model('StaffInvitation', staffInvitationSchema);
