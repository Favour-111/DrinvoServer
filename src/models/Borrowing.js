import mongoose from 'mongoose';
import { Schema, baseOptions, ref } from './_base.js';
import { UNITS } from '../config/constants.js';

/** One physically-counted unit, e.g. "4 cartons" — mirrors StockCount's shape so borrowed/returned
 * quantities can combine several units (4 cartons + 5 bottles) exactly like the rest of the app. */
const countedUnitSchema = new Schema(
  {
    unit: { type: String, enum: UNITS, required: true },
    quantity: { type: Number, required: true, min: 0 },
    conversion: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const borrowItemSchema = new Schema(
  {
    productVariantId: ref('ProductVariant', true),
    name: { type: String, required: true }, // denormalized display name at borrow time
    countedUnits: { type: [countedUnitSchema], required: true },
    baseQuantity: { type: Number, required: true, min: 1 }, // bottles borrowed
    returnedBaseQuantity: { type: Number, default: 0, min: 0 }, // bottles returned so far
  },
  { _id: false }
);

/** One return event against a borrowing record — several of these can happen over time for a
 * partial return, each moving stock and getting its own audit entry. */
const borrowReturnSchema = new Schema(
  {
    date: { type: Date, default: Date.now },
    by: ref('User', true),
    items: {
      type: [
        new Schema(
          { productVariantId: ref('ProductVariant', true), name: String, countedUnits: [countedUnitSchema], baseQuantity: Number },
          { _id: false }
        ),
      ],
      required: true,
    },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { _id: false }
);

const borrowingSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopId: ref('Shop', true), // which of our own shops this is recorded against
    borrowNumber: { type: String, required: true },
    // LENT: another shop/person borrowed from us (our stock goes out). BORROWED: we borrowed from
    // them (our stock comes in). The counterparty is never one of our own registered shops — it's
    // free text, same as how Supplier/Customer names work, since the other side isn't in our system.
    direction: { type: String, enum: ['LENT', 'BORROWED'], required: true },
    counterpartyName: { type: String, required: true, trim: true, maxlength: 160 },
    counterpartyPhone: { type: String, trim: true, maxlength: 40, default: '' },
    items: { type: [borrowItemSchema], required: true },
    expectedReturnDate: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    status: { type: String, enum: ['OUTSTANDING', 'PARTIALLY_RETURNED', 'RETURNED'], default: 'OUTSTANDING' },
    createdBy: ref('User', true),
    returns: { type: [borrowReturnSchema], default: [] },
  },
  baseOptions()
);
borrowingSchema.index({ businessId: 1, borrowNumber: 1 }, { unique: true });
borrowingSchema.index({ businessId: 1, shopId: 1, createdAt: -1 });
borrowingSchema.index({ businessId: 1, status: 1 });

export const Borrowing = mongoose.model('Borrowing', borrowingSchema);
