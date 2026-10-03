import mongoose from 'mongoose';
import { Schema, baseOptions, ref } from './_base.js';
import { UNITS } from '../config/constants.js';

/** One physically-counted unit entered for a product, e.g. "4 cartons" — several of these
 * combine (via each unit's own conversion) into the line's total physical bottle count, so
 * staff can enter "4 cartons + 5 bottles" exactly as the stock actually sits on the shelf. */
const countedUnitSchema = new Schema(
  {
    unit: { type: String, enum: UNITS, required: true },
    quantity: { type: Number, required: true, min: 0 },
    conversion: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const stockCountItemSchema = new Schema(
  {
    productVariantId: ref('ProductVariant', true),
    name: { type: String, required: true }, // denormalized display name at count time
    countedUnits: { type: [countedUnitSchema], required: true },
    // Snapshots taken the moment this item was counted — frozen even if stock moves afterwards,
    // so the record always reflects what was actually compared at the time of the count.
    expectedQuantity: { type: Number, required: true, min: 0 }, // bottles
    physicalQuantity: { type: Number, required: true, min: 0 }, // bottles
    difference: { type: Number, required: true }, // physical - expected, signed
    type: { type: String, enum: ['MATCHED', 'SHORTAGE', 'OVERAGE'], required: true },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { _id: false }
);

const stockCountSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    countNumber: { type: String, required: true },
    items: { type: [stockCountItemSchema], required: true },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    // Flagging only: a count never changes inventory by itself. An admin reviews it and decides
    // whether any difference needs a (separately recorded) stock adjustment.
    status: { type: String, enum: ['SUBMITTED', 'REVIEWED'], default: 'SUBMITTED' },
    performedBy: ref('User', true),
    reviewedBy: ref('User'),
    reviewedAt: { type: Date, default: null },
  },
  baseOptions()
);
stockCountSchema.index({ businessId: 1, countNumber: 1 }, { unique: true });
stockCountSchema.index({ businessId: 1, shopId: 1, createdAt: -1 });
stockCountSchema.index({ businessId: 1, status: 1 });

export const StockCount = mongoose.model('StockCount', stockCountSchema);
