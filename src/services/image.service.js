import { Product, ProductVariant } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';

const MAX_BYTES = 6 * 1024 * 1024; // 6MB — a product photo, not a general file host
const FETCH_TIMEOUT_MS = 6000;

/**
 * Re-fetches a product photo and hands back its bytes so the API can re-serve it from our own
 * origin. The client needs this for canvas colour-sampling: a cross-origin <img> tainted by a
 * third-party host with no CORS headers blocks pixel reads entirely, even though the image
 * displays fine normally. Re-serving it from here lets the app's own CORS policy (already
 * trusted by the client) apply instead of the original host's.
 *
 * Restricted to URLs already saved as a product or variant photo — never an arbitrary URL —
 * so this can't be used as an open proxy to fetch or probe other sites.
 */
export async function fetchProductImage(src) {
  if (typeof src !== 'string' || !/^https?:\/\//i.test(src)) throw ApiError.badRequest('Invalid image URL.');
  const known = (await Product.exists({ image: src })) || (await ProductVariant.exists({ image: src }));
  if (!known) throw ApiError.notFound('Image not found.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(src, { signal: controller.signal, redirect: 'follow' });
  } catch {
    throw ApiError.badRequest('Could not fetch this image.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) throw ApiError.badRequest('Could not fetch this image.');

  const contentType = upstream.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw ApiError.badRequest('That URL is not an image.');
  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  if (declaredLength > MAX_BYTES) throw ApiError.badRequest('Image is too large.');

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw ApiError.badRequest('Image is too large.');
  return { buffer, contentType };
}
