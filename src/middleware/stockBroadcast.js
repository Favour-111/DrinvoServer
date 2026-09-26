import { stockRows } from '../services/inventory.service.js';
import { broadcastStock } from '../realtime/stockHub.js';

/**
 * Pushes fresh stock rows to every open screen on this shop once the response
 * has actually gone out — only for requests that succeeded and touched stock
 * (sales, restocks, adjustments, returns, voids all record this on req.ctx).
 */
export function stockBroadcast(req, res, next) {
  res.on('finish', () => {
    const ids = req.ctx?.touchedVariantIds;
    if (!ids?.size || res.statusCode >= 400) return;
    stockRows(req.ctx, { includeArchived: true, variantIds: [...ids] })
      .then((rows) => broadcastStock(req.ctx.shopId, rows))
      .catch(() => {});
  });
  next();
}
