/**
 * Controllers stay thin: read the request, call a service, send the response.
 * sendScoped removes cost/profit fields for roles without cost:read.
 */
import { can, P } from '../config/roles.js';
import { sendScoped } from '../utils/serialize.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import * as business from '../services/business.service.js';
import * as products from '../services/product.service.js';
import * as inventory from '../services/inventory.service.js';
import * as purchases from '../services/purchase.service.js';
import * as sales from '../services/sale.service.js';
import * as returns from '../services/return.service.js';
import * as customers from '../services/customer.service.js';
import * as suppliers from '../services/supplier.service.js';
import * as staff from '../services/staff.service.js';
import * as reports from '../services/report.service.js';
import * as audit from '../services/audit.service.js';

/* ---------- business & shops ---------- */
export const businessCtrl = {
  get: async (req, res) => res.json(await business.getBusiness(req.ctx)),
  update: async (req, res) => res.json(await business.updateBusiness(req.ctx, req.body)),
  listShops: async (req, res) => res.json(await business.listShops(req.ctx)),
  createShop: async (req, res) => res.status(201).json(await business.createShop(req.ctx, req.body)),
  updateShop: async (req, res) => res.json(await business.updateShop(req.ctx, req.params.id, req.body)),
  public: async (req, res) => res.json(await business.getPublicBusiness(req.params.businessId)),
};

/* ---------- products ---------- */
export const productCtrl = {
  list: async (req, res) => sendScoped(req, res, await products.listProducts(req.ctx, req.query)),
  categories: async (req, res) => res.json(await products.listCategories(req.ctx)),
  get: async (req, res) =>
    sendScoped(req, res, await products.getProduct(req.ctx, req.params.id, { withHistory: can(req.user, P.INVENTORY_HISTORY) })),
  create: async (req, res) => res.status(201).json(await products.createProduct(req.ctx, req.body)),
  update: async (req, res) => res.json(await products.updateProduct(req.ctx, req.params.id, req.body)),
  archive: async (req, res) => res.json(await products.setProductStatus(req.ctx, req.params.id, 'ARCHIVED')),
  restore: async (req, res) => res.json(await products.setProductStatus(req.ctx, req.params.id, 'ACTIVE')),
  upload: async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Choose an image to upload.');
    res.status(201).json({ url: `${env.publicUrl}/uploads/${req.file.filename}` });
  },
};

/* ---------- inventory ---------- */
export const inventoryCtrl = {
  list: async (req, res) => sendScoped(req, res, await inventory.listInventory(req.ctx, req.query)),
  get: async (req, res) =>
    sendScoped(req, res, await inventory.getInventoryDetail(req.ctx, req.params.id, { withHistory: can(req.user, P.INVENTORY_HISTORY) })),
  movements: async (req, res) => res.json(await inventory.listMovements(req.ctx, req.query)),
  adjustments: async (req, res) => res.json(await inventory.listAdjustments(req.ctx, req.query)),
  adjust: async (req, res) => res.status(201).json(await inventory.createAdjustment(req.ctx, req.body)),
  restock: async (req, res) => res.status(201).json(await purchases.createPurchase(req.ctx, req.body)),
};

export const purchaseCtrl = {
  list: async (req, res) => res.json(await purchases.listPurchases(req.ctx, req.query)),
  create: async (req, res) => res.status(201).json(await purchases.createPurchase(req.ctx, req.body)),
};

/* ---------- sales, returns, refunds ---------- */
export const saleCtrl = {
  create: async (req, res) => {
    const { id } = await sales.createSale(req.ctx, req.body);
    sendScoped(req, res, await sales.getSale(req.ctx, id), 201);
  },
  list: async (req, res) => sendScoped(req, res, await sales.listSales(req.ctx, req.query)),
  get: async (req, res) => sendScoped(req, res, await sales.getSale(req.ctx, req.params.id)),
  sync: async (req, res) => res.json(await sales.syncSales(req.ctx, req.body)),
  return: async (req, res) => res.status(201).json(await returns.processReturn(req.ctx, req.params.id, req.body)),
  refund: async (req, res) => res.status(201).json(await returns.processRefund(req.ctx, req.params.id, req.body)),
  void: async (req, res) => res.json(await returns.voidSale(req.ctx, req.params.id, req.body)),
  listReturns: async (req, res) => res.json(await returns.listReturns(req.ctx, req.query)),
  listRefunds: async (req, res) => res.json(await returns.listRefunds(req.ctx, req.query)),
};

/* ---------- customers & credit ---------- */
export const customerCtrl = {
  list: async (req, res) => {
    const rows = await customers.listCustomers(req.ctx, req.query);
    // Staff only need enough to pick a customer for a credit sale
    if (!can(req.user, P.CREDIT_MANAGE)) {
      return res.json(rows.map(({ id, name, phone, businessName }) => ({ id, name, phone, businessName })));
    }
    res.json(rows);
  },
  create: async (req, res) => res.status(201).json(await customers.createCustomer(req.ctx, req.body)),
  get: async (req, res) => res.json(await customers.getCustomer(req.ctx, req.params.id)),
  update: async (req, res) => res.json(await customers.updateCustomer(req.ctx, req.params.id, req.body)),
  summary: async (req, res) => res.json(await customers.creditSummary(req.ctx)),
  recordPayment: async (req, res) => res.status(201).json(await customers.recordCreditPayment(req.ctx, req.body)),
};

/* ---------- suppliers ---------- */
export const supplierCtrl = {
  list: async (req, res) => res.json(await suppliers.listSuppliers(req.ctx, req.query)),
  get: async (req, res) => res.json(await suppliers.getSupplier(req.ctx, req.params.id)),
  create: async (req, res) => res.status(201).json(await suppliers.createSupplier(req.ctx, req.body)),
  update: async (req, res) => res.json(await suppliers.updateSupplier(req.ctx, req.params.id, req.body)),
};

/* ---------- staff ---------- */
export const staffCtrl = {
  list: async (req, res) => res.json(await staff.listStaff(req.ctx)),
  get: async (req, res) => res.json(await staff.getStaff(req.ctx, req.params.id)),
  create: async (req, res) => res.status(201).json(await staff.createStaff(req.ctx, req.body)),
  update: async (req, res) => res.json(await staff.updateStaff(req.ctx, req.params.id, req.body)),
  deactivate: async (req, res) => res.json(await staff.setStaffStatus(req.ctx, req.params.id, 'INACTIVE')),
  activate: async (req, res) => res.json(await staff.setStaffStatus(req.ctx, req.params.id, 'ACTIVE')),
  resetPassword: async (req, res) => res.json(await staff.resetStaffPassword(req.ctx, req.params.id, req.body.password)),
};

/* ---------- reports & audit ---------- */
export const reportCtrl = {
  dashboard: async (req, res) => res.json(await reports.dashboard(req.ctx, req.query)),
  summary: async (req, res) => res.json(await reports.summary(req.ctx, req.query)),
  stockMovements: async (req, res) => res.json(await reports.stockMovementsReport(req.ctx, req.query)),
  me: async (req, res) => res.json(await reports.myStats(req.ctx)),
};

export const auditCtrl = {
  list: async (req, res) => res.json(await audit.listAudit(req.ctx, req.query)),
};
