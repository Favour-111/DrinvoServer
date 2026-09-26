import mongoose from 'mongoose';
import { Schema, baseOptions, ref, ObjectId } from './_base.js';

export const AUDIT_CATEGORIES = ['sale', 'inventory', 'product', 'staff', 'supplier', 'credit', 'settings', 'auth'];

/** Append-only record of who did what. */
const auditLogSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop'),
    userId: ref('User', true),
    category: { type: String, enum: AUDIT_CATEGORIES, required: true, index: true },
    action: { type: String, required: true }, // machine key, e.g. sale.completed
    summary: { type: String, required: true }, // "completed sale"
    target: { type: String, default: '' }, // "INV-000124"
    detail: { type: String, default: '' }, // "₦2,600 · POS"
    entityType: { type: String, default: '' },
    entityId: { type: ObjectId, default: null },
  },
  baseOptions({ timestamps: { createdAt: true, updatedAt: false } })
);
auditLogSchema.index({ businessId: 1, createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
