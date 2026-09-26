import { can, P } from '../config/roles.js';

/** Fields that reveal cost or profit. Removed for anyone without cost:read. */
const COST_FIELDS = new Set([
  'costPrice',
  'avgCost',
  'unitCost',
  'lineCost',
  'totalCost',
  'returnedCost',
  'profit',
  'margin',
  'inventoryValue',
  'costPerUnit',
  'costPerBase',
  'cost',
  'grossProfit',
]);

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (typeof value.toJSON === 'function' && value.constructor?.name !== 'Object') {
      const json = value.toJSON();
      if (json !== value) return strip(json);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!COST_FIELDS.has(k)) out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/** Sends JSON, removing cost and profit fields for users who may not see them. */
export function sendScoped(req, res, data, status = 200) {
  const body = can(req.user, P.COST_READ) ? data : strip(data);
  return res.status(status).json(body);
}

export function pageParams(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
