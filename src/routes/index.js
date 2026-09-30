import { Router } from 'express';
import { authenticate, shopContext, requirePermission as need } from '../middleware/auth.js';
import { stockBroadcast } from '../middleware/stockBroadcast.js';
import { validate } from '../middleware/validate.js';
import { loginLimiter, signupLimiter } from '../middleware/rateLimiters.js';
import { imageUpload } from '../middleware/upload.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { P } from '../config/roles.js';
import * as v from '../validators/index.js';
import * as authCtrl from '../controllers/auth.controller.js';
import {
  auditCtrl,
  businessCtrl,
  customerCtrl,
  inventoryCtrl,
  invitationCtrl,
  productCtrl,
  purchaseCtrl,
  reportCtrl,
  saleCtrl,
  staffCtrl,
  supplierCtrl,
} from '../controllers/index.js';

const api = Router();
const id = validate({ params: v.idParam });

/* ---------- auth (public login & staff signup) ---------- */
const auth = Router();
auth.post('/login', loginLimiter, validate({ body: v.loginSchema }), h(authCtrl.login));
auth.post('/signup', signupLimiter, validate({ body: v.staffSignupSchema }), h(authCtrl.signup));
auth.get('/me', authenticate, h(authCtrl.me));
auth.post('/logout', authenticate, h(authCtrl.logout));
auth.post('/change-password', authenticate, validate({ body: v.changePasswordSchema }), h(authCtrl.changePassword));
api.use('/auth', auth);

// Lets the signup page show the business name and shop(s) for a one-time invitation link, before anyone signs in
api.get('/invite/:token', validate({ params: v.inviteTokenParam }), h(invitationCtrl.public));

/* Everything below needs a signed-in user and a shop */
api.use(authenticate, shopContext, stockBroadcast);

/* ---------- users (self) ---------- */
api.get('/users/me', h(authCtrl.me));
api.patch('/users/me', validate({ body: v.updateMeSchema }), h(authCtrl.updateMe));

/* ---------- business & shops ---------- */
api.get('/businesses/current', h(businessCtrl.get));
api.patch('/businesses/current', need(P.SETTINGS_MANAGE), validate({ body: v.businessUpdateSchema }), h(businessCtrl.update));
api.get('/shops', h(businessCtrl.listShops));
api.post('/shops', need(P.SHOP_MANAGE), validate({ body: v.shopSchema }), h(businessCtrl.createShop));
api.patch('/shops/:id', need(P.SHOP_MANAGE), id, validate({ body: v.shopSchema.partial() }), h(businessCtrl.updateShop));

/* ---------- products ---------- */
api.get('/products', need(P.PRODUCT_READ), validate({ query: v.productListQuery }), h(productCtrl.list));
api.get('/products/categories', need(P.PRODUCT_READ), h(productCtrl.categories));
api.get('/products/:id', need(P.PRODUCT_READ), id, h(productCtrl.get));
api.post('/products', need(P.PRODUCT_WRITE), validate({ body: v.productCreateSchema }), h(productCtrl.create));
api.patch('/products/:id', need(P.PRODUCT_WRITE), id, validate({ body: v.productUpdateSchema }), h(productCtrl.update));
api.post('/products/:id/archive', need(P.PRODUCT_WRITE), id, h(productCtrl.archive));
api.post('/products/:id/restore', need(P.PRODUCT_WRITE), id, h(productCtrl.restore));
api.post('/uploads', need(P.PRODUCT_WRITE), imageUpload, h(productCtrl.upload));

/* ---------- inventory ---------- */
api.get('/inventory', need(P.INVENTORY_READ), h(inventoryCtrl.list));
api.get('/inventory/movements', need(P.INVENTORY_HISTORY), validate({ query: v.movementQuery }), h(inventoryCtrl.movements));
api.get('/inventory/adjustments', need(P.INVENTORY_HISTORY), validate({ query: v.listQuery }), h(inventoryCtrl.adjustments));
api.post('/inventory/adjustments', need(P.INVENTORY_WRITE), validate({ body: v.adjustmentSchema }), h(inventoryCtrl.adjust));
api.post('/inventory/restock', need(P.INVENTORY_WRITE), validate({ body: v.restockSchema }), h(inventoryCtrl.restock));
api.get('/inventory/:id', need(P.INVENTORY_READ), id, h(inventoryCtrl.get));

/* ---------- purchases ---------- */
api.get('/purchases', need(P.INVENTORY_HISTORY), validate({ query: v.listQuery.extend({ supplierId: v.objectId.optional() }) }), h(purchaseCtrl.list));
api.post('/purchases', need(P.INVENTORY_WRITE), validate({ body: v.restockSchema }), h(purchaseCtrl.create));

/* ---------- sales ---------- */
api.post('/sales', need(P.SALE_CREATE), validate({ body: v.saleCreateSchema }), h(saleCtrl.create));
// Offline-first staff client: syncs a batch of locally-queued sales at once (see docs/offline-sync).
api.post('/sync/sales', need(P.SALE_CREATE), validate({ body: v.syncSalesSchema }), h(saleCtrl.sync));
api.get('/sales', need(P.SALE_READ_OWN), validate({ query: v.saleListQuery }), h(saleCtrl.list));
api.get('/sales/:id', need(P.SALE_READ_OWN), id, h(saleCtrl.get));
api.post('/sales/:id/return', need(P.SALE_MANAGE), id, validate({ body: v.returnSchema }), h(saleCtrl.return));
api.post('/sales/:id/refund', need(P.SALE_MANAGE), id, validate({ body: v.refundSchema }), h(saleCtrl.refund));
api.post('/sales/:id/void', need(P.SALE_MANAGE), id, validate({ body: v.voidSchema }), h(saleCtrl.void));
api.get('/returns', need(P.SALE_MANAGE), validate({ query: v.listQuery }), h(saleCtrl.listReturns));
api.get('/refunds', need(P.SALE_MANAGE), validate({ query: v.listQuery }), h(saleCtrl.listRefunds));

/* ---------- suppliers ---------- */
api.get('/suppliers', need(P.SUPPLIER_MANAGE), validate({ query: v.listQuery }), h(supplierCtrl.list));
api.post('/suppliers', need(P.SUPPLIER_MANAGE), validate({ body: v.supplierSchema }), h(supplierCtrl.create));
api.get('/suppliers/:id', need(P.SUPPLIER_MANAGE), id, h(supplierCtrl.get));
api.patch('/suppliers/:id', need(P.SUPPLIER_MANAGE), id, validate({ body: v.supplierSchema.partial() }), h(supplierCtrl.update));

/* ---------- customers & credit ---------- */
api.get('/customers', need(P.CUSTOMER_LOOKUP), validate({ query: v.listQuery }), h(customerCtrl.list));
api.post('/customers', need(P.CREDIT_MANAGE), validate({ body: v.customerSchema }), h(customerCtrl.create));
api.get('/customers/:id', need(P.CREDIT_MANAGE), id, h(customerCtrl.get));
api.patch('/customers/:id', need(P.CREDIT_MANAGE), id, validate({ body: v.customerSchema.partial() }), h(customerCtrl.update));
api.get('/credit/summary', need(P.CREDIT_MANAGE), h(customerCtrl.summary));
api.post('/credit/payments', need(P.CREDIT_MANAGE), validate({ body: v.creditPaymentSchema }), h(customerCtrl.recordPayment));

/* ---------- staff ---------- */
api.get('/staff', need(P.STAFF_MANAGE), h(staffCtrl.list));
api.post('/staff', need(P.STAFF_MANAGE), validate({ body: v.staffCreateSchema }), h(staffCtrl.create));
// Must come before /staff/:id — otherwise Express matches "invitations" as an :id.
api.get('/staff/invitations', need(P.STAFF_MANAGE), h(invitationCtrl.list));
api.post('/staff/invitations', need(P.STAFF_MANAGE), validate({ body: v.invitationCreateSchema }), h(invitationCtrl.create));
api.post('/staff/invitations/:id/revoke', need(P.STAFF_MANAGE), id, h(invitationCtrl.revoke));
api.get('/staff/:id', need(P.STAFF_MANAGE), id, h(staffCtrl.get));
api.patch('/staff/:id', need(P.STAFF_MANAGE), id, validate({ body: v.staffUpdateSchema }), h(staffCtrl.update));
api.post('/staff/:id/deactivate', need(P.STAFF_MANAGE), id, h(staffCtrl.deactivate));
api.post('/staff/:id/activate', need(P.STAFF_MANAGE), id, h(staffCtrl.activate));
api.post('/staff/:id/reset-password', need(P.STAFF_MANAGE), id, validate({ body: v.resetPasswordSchema }), h(staffCtrl.resetPassword));

/* ---------- reports & audit ---------- */
api.get('/reports/dashboard', need(P.REPORT_READ), validate({ query: v.rangeQuery.partial() }), h(reportCtrl.dashboard));
api.get('/reports/summary', need(P.REPORT_READ), validate({ query: v.rangeQuery }), h(reportCtrl.summary));
api.get('/reports/stock-movements', need(P.REPORT_READ), validate({ query: v.rangeQuery }), h(reportCtrl.stockMovements));
api.get('/reports/me', need(P.SALE_CREATE), h(reportCtrl.me));
api.get('/audit', need(P.AUDIT_READ), validate({ query: v.auditQuery }), h(auditCtrl.list));

export default api;
