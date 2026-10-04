// POST /api/partner-webhook   (partners that integrate by API)
// Headers:  X-MWay-Partner: <partner code>
//           X-MWay-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>
// Body:     { "production_order": "PO-50012", "action": "accept|reject|start|printed|reprint|packed|ship|note",
//             "note": "...", "carrier": "...", "tracking_number": "...", "service": "...", "tracking_url": "..." }
// The same state rules as the partner portal apply (partner_po_action).
// A step that doesn't fit the current state (e.g. a replay) gets 409 with the
// production order's current status, so the partner can reconcile.
import { rpc, rest, configured, DbError } from '../lib/supabase.mjs';
import { json, fail, rateLimited } from '../lib/http.mjs';
import { verify } from '../lib/fulfillment.mjs';

const ACTIONS = new Set(['accept', 'reject', 'start', 'printed', 'reprint', 'packed', 'ship', 'note']);

export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  if (!configured()) return fail(500, 'not configured');
  if (rateLimited(req, 'partner-hook', 120)) return fail(429, 'slow down');
  const code = String(req.headers.get('x-mway-partner') || '').toLowerCase();
  if (!/^[a-z0-9-]{2,42}$/.test(code)) return fail(401, 'unknown partner');
  const raw = await req.text();
  if (raw.length > 16_384) return fail(413, 'too large');

  const [partner] = await rest(`partners?code=eq.${encodeURIComponent(code)}&select=id,status,partner_integrations(secret)`);
  const integ = Array.isArray(partner?.partner_integrations) ? partner.partner_integrations[0] : partner?.partner_integrations;
  const secret = integ?.secret;
  if (!partner || !verify(secret, raw, req.headers.get('x-mway-signature'))) return fail(401, 'invalid signature');

  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, 'invalid JSON'); }
  const action = String(body.action || '');
  if (!ACTIONS.has(action)) return fail(400, 'unknown action');
  const [po] = await rest(`production_orders?number=eq.${encodeURIComponent(String(body.production_order || ''))}&partner_id=eq.${partner.id}&select=id,status`);
  if (!po) return fail(404, 'production order not found for this partner');

  const data = { as: 'partner' };
  for (const k of ['note', 'carrier', 'tracking_number', 'service', 'tracking_url', 'estimated_delivery']) {
    if (body[k] != null) data[k] = String(body[k]).slice(0, 500);
  }
  try {
    const out = await rpc('partner_po_action', { p_po_id: po.id, p_action: action, p_data: data });
    return json(200, { production_order: body.production_order, ...out });
  } catch (e) {
    if (e instanceof DbError && e.isUserFacing) {
      const [now] = await rest(`production_orders?id=eq.${po.id}&select=status`);
      return json(409, { error: e.message, status: now?.status });
    }
    console.error('partner webhook failed', e);
    return fail(500, 'could not apply');
  }
};
