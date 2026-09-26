import { z } from 'zod';
import { UNITS } from '../config/constants.js';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const idParam = z.object({ id: objectId });
export const money = z.coerce.number({ invalid_type_error: 'Enter an amount' }).min(0, 'Must be 0 or more').max(1e11);
export const positiveInt = z.coerce.number().int('Use a whole number').min(1, 'Must be at least 1').max(1_000_000);
export const unit = z.enum(UNITS);
export const text = (max = 200) => z.string().trim().max(max);
export const optionalText = (max = 200) => z.string().trim().max(max).optional().default('');
export const phone = z.string().trim().min(7, 'Enter a valid phone number').max(40);

export const rangeQuery = z.object({
  range: z.enum(['today', 'yesterday', '7d', '30d', 'month', 'year', 'custom']).default('7d'),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().max(100).optional(),
});
