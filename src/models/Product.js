import mongoose from 'mongoose';
import { Schema, baseOptions, ref } from './_base.js';
import { PACKAGING_TYPES } from '../config/constants.js';

const productSchema = new Schema(
  {
    businessId: ref('Business', true),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    brand: { type: String, trim: true, maxlength: 120, default: '' },
    category: { type: String, trim: true, maxlength: 60, required: true },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    image: { type: String, default: '' },
    color: { type: String, default: '#059669' },
    shape: { type: String, enum: ['bottle', 'can', 'box'], default: 'bottle' },
    supplierId: ref('Supplier'),
    // Products created before this field existed read as STANDARD (see packagingOf in utils/units.js)
    packagingType: { type: String, enum: PACKAGING_TYPES, default: 'STANDARD' },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', index: true },
    archivedAt: Date,
  },
  baseOptions()
);

productSchema.index({ businessId: 1, name: 1 });
productSchema.virtual('variants', { ref: 'ProductVariant', localField: '_id', foreignField: 'productId' });

export const Product = mongoose.model('Product', productSchema);
