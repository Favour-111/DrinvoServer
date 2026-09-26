import mongoose from 'mongoose';
import { Schema, baseOptions, ref, ObjectId } from './_base.js';
import { MOVEMENT_TYPES } from '../config/constants.js';

/** Append-only history of every stock change. Never updated or deleted by the app. */
const movementSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    productVariantId: ref('ProductVariant', true),
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    quantity: { type: Number, required: true }, // signed, in bottles
    balanceAfter: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    referenceType: { type: String, enum: ['Sale', 'Purchase', 'Return', 'StockAdjustment', 'Product', null], default: null },
    referenceId: { type: ObjectId, default: null },
    referenceNumber: { type: String, default: '' },
    performedBy: ref('User', true),
    reason: { type: String, trim: true, maxlength: 500, default: '' },
  },
  baseOptions({ timestamps: { createdAt: true, updatedAt: false } })
);

movementSchema.index({ shopId: 1, productVariantId: 1, createdAt: -1 });

export const InventoryMovement = mongoose.model('InventoryMovement', movementSchema);
