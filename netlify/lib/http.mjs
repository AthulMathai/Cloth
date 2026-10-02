// Small HTTP helpers shared by functions.
export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export const fail = (status, message, extra = {}) => json(status, { error: message, ...extra });

// Best-effort per-instance rate limit (Netlify may run several instances;
// the database functions remain the real guard against abuse).
const hits = new Map();
export function rateLimited(req, key, max = 20, windowMs = 60_000) {
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'local';
  const k = `${key}:${ip}`, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}

export async function readJson(req, maxBytes = 16_384) {
  const text = await req.text();
  if (text.length > maxBytes) throw Object.assign(new Error('Request too large'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function siteOrigin(req) {
  return process.env.URL || new URL(req.url).origin;
}
