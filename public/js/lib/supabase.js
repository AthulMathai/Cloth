// Minimal Supabase client over plain fetch (PostgREST + GoTrue REST).
// The browser only ever holds the public anon key or the signed-in user's
// JWT; every authorization decision is made by Row Level Security.
import { env } from './env.js';

const SESSION_KEY = 'th8rty.session';

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function writeSession(s) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {}
}

let session = readSession();
const listeners = new Set();

function headers(extra = {}) {
  const h = { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...extra };
  h.Authorization = `Bearer ${session?.access_token || env.SUPABASE_ANON_KEY}`;
  return h;
}

export class DbError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status; this.code = body?.code; this.details = body?.details;
  }
}

async function request(path, { method = 'GET', body, headers: extra, signal } = {}) {
  if (!env.SUPABASE_URL) throw new DbError(0, { message: 'Supabase is not configured (SUPABASE_URL missing).' });
  await maybeRefresh();
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method, signal, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new DbError(res.status, data);
  return { data, res };
}

// ---- PostgREST query builder -------------------------------------------
class Query {
  constructor(table) { this.table = table; this.params = new URLSearchParams(); this._single = false; }
  select(cols = '*') { this.params.set('select', cols); return this; }
  eq(c, v) { this.params.append(c, `eq.${v}`); return this; }
  neq(c, v) { this.params.append(c, `neq.${v}`); return this; }
  in(c, arr) { this.params.append(c, `in.(${arr.map(v => `"${v}"`).join(',')})`); return this; }
  gt(c, v) { this.params.append(c, `gt.${v}`); return this; }
  lte(c, v) { this.params.append(c, `lte.${v}`); return this; }
  is(c, v) { this.params.append(c, `is.${v}`); return this; }
  textSearch(c, q) { this.params.append(c, `wfts(simple).${q}`); return this; }
  order(c, { ascending = true, nullsLast = true } = {}) {
    const prev = this.params.get('order');
    const part = `${c}.${ascending ? 'asc' : 'desc'}${nullsLast ? '.nullslast' : ''}`;
    this.params.set('order', prev ? `${prev},${part}` : part); return this;
  }
  limit(n) { this.params.set('limit', String(n)); return this; }
  single() { this._single = true; return this; }
  async _exec() {
    const extra = this._single ? { Accept: 'application/vnd.pgrst.object+json' } : {};
    return (await request(`/rest/v1/${this.table}?${this.params}`, { headers: extra })).data;
  }
  then(resolve, reject) { return this._exec().then(resolve, reject); }
  catch(reject) { return this._exec().catch(reject); }
}

export const db = {
  from: (table) => new Query(table),
  rpc: async (fn, args = {}) => (await request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args })).data,
};

// ---- Auth (GoTrue) ------------------------------------------------------
function setSession(s) {
  session = s ? { ...s, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) } : null;
  writeSession(session);
  listeners.forEach(fn => fn(session));
}

let refreshing = null;
async function maybeRefresh() {
  if (!session?.refresh_token || session.expires_at - 60 > Date.now() / 1000) return;
  refreshing ||= fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  }).then(async r => setSession(r.ok ? await r.json() : null)).finally(() => { refreshing = null; });
  await refreshing;
}

async function authCall(path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new DbError(res.status, { message: data.msg || data.error_description || data.message || 'Authentication failed' });
  return data;
}

export const auth = {
  get session() { return session; },
  get user() { return session?.user || null; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async signIn(email, password) { setSession(await authCall('token?grant_type=password', { email, password })); return session; },
  async signUp(email, password, fullName) {
    const data = await authCall('signup', { email, password, data: { full_name: fullName } });
    if (data.access_token) setSession(data);
    return data; // when email confirmation is on, no session is returned yet
  },
  async signOut() {
    if (session) await fetch(`${env.SUPABASE_URL}/auth/v1/logout`, { method: 'POST', headers: headers() }).catch(() => {});
    setSession(null);
  },
  async sendReset(email) { await authCall('recover', { email }); },
  // Handles the #access_token=... fragment Supabase redirects back with.
  consumeRedirect() {
    if (!location.hash.includes('access_token=')) return false;
    const p = new URLSearchParams(location.hash.slice(1));
    setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
                 expires_in: Number(p.get('expires_in') || 3600), user: null });
    history.replaceState(null, '', location.pathname + location.search);
    fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: headers() })
      .then(r => r.ok ? r.json() : null).then(user => user && setSession({ ...session, user }));
    return true;
  },
};

export function storageUrl(bucket, path) {
  return `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}
