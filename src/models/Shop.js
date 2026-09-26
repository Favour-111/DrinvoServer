import mongoose from 'mongoose';
import { Schema, baseOptions, ref } from './_base.js';

const shopSchema = new Schema(
  {
    businessId: ref('Business', true),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, trim: true, maxlength: 240, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    isActive: { type: Boolean, default: true },
  },
  baseOptions()
);

export const Shop = mongoose.model('Shop', shopSchema);
