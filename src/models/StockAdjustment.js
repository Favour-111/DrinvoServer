import mongoose from 'mongoose';
import { Schema, baseOptions, ref } from './_base.js';
import { ADJUSTMENT_TYPES, UNITS } from '../config/constants.js';

const stockAdjustmentSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    adjustmentNumber: { type: String, required: true },
    productVariantId: ref('ProductVariant', true),
    type: { type: String, enum: Object.keys(ADJUSTMENT_TYPES), required: true },
    quantity: { type: Number, required: true }, // signed, in bottles
    unit: { type: String, enum: UNITS, required: true },
    unitQuantity: { type: Number, required: true, min: 1 },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    notes: { type: String, trim: true, maxlength: 500, required: true },
    performedBy: ref('User', true),
  },
  baseOptions()
);

export const StockAdjustment = mongoose.model('StockAdjustment', stockAdjustmentSchema);
