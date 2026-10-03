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
    // When false, the printed/shared customer receipt hides discount info; admin-side views (Sale
    // detail, reports) always show it regardless — this only controls what the customer sees.
    showDiscountOnReceipt: { type: Boolean, default: true },
    // Shown in the WhatsApp price-share flow as a reminder of which device/number to send from —
    // there's no API account wired up, so sending still happens via whatsapp.com/send on that device.
    whatsappNumber: { type: String, trim: true, maxlength: 30, default: '' },
    categories: { type: [String], default: DEFAULT_CATEGORIES },
    staffAccess: {
      shutdown: { type: Boolean, default: false },
      scheduleEnabled: { type: Boolean, default: false },
      start: { type: String, default: '09:00' },
      end: { type: String, default: '21:00' },
      days: { type: [Boolean], default: () => [true, true, true, true, true, true, true] },
    },
  },
  baseOptions()
);

export const Business = mongoose.model('Business', businessSchema);
