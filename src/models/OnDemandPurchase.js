import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';
import { UNITS } from '../config/constants.js';

const saleLinkSchema = new Schema(
  {
    saleId: ref('Sale', true),
    receiptNumber: { type: String, default: '' },
    baseQuantity: { type: Number, required: true, min: 1 },
    date: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * A one-off purchase from outside the business (not one of our own shops — that's a Stock
 * Transfer) made specifically to fulfil a customer request for a product this shop doesn't
 * normally carry. Distinct from a Sale (this is a purchase, not revenue), a Borrowing (this is
 * a real buy, not a loan) and a Stock Transfer (the other side is a third party, not our shop).
 * Stock only moves once `status` reaches PURCHASED — recording it while still PENDING is just a
 * note that a customer asked for something, with nothing spent or stocked yet.
 */
const onDemandPurchaseSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    odpNumber: { type: String, required: true },
    productVariantId: ref('ProductVariant', true),
    name: { type: String, required: true, trim: true, maxlength: 160 },
    unit: { type: String, enum: UNITS, default: 'bottle' },
    requestedQuantity: { type: Number, default: 0, min: 0 },
    // Actually bought — set when status moves to PURCHASED; 0 while still PENDING.
    quantity: { type: Number, default: 0, min: 0 },
    conversion: { type: Number, default: 1, min: 1 },
    baseQuantity: { type: Number, default: 0, min: 0 },
    remainingBaseQuantity: { type: Number, default: 0, min: 0 },
    purchasedFrom: { type: String, required: true, trim: true, maxlength: 160 },
    purchasedFromPhone: { type: String, trim: true, maxlength: 40, default: '' },
    unitCost: { ...money },
    totalCost: { ...money },
    sellingPricePerUnit: { ...money },
    customerName: { type: String, trim: true, maxlength: 160, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    status: { type: String, enum: ['PENDING', 'PURCHASED', 'PARTIALLY_SOLD', 'SOLD', 'CANCELLED'], default: 'PENDING' },
    createdBy: ref('User', true),
    purchasedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, maxlength: 500, default: '' },
    saleLinks: { type: [saleLinkSchema], default: [] },
  },
  baseOptions()
);

onDemandPurchaseSchema.index({ businessId: 1, odpNumber: 1 }, { unique: true });
onDemandPurchaseSchema.index({ shopId: 1, createdAt: -1 });
onDemandPurchaseSchema.index({ shopId: 1, productVariantId: 1, status: 1 });

export const OnDemandPurchase = mongoose.model('OnDemandPurchase', onDemandPurchaseSchema);
