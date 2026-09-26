import mongoose from 'mongoose';
import { Schema, baseOptions, ref, ObjectId } from './_base.js';

const supplierSchema = new Schema(
  {
    businessId: ref('Business', true),
    // Empty means the supplier serves every shop in the business
    shopIds: [{ type: ObjectId, ref: 'Shop' }],
    name: { type: String, required: true, trim: true, maxlength: 160 },
    contactName: { type: String, trim: true, maxlength: 120, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
    address: { type: String, trim: true, maxlength: 240, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  },
  baseOptions()
);

export const Supplier = mongoose.model('Supplier', supplierSchema);
