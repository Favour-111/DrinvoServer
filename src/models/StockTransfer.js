import mongoose from 'mongoose';
import { Schema, baseOptions, ref } from './_base.js';
import { UNITS } from '../config/constants.js';

const transferItemSchema = new Schema(
  {
    productVariantId: ref('ProductVariant', true),
    name: { type: String, required: true }, // denormalized display name at transfer time
    unit: { type: String, enum: UNITS, required: true },
    quantity: { type: Number, required: true, min: 1 }, // in the selected display unit
    conversion: { type: Number, required: true, min: 1 },
    baseQuantity: { type: Number, required: true, min: 1 }, // in bottles
  },
  { _id: false }
);

const stockTransferSchema = new Schema(
  {
    businessId: ref('Business', true),
    fromShopId: ref('Shop', true),
    toShopId: ref('Shop', true),
    transferNumber: { type: String, required: true },
    items: { type: [transferItemSchema], required: true },
    status: { type: String, enum: ['PENDING', 'COMPLETED', 'CANCELLED'], default: 'COMPLETED' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    createdBy: ref('User', true),
    completedAt: { type: Date, default: null },
  },
  baseOptions()
);
stockTransferSchema.index({ businessId: 1, transferNumber: 1 }, { unique: true });
stockTransferSchema.index({ businessId: 1, createdAt: -1 });
stockTransferSchema.index({ businessId: 1, fromShopId: 1 });
stockTransferSchema.index({ businessId: 1, toShopId: 1 });

export const StockTransfer = mongoose.model('StockTransfer', stockTransferSchema);
