import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';
import { CREDIT_PAYMENT_METHODS } from '../config/constants.js';

const customerSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    businessName: { type: String, trim: true, maxlength: 120, default: '' },
    phone: { type: String, trim: true, maxlength: 40, required: true },
    address: { type: String, trim: true, maxlength: 240, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  baseOptions()
);
customerSchema.index({ shopId: 1, phone: 1 }, { unique: true });

/** Running credit totals for one customer at one shop. */
const creditAccountSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    customerId: ref('Customer', true),
    totalCredit: { ...money },
    totalPaid: { ...money }, // payments plus credit from returns
    lastTransactionAt: Date,
  },
  baseOptions()
);
creditAccountSchema.index({ shopId: 1, customerId: 1 }, { unique: true });
creditAccountSchema.virtual('balance').get(function balance() {
  return Math.max(0, this.totalCredit - this.totalPaid);
});

const creditPaymentSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    creditAccountId: ref('CreditAccount', true),
    customerId: ref('Customer', true),
    amount: { ...money, required: true },
    method: { type: String, enum: CREDIT_PAYMENT_METHODS, required: true },
    saleId: ref('Sale'),
    returnId: ref('Return'),
    note: { type: String, trim: true, maxlength: 300, default: '' },
    recordedBy: ref('User', true),
  },
  baseOptions()
);

export const Customer = mongoose.model('Customer', customerSchema);
export const CreditAccount = mongoose.model('CreditAccount', creditAccountSchema);
export const CreditPayment = mongoose.model('CreditPayment', creditPaymentSchema);
