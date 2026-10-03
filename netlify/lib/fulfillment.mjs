// Fulfillment plumbing shared by the scheduled job and the partner/carrier
// endpoints. The database owns every decision (routing, state changes);
// this file only moves messages and signs file links.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { rpc } from './supabase.mjs';

const url = () => process.env.SUPABASE_URL;
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

/** HMAC signature partners verify (and use when calling us back):
 *  header  X-TH8RTY-Signature: t=<unix seconds>,v1=<hex sha256(secret, "<t>.<body>")> */
export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export function verify(secret, body, header, toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map(p => p.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec || !parts.v1) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const got = Buffer.from(String(parts.v1));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Send production orders to partners that integrate by webhook. Leased
 *  rows + the PO number as idempotency key mean a retry never duplicates. */
export async function dispatchDue(limit = 20) {
  const due = await rpc('fulfillment_dispatch_due', { p_limit: limit });
  const results = [];
  for (const job of due || []) {
    let ok = false, error = null;
    if (!job.url) error = 'No webhook URL configured for this partner';
    else {
      const body = JSON.stringify(job.payload);
      try {
        const res = await fetch(job.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': job.number, 'X-TH8RTY-Signature': sign(job.secret, body),
                     'User-Agent': 'TH8RTY-Fulfillment/1' },
          body, signal: AbortSignal.timeout(10_000),
        });
        ok = res.ok || res.status === 409;               // 409 = partner already has it
        if (!ok) error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      } catch (e) { error = e.name === 'TimeoutError' ? 'Timed out after 10s' : e.message; }
    }
    await rpc('fulfillment_dispatch_result', { p_po_id: job.po_id, p_ok: ok, p_error: error });
    results.push({ number: job.number, ok, error });
  }
  return results;
}

/** Short-lived signed URL for a private storage object. */
export async function signedUrl(bucket, path, expiresIn = 3600) {
  const res = await fetch(`${url()}/storage/v1/object/sign/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { apikey: serviceKey(), ...(serviceKey().startsWith('eyJ') ? { Authorization: `Bearer ${serviceKey()}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) return null;
  const { signedURL } = await res.json();
  return signedURL ? `${url()}/storage/v1${signedURL}` : null;
}
