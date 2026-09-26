import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';
import { UNITS } from '../config/constants.js';

/** One line of a sale. Names, prices and cost are snapshots taken at sale time. */
const saleItemSchema = new Schema(
  {
    saleId: ref('Sale', true),
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    productId: ref('Product', true),
    productVariantId: ref('ProductVariant', true),
    productName: { type: String, required: true },
    variantName: { type: String, required: true },
    category: { type: String, default: '' },
    unit: { type: String, enum: UNITS, required: true },
    quantity: { type: Number, required: true, min: 1 },
    conversion: { type: Number, required: true, min: 1 },
    baseQuantity: { type: Number, required: true, min: 1 },
    // Catalog price at sale time; unitPrice is what was actually charged (may be discounted, never above listPrice).
    listPrice: { ...money },
    unitPrice: { ...money },
    lineTotal: { ...money },
    unitCost: { ...money }, // per bottle
    lineCost: { ...money },
    returnedQuantity: { type: Number, default: 0, min: 0 }, // in `unit`
    returnedBaseQuantity: { type: Number, default: 0, min: 0 },
    returnedAmount: { ...money },
    returnedCost: { ...money },
    voided: { type: Boolean, default: false },
  },
  baseOptions()
);

saleItemSchema.index({ shopId: 1, createdAt: -1 });

export const SaleItem = mongoose.model('SaleItem', saleItemSchema);
