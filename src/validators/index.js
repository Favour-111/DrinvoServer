import { z } from 'zod';
import { objectId, money, positiveInt, unit, text, optionalText, phone, listQuery } from './common.js';
import { ADJUSTMENT_TYPES, PAYMENT_METHODS, REFUND_METHODS } from '../config/constants.js';
import { ROLES } from '../config/roles.js';

export * from './common.js';

/* ---------- auth & users ---------- */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password').max(200),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string().min(8, 'Use at least 8 characters').max(200),
});
export const updateMeSchema = z.object({
  name: text(120).min(2).optional(),
  phone: text(40).optional(),
});
export const inviteTokenParam = z.object({ token: z.string().trim().min(10).max(128) });
export const staffSignupSchema = z.object({
  token: z.string().trim().min(10).max(128),
  name: text(120).min(2, 'Enter your name'),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  phone: optionalText(40),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  shopId: objectId.optional(),
});
export const invitationCreateSchema = z.object({ shopId: objectId.optional() });

/* ---------- business & shops ---------- */
export const businessUpdateSchema = z.object({
  name: text(120).min(2).optional(),
  receiptPrefix: text(10).min(1).optional(),
  receiptFooter: text(200).optional(),
  showStaffOnReceipt: z.boolean().optional(),
  timezone: text(60).optional(),
  categories: z.array(text(60).min(1)).max(50).optional(),
  staffAccess: z
    .object({
      shutdown: z.boolean().optional(),
      scheduleEnabled: z.boolean().optional(),
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').optional(),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').optional(),
      days: z.array(z.boolean()).length(7).optional(),
    })
    .optional(),
});
export const shopSchema = z.object({
  name: text(120).min(2, 'Enter a shop name'),
  address: optionalText(240),
  phone: optionalText(40),
});

/* ---------- products ---------- */
const imageUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => !v || /^https?:\/\/\S+$/i.test(v), 'Use an image link that starts with http:// or https://')
  .optional()
  .default('');
const conversionSchema = z.object({
  pack: z.coerce.number().int().min(0).max(1000).default(0),
  carton: z.coerce.number().int().min(0).max(1000).default(0),
  crate: z.coerce.number().int().min(0).max(1000).default(0),
});
const unitPriceSchema = z.object({
  pack: money.default(0),
  carton: money.default(0),
  crate: money.default(0),
});
const variantInput = z
  .object({
    id: objectId.optional(),
    size: text(40).min(1, 'Enter a size, e.g. 50cl'),
    costPrice: money.refine((n) => n > 0, 'Enter a cost price'),
    sellingPrice: money.refine((n) => n > 0, 'Enter a selling price'),
    unitConversions: conversionSchema.default({}),
    unitPrices: unitPriceSchema.default({}),
    lowStockThreshold: z.coerce.number().int().min(0).default(0),
    image: imageUrl,
    openingStock: z.object({ quantity: z.coerce.number().int().min(0).max(1_000_000), unit }).optional(),
  })
  .superRefine((v, ctx) => {
    for (const u of ['pack', 'carton', 'crate']) {
      if (v.unitConversions[u] === 1) ctx.addIssue({ code: 'custom', path: ['unitConversions', u], message: `A ${u} must hold more than 1 bottle` });
    }
    if (v.openingStock && v.openingStock.unit !== 'bottle' && !v.unitConversions[v.openingStock.unit]) {
      ctx.addIssue({ code: 'custom', path: ['openingStock', 'unit'], message: `Turn on ${v.openingStock.unit}s first` });
    }
  });

export const productCreateSchema = z.object({
  name: text(120).min(1, 'Enter a product name'),
  brand: optionalText(120),
  category: text(60).min(1, 'Choose a category'),
  description: optionalText(1000),
  image: imageUrl,
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  shape: z.enum(['bottle', 'can', 'box']).optional(),
  supplierId: objectId.nullable().optional().or(z.literal('').transform(() => null)),
  variants: z.array(variantInput).min(1, 'Add at least one size').max(20),
});
export const productUpdateSchema = productCreateSchema.partial().extend({
  variants: z.array(variantInput).min(1).max(20).optional(),
});
export const productListQuery = listQuery.extend({
  category: z.string().trim().max(60).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  stock: z.enum(['in', 'low', 'out']).optional(),
});

/* ---------- inventory ---------- */
export const restockSchema = z.object({
  supplierId: objectId,
  notes: optionalText(1000),
  items: z
    .array(z.object({ variantId: objectId, unit, quantity: positiveInt, costPerUnit: money.refine((n) => n > 0, 'Enter the cost') }))
    .min(1, 'Add at least one product')
    .max(100),
});
export const adjustmentSchema = z.object({
  variantId: objectId,
  type: z.enum(Object.keys(ADJUSTMENT_TYPES)),
  direction: z.enum(['add', 'remove']).default('remove'),
  quantity: positiveInt,
  unit,
  notes: text(500).min(3, 'Explain what happened'),
});
export const movementQuery = listQuery.extend({
  variantId: objectId.optional(),
  type: z.string().max(40).optional(),
});

/* ---------- sales ---------- */
const saleShape = {
  items: z.array(z.object({ variantId: objectId, unit, quantity: positiveInt, price: money.optional() })).min(1, 'Add at least one product').max(100),
  paymentMethod: z.enum(PAYMENT_METHODS),
  customerId: objectId.optional(),
  customer: z.object({ name: text(120).min(2, 'Enter the customer name'), phone }).optional(),
  amountPaid: money.optional(),
  paidWith: z.enum(['CASH', 'POS', 'TRANSFER']).optional(),
};
function requireCustomerAndPart(v, ctx) {
  if (v.paymentMethod === 'PART') {
    if (!(v.amountPaid > 0)) ctx.addIssue({ code: 'custom', path: ['amountPaid'], message: 'Enter how much the customer is paying now' });
    if (!v.paidWith) ctx.addIssue({ code: 'custom', path: ['paidWith'], message: 'Choose how they are paying now' });
  }
  if (!v.customerId && !v.customer) {
    ctx.addIssue({ code: 'custom', path: ['customer'], message: 'Enter the customer’s name and phone number' });
  }
}
export const saleCreateSchema = z.object(saleShape).superRefine(requireCustomerAndPart);
// Offline-first sync: each queued local sale carries the id the client generated for it, so a
// retried batch can never create the same sale twice (see Sale.clientTransactionId).
export const syncSalesSchema = z.object({
  sales: z
    .array(z.object({ ...saleShape, clientTransactionId: z.string().min(1).max(100) }).superRefine(requireCustomerAndPart))
    .min(1, 'Nothing to sync')
    .max(50, 'Sync in smaller batches'),
});
export const saleListQuery = listQuery.extend({
  range: z.enum(['today', 'yesterday', '7d', '30d', 'month', 'custom', 'all']).default('all'),
  from: z.string().optional(),
  to: z.string().optional(),
  staffId: objectId.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  status: z.string().max(30).optional(),
  customerId: objectId.optional(),
});
export const returnSchema = z.object({
  items: z.array(z.object({ saleItemId: objectId, quantity: positiveInt })).min(1, 'Choose at least one item to return'),
  reason: text(300).min(2, 'Give a reason'),
  restock: z.boolean().default(true),
  refundMethod: z.enum(REFUND_METHODS),
});
export const refundSchema = z.object({
  amount: money.refine((n) => n > 0, 'Enter an amount'),
  method: z.enum(['CASH', 'POS', 'TRANSFER']),
  reason: text(300).min(2, 'Give a reason'),
});
export const voidSchema = z.object({ reason: text(300).min(2, 'Give a reason') });

/* ---------- suppliers ---------- */
export const supplierSchema = z.object({
  name: text(160).min(2, 'Enter a supplier name'),
  contactName: optionalText(120),
  phone: phone,
  email: z.string().trim().email('Enter a valid email').or(z.literal('')).optional().default(''),
  address: optionalText(240),
  notes: optionalText(1000),
});

/* ---------- customers & credit ---------- */
export const customerSchema = z.object({
  name: text(120).min(2, 'Enter a name'),
  businessName: optionalText(120),
  phone,
  address: optionalText(240),
  notes: optionalText(1000),
});
export const creditPaymentSchema = z.object({
  customerId: objectId,
  amount: money.refine((n) => n > 0, 'Enter an amount'),
  method: z.enum(['CASH', 'POS', 'TRANSFER']),
  note: optionalText(300),
});

/* ---------- staff ---------- */
export const staffCreateSchema = z.object({
  name: text(120).min(2, 'Enter a name'),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  phone: optionalText(40),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  role: z.enum(ROLES).default('STAFF'),
  shopIds: z.array(objectId).optional(),
});
export const staffUpdateSchema = staffCreateSchema.omit({ password: true }).partial();
export const resetPasswordSchema = z.object({ password: z.string().min(8, 'Use at least 8 characters').max(200) });

/* ---------- audit ---------- */
export const auditQuery = listQuery.extend({ category: z.string().max(30).optional() });
