import mongoose from 'mongoose';
import { Schema, baseOptions, ref, money } from './_base.js';

/**
 * A record of money the business took in or gave back.
 * Drinvo never processes payments; this only records how the customer paid.
 */
const paymentSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true),
    kind: { type: String, enum: ['SALE', 'CREDIT_PAYMENT', 'REFUND'], required: true },
    direction: { type: String, enum: ['IN', 'OUT'], required: true },
    method: { type: String, enum: ['CASH', 'POS', 'TRANSFER', 'CREDIT'], required: true },
    amount: { ...money, required: true },
    saleId: ref('Sale'),
    refundId: ref('Refund'),
    creditPaymentId: ref('CreditPayment'),
    customerId: ref('Customer'),
    recordedBy: ref('User', true),
  },
  baseOptions()
);

export const Payment = mongoose.model('Payment', paymentSchema);
