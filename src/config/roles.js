/**
 * Role-based access control.
 * Routes check permissions, never role names, so new roles (e.g. MANAGER,
 * CASHIER) can be added here without touching route code.
 */
export const P = {
  PRODUCT_READ: 'product:read',
  PRODUCT_WRITE: 'product:write',
  INVENTORY_READ: 'inventory:read',
  INVENTORY_WRITE: 'inventory:write',
  INVENTORY_HISTORY: 'inventory:history',
  COST_READ: 'cost:read',
  SALE_CREATE: 'sale:create',
  SALE_READ_OWN: 'sale:read:own',
  SALE_READ_ALL: 'sale:read:all',
  SALE_MANAGE: 'sale:manage',
  SUPPLIER_MANAGE: 'supplier:manage',
  CUSTOMER_LOOKUP: 'customer:lookup',
  CREDIT_MANAGE: 'credit:manage',
  STAFF_MANAGE: 'staff:manage',
  REPORT_READ: 'report:read',
  AUDIT_READ: 'audit:read',
  SETTINGS_MANAGE: 'settings:manage',
  SHOP_MANAGE: 'shop:manage',
};

export const ROLE_PERMISSIONS = {
  ADMIN: Object.values(P),
  STAFF: [
    P.PRODUCT_READ,
    P.INVENTORY_READ,
    P.SALE_CREATE,
    P.SALE_READ_OWN,
    P.CUSTOMER_LOOKUP,
  ],
};

export const ROLES = Object.keys(ROLE_PERMISSIONS);

export function can(user, permission) {
  return Boolean(user && ROLE_PERMISSIONS[user.role]?.includes(permission));
}

export function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}
