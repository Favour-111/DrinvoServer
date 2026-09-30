import mongoose from 'mongoose';
import { Schema } from './_base.js';

/** Atomic counters for receipt, purchase, return and adjustment numbers. */
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });
export const Counter = mongoose.model('Counter', counterSchema);

export { Business } from './Business.js';
export { Shop } from './Shop.js';
export { User } from './User.js';
export { Product } from './Product.js';
export { ProductVariant } from './ProductVariant.js';
export { Inventory } from './Inventory.js';
export { InventoryMovement } from './InventoryMovement.js';
export { Sale } from './Sale.js';
export { SaleItem } from './SaleItem.js';
export { Payment } from './Payment.js';
export { Supplier } from './Supplier.js';
export { Purchase, PurchaseItem } from './Purchase.js';
export { Customer, CreditAccount, CreditPayment } from './Customer.js';
export { Return, ReturnItem, Refund } from './Return.js';
export { StockAdjustment } from './StockAdjustment.js';
export { AuditLog } from './AuditLog.js';
export { StaffInvitation } from './StaffInvitation.js';
