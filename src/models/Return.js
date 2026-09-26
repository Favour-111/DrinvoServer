import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';
import { REFUND_METHODS } from '../config/constants.js';

/** Items brought back against an original sale. The sale itself is never deleted. */
const returnSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    saleId: ref('Sale', true),
    returnNumber: { type: String, required: true },
    totalAmount: { ...money },
    totalCost: { ...money }, // cost of items put back into stock
    restocked: { type: Boolean, default: true },
    reason: { type: String, trim: true, maxlength: 300, default: '' },
    refundMethod: { type: String, enum: REFUND_METHODS, required: true },
    processedBy: ref('User', true),
  },
  baseOptions()
);
returnSchema.virtual('items', { ref: 'ReturnItem', localField: '_id', foreignField: 'returnId' });

const returnItemSchema = new Schema(
  {
    returnId: ref('Return', true),
    saleItemId: ref('SaleItem', true),
    productVariantId: ref('ProductVariant', true),
    variantName: { type: String, default: '' },
    unit: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    baseQuantity: { type: Number, required: true, min: 1 },
    amount: { ...money },
    cost: { ...money },
  },
  baseOptions()
);

/** Money given back to a customer, with or without a return of goods. */
const refundSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    saleId: ref('Sale', true),
    returnId: ref('Return'),
    refundNumber: { type: String, required: true },
    amount: { ...money, required: true },
    method: { type: String, enum: REFUND_METHODS, required: true },
    reason: { type: String, trim: true, maxlength: 300, default: '' },
    processedBy: ref('User', true),
  },
  baseOptions()
);

export const Return = mongoose.model('Return', returnSchema);
export const ReturnItem = mongoose.model('ReturnItem', returnItemSchema);
export const Refund = mongoose.model('Refund', refundSchema);
