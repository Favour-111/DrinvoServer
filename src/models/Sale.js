import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';
import { PAYMENT_METHODS, SALE_STATUS } from '../config/constants.js';

const saleSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    receiptNumber: { type: String, required: true },
    // Set by offline-first clients so a retried sync can never create a duplicate sale. Left
    // truly absent (not null) on every other sale, so the sparse index below only applies here —
    // Mongo's "sparse" only skips documents missing the field, not ones storing an explicit null.
    clientTransactionId: { type: String },
    staffId: ref('User', true),
    customerId: ref('Customer'),
    itemCount: { type: Number, default: 0 },
    total: { ...money },
    // Cost recorded at the moment of sale; never recalculated from today's prices
    totalCost: { ...money },
    // Sum of (listPrice - unitPrice) * quantity across items: how much was knocked off the catalog price
    totalDiscount: { ...money, default: 0 },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    // Money taken at the till. Equals total for Cash/POS/Transfer, 0 for Credit, part of total for PART.
    amountPaid: { ...money },
    paidWith: { type: String, enum: ['CASH', 'POS', 'TRANSFER', null], default: null },
    status: { type: String, enum: SALE_STATUS, default: 'COMPLETED', index: true },
    returnedAmount: { ...money },
    returnedCost: { ...money },
    refundedAmount: { ...money },
    voidReason: { type: String, default: '' },
    voidedBy: ref('User'),
    voidedAt: Date,
  },
  baseOptions()
);

saleSchema.index({ shopId: 1, receiptNumber: 1 }, { unique: true });
saleSchema.index({ shopId: 1, createdAt: -1 });
// Partial (not sparse — sparse on a compound index only skips a doc if EVERY indexed field is
// missing, and shopId never is): only indexes sales that actually carry a clientTransactionId.
saleSchema.index({ shopId: 1, clientTransactionId: 1 }, { unique: true, partialFilterExpression: { clientTransactionId: { $exists: true } } });

saleSchema.virtual('netTotal').get(function netTotal() {
  if (this.status === 'VOIDED') return 0;
  return this.total - this.returnedAmount - this.refundedAmount;
});
saleSchema.virtual('netCost').get(function netCost() {
  if (this.status === 'VOIDED') return 0;
  return this.totalCost - this.returnedCost;
});
saleSchema.virtual('profit').get(function profit() {
  return this.netTotal - this.netCost;
});
saleSchema.virtual('items', { ref: 'SaleItem', localField: '_id', foreignField: 'saleId' });

export const Sale = mongoose.model('Sale', saleSchema);
