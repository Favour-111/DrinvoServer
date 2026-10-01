import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';

const conversionSchema = new Schema(
  {
    bottle: { type: Number, default: 1, min: 1, max: 1 },
    pack: { type: Number, default: 0, min: 0 },
    carton: { type: Number, default: 0, min: 0 },
    crate: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// Optional selling price per larger unit. 0 means "bottle price x conversion".
const unitPriceSchema = new Schema(
  {
    pack: { ...money },
    carton: { ...money },
    crate: { ...money },
  },
  { _id: false }
);

const variantSchema = new Schema(
  {
    businessId: ref('Business', true),
    productId: ref('Product', true),
    name: { type: String, required: true, trim: true, maxlength: 160 },
    size: { type: String, required: true, trim: true, maxlength: 40 },
    unit: { type: String, default: 'bottle' },
    // Reference cost per bottle. Actual sale cost uses the shop's weighted average (Inventory.avgCost).
    costPrice: { ...money, required: true },
    sellingPrice: { ...money, required: true },
    // Lowest price staff may sell at after a discount. 0 (the default, incl. for products created
    // before this field existed) means no floor is enforced.
    minimumSellingPrice: { ...money, default: 0 },
    unitConversions: { type: conversionSchema, default: () => ({}) },
    unitPrices: { type: unitPriceSchema, default: () => ({}) },
    image: { type: String, default: '' },
    lowStockThreshold: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  },
  baseOptions()
);

variantSchema.index({ productId: 1, size: 1 });

export const ProductVariant = mongoose.model('ProductVariant', variantSchema);
