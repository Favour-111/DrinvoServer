import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';
import { UNITS } from '../config/constants.js';

const purchaseSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    supplierId: ref('Supplier', true),
    purchaseNumber: { type: String, required: true },
    itemCount: { type: Number, default: 0 },
    totalCost: { ...money },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    createdBy: ref('User', true),
  },
  baseOptions()
);
purchaseSchema.index({ shopId: 1, purchaseNumber: 1 }, { unique: true });
purchaseSchema.virtual('items', { ref: 'PurchaseItem', localField: '_id', foreignField: 'purchaseId' });

const purchaseItemSchema = new Schema(
  {
    purchaseId: ref('Purchase', true),
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    supplierId: ref('Supplier', true),
    productVariantId: ref('ProductVariant', true),
    unit: { type: String, enum: UNITS, required: true },
    quantity: { type: Number, required: true, min: 1 },
    conversion: { type: Number, required: true, min: 1 },
    baseQuantity: { type: Number, required: true, min: 1 },
    costPerUnit: { ...money },
    costPerBase: { ...money },
    lineTotal: { ...money },
  },
  baseOptions()
);

export const Purchase = mongoose.model('Purchase', purchaseSchema);
export const PurchaseItem = mongoose.model('PurchaseItem', purchaseItemSchema);
