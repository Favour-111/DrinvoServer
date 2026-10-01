import { UNITS } from '../config/constants.js';
import { ApiError } from './ApiError.js';

/** Bottles in one `unit` for this variant, or 0 if the variant is not sold that way. */
export function conversionFor(variant, unit) {
  if (unit === 'bottle') return 1;
  return Number(variant.unitConversions?.[unit]) || 0;
}

export function availableUnits(variant) {
  return UNITS.filter((u) => conversionFor(variant, u) > 0);
}

/** Selling price for one `unit`. Uses the unit's own price if set, else bottle price x conversion. */
export function priceFor(variant, unit) {
  const conv = conversionFor(variant, unit);
  if (!conv) return 0;
  if (unit === 'bottle') return variant.sellingPrice;
  const own = Number(variant.unitPrices?.[unit]);
  return own > 0 ? own : variant.sellingPrice * conv;
}

/** Lowest allowed selling price for one `unit`, scaled the same way as priceFor. 0 means no floor. */
export function minimumFor(variant, unit) {
  const conv = conversionFor(variant, unit);
  if (!conv) return 0;
  return (Number(variant.minimumSellingPrice) || 0) * conv;
}

/** Converts a quantity in `unit` to base bottles, rejecting units this variant doesn't use. */
export function toBase(variant, unit, quantity) {
  const conv = conversionFor(variant, unit);
  if (!conv) {
    throw ApiError.badRequest(`${variant.name} is not sold by the ${unit}.`);
  }
  return { conversion: conv, baseQuantity: conv * quantity };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "5 cartons + 12 bottles" using the largest configured unit. */
export function describeStock(variant, bottles) {
  const big = ['carton', 'crate', 'pack'].find((u) => conversionFor(variant, u) > 0);
  if (!big || bottles === 0) return plural(bottles, 'bottle');
  const c = conversionFor(variant, big);
  const q = Math.floor(bottles / c);
  const r = bottles % c;
  if (q === 0) return plural(r, 'bottle');
  return plural(q, big) + (r ? ` + ${plural(r, 'bottle')}` : '');
}
