// POST /api/carrier-webhook   (tracking updates)
// Authorization: Bearer <CARRIER_WEBHOOK_SECRET>
// Body: { "carrier": "Canada Post", "tracking_number": "...", "status": "in_transit|out_for_delivery|delivered|exception|returned",
//         "description": "...", "location": "...", "occurred_at": "ISO time", "event_id": "carrier's unique scan id" }
// A neutral format: a tracking aggregator (or a small adapter per carrier)
// posts here. Each scan is recorded once (event_id) and never moves an
// order backwards.
import { rpc, rest, configured, DbError } from '../lib/supabase.mjs';
import { json, fail, readJson, rateLimited } from '../lib/http.mjs';
import { timingSafeEqual } from 'node:crypto';

const STATUSES = new Set(['in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned']);

export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  const secret = process.env.CARRIER_WEBHOOK_SECRET;
  if (!configured() || !secret) return fail(500, 'not configured');
  if (rateLimited(req, 'carrier-hook', 300)) return fail(429, 'slow down');
  const given = Buffer.from((req.headers.get('authorization') || '').replace(/^Bearer /, ''));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return fail(401, 'unauthorized');

  let b;
  try { b = await readJson(req); } catch (e) { return fail(e.status || 400, e.message); }
  if (!STATUSES.has(b.status)) return fail(400, 'unknown status');
  const track = String(b.tracking_number || '').replace(/\s/g, '').toUpperCase();
  const [ship] = await rest(`shipments?tracking_number=eq.${encodeURIComponent(track)}&select=id,carrier`);
  if (!ship) return fail(404, 'unknown tracking number');
  try {
    const out = await rpc('shipment_record_event', {
      p_shipment_id: ship.id, p_status: b.status, p_description: b.description ? String(b.description).slice(0, 300) : null,
      p_location: b.location ? String(b.location).slice(0, 120) : null, p_occurred_at: b.occurred_at || null,
      p_external_id: b.event_id ? String(b.event_id).slice(0, 120) : null, p_source: 'carrier',
    });
    return json(200, out);
  } catch (e) {
    console.error('carrier webhook failed', e);
    return fail(e instanceof DbError && e.isUserFacing ? 400 : 500, e.message);
  }
};
