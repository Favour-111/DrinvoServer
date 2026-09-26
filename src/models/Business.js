import mongoose from 'mongoose';
import { Schema, baseOptions } from './_base.js';
import { DEFAULT_CATEGORIES } from '../config/constants.js';

const businessSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    currency: { type: String, default: 'NGN' },
    timezone: { type: String, default: 'Africa/Lagos' },
    receiptPrefix: { type: String, default: 'INV-', maxlength: 10 },
    receiptFooter: { type: String, default: 'Thank you for your purchase!', maxlength: 200 },
    showStaffOnReceipt: { type: Boolean, default: true },
    categories: { type: [String], default: DEFAULT_CATEGORIES },
  },
  baseOptions()
);

export const Business = mongoose.model('Business', businessSchema);
