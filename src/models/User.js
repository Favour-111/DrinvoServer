import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Schema, baseOptions, ref, ObjectId } from './_base.js';
import { ROLES } from '../config/roles.js';

const userSchema = new Schema(
  {
    businessId: ref('Business', true),
    shopIds: [{ type: ObjectId, ref: 'Shop' }],
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 160 },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'STAFF' },
    // PENDING: self-registered via the staff signup link, awaiting admin approval.
    status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'PENDING'], default: 'ACTIVE' },
    color: { type: String, default: '#047857' },
    lastActiveAt: { type: Date },
    passwordChangedAt: { type: Date },
  },
  baseOptions()
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  if (!this.isNew) this.passwordChangedAt = new Date();
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model('User', userSchema);
