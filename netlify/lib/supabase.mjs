// Server-side Supabase access for Netlify Functions. Uses the service-role
// key, which exists only in Netlify's environment, never in the browser.
const url = () => process.env.SUPABASE_URL;
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

function keyHeaders(key) {
  // Legacy keys are JWTs (sent as apikey + Bearer); newer sb_secret_/sb_publishable_
  // keys must only be sent as apikey.
  return { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) };
}

export class DbError extends Error {
  constructor(status, body) {
    super(body?.message || `Database request failed (${status})`);
    this.status = status; this.code = body?.code; this.details = body?.details;
  }
  /** check_violation / raise exception from our functions = customer-facing message */
  get isUserFacing() { return ['23514', 'P0001'].includes(this.code); }
}

export function configured() { return Boolean(url() && serviceKey()); }

export async function rpc(fn, args = {}) {
  const res = await fetch(`${url()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...keyHeaders(serviceKey()), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new DbError(res.status, data);
  return data;
}

export async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${url()}/rest/v1/${path}`, {
    method,
    headers: { ...keyHeaders(serviceKey()), 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new DbError(res.status, data);
  return data;
}

/** Calls a database function AS the signed-in caller (their JWT), so the
 *  database's own permission checks apply. */
export async function rpcAs(token, fn, args = {}) {
  const key = process.env.SUPABASE_ANON_KEY || serviceKey();
  const res = await fetch(`${url()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new DbError(res.status, data);
  return data;
}

/** Verifies the caller's Supabase session (if any) and returns the user. */
export async function getUser(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !token.startsWith('eyJ')) return null;
  const res = await fetch(`${url()}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY || serviceKey(), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? user : null;
}
