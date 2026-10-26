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

/** A product's packaging type. Products saved before packaging types existed are STANDARD. */
export const packagingOf = (variant) => variant?.packagingType || variant?.product?.packagingType || 'STANDARD';
export const isMiniature = (variant) => packagingOf(variant) === 'MINIATURE';

/**
 * Reference purchase cost for one `unit`: the unit's own saved cost if set, else bottle cost x
 * conversion. Only a default for the restock form; actual stock cost comes from what is paid.
 */
export function costFor(variant, unit) {
  const conv = conversionFor(variant, unit);
  if (!conv) return 0;
  if (unit === 'bottle') return variant.costPrice;
  const own = Number(variant.unitCosts?.[unit]);
  return own > 0 ? own : Math.round(variant.costPrice * conv * 100) / 100;
}

/**
 * Checks a miniature drink's pack/carton setup and returns an error message, or null when valid.
 * A miniature is sold by the bottle, pack and carton (no crate); a carton is a whole number of packs.
 */
export function miniatureConversionError(conversions) {
  const pack = Number(conversions?.pack) || 0;
  const carton = Number(conversions?.carton) || 0;
  if (pack < 1) return 'Enter how many bottles are in a pack.';
  if (carton < 1) return 'Enter how many packs are in a carton.';
  if (Number(conversions?.crate) > 0) return 'Miniature drinks are sold by the bottle, pack and carton only.';
  if (carton < pack || carton % pack !== 0) return 'A carton must hold a whole number of packs.';
  return null;
}

/** { bottlesPerPack, packsPerCarton, bottlesPerCarton } for a miniature, or null for anything else. */
export function miniatureLayout(variant) {
  if (!isMiniature(variant)) return null;
  const pack = conversionFor(variant, 'pack');
  const carton = conversionFor(variant, 'carton');
  if (!pack || !carton) return null;
  return { bottlesPerPack: pack, packsPerCarton: Math.floor(carton / pack), bottlesPerCarton: carton };
}

/**
 * Splits a bottle count into whole cartons, then packs, then leftover bottles. Always derived from
 * the single bottle balance, never stored. Units the product doesn't use are skipped.
 */
export function breakdownStock(variant, bottles) {
  let rest = Math.max(0, Math.floor(bottles));
  const out = { carton: 0, pack: 0, bottle: 0 };
  for (const u of ['carton', 'pack']) {
    const c = conversionFor(variant, u);
    if (!c) continue;
    out[u] = Math.floor(rest / c);
    rest -= out[u] * c;
  }
  out.bottle = rest;
  return out;
}

/** "5 cartons + 12 bottles"; miniatures spell out every level: "4 cartons + 9 packs + 2 bottles". */
export function describeStock(variant, bottles) {
  if (isMiniature(variant)) {
    const b = breakdownStock(variant, bottles);
    const parts = ['carton', 'pack', 'bottle'].filter((u) => b[u] > 0).map((u) => plural(b[u], u));
    return parts.length ? parts.join(' + ') : plural(0, 'bottle');
  }
  const big = ['carton', 'crate', 'pack'].find((u) => conversionFor(variant, u) > 0);
  if (!big || bottles === 0) return plural(bottles, 'bottle');
  const c = conversionFor(variant, big);
  const q = Math.floor(bottles / c);
  const r = bottles % c;
  if (q === 0) return plural(r, 'bottle');
  return plural(q, big) + (r ? ` + ${plural(r, 'bottle')}` : '');
}
