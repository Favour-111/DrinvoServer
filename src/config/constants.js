export const UNITS = ['bottle', 'pack', 'carton', 'crate'];
export const BASE_UNIT = 'bottle';

// PART = customer pays some now (paidWith) and owes the rest on credit
export const PAYMENT_METHODS = ['CASH', 'POS', 'TRANSFER', 'CREDIT', 'PART'];
export const ON_ACCOUNT_METHODS = ['CREDIT', 'PART'];
export const REFUND_METHODS = ['CASH', 'POS', 'TRANSFER', 'CREDIT'];
export const CREDIT_PAYMENT_METHODS = ['CASH', 'POS', 'TRANSFER', 'RETURN_CREDIT'];

export const MOVEMENT_TYPES = [
  'OPENING_STOCK',
  'RESTOCK',
  'SALE',
  'CUSTOMER_RETURN',
  'DAMAGED',
  'LOST',
  'EXPIRED',
  'SUPPLIER_RETURN',
  'ADJUSTMENT',
  'SALE_VOID',
  'TRANSFER',
];

/**
 * Adjustment types an admin can record.
 * direction -1 always removes stock; 0 means the admin chooses add or remove.
 */
export const ADJUSTMENT_TYPES = {
  DAMAGED: { movement: 'DAMAGED', direction: -1, label: 'Damaged' },
  LOST: { movement: 'LOST', direction: -1, label: 'Lost' },
  EXPIRED: { movement: 'EXPIRED', direction: -1, label: 'Expired' },
  SUPPLIER_RETURN: { movement: 'SUPPLIER_RETURN', direction: -1, label: 'Returned to supplier' },
  CORRECTION: { movement: 'ADJUSTMENT', direction: 0, label: 'Stock correction' },
  OTHER: { movement: 'ADJUSTMENT', direction: 0, label: 'Other' },
};

export const SALE_STATUS = ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED', 'REFUNDED', 'VOIDED'];

export const DEFAULT_CATEGORIES = ['Soft Drink', 'Malt Drink', 'Water', 'Juice', 'Energy Drink', 'Beer'];
