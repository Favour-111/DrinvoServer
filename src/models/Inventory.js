import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';

/** Stock of one variant in one shop, always in base units (bottles). */
const inventorySchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    productVariantId: ref('ProductVariant', true),
    quantity: { type: Number, default: 0, min: 0 },
    // Weighted average cost per bottle for this shop
    avgCost: { ...money },
    // Per-shop override. null means use the variant's threshold.
    lowStockThreshold: { type: Number, default: null, min: 0 },
  },
  baseOptions()
);

inventorySchema.index({ shopId: 1, productVariantId: 1 }, { unique: true });
inventorySchema.virtual('inventoryValue').get(function inventoryValue() {
  return Math.round((this.quantity || 0) * (this.avgCost || 0) * 100) / 100;
});

export const Inventory = mongoose.model('Inventory', inventorySchema);
