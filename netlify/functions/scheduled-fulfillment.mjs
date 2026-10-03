// Every 5 minutes (see netlify.toml):
//   * route paid orders the instant trigger missed, retry backorders
//   * flag partners who haven't accepted in time, and late production
//   * send production orders to partners that integrate by webhook (with retries)
//   * advance shipments booked with the built-in test carrier
import { configured } from '../lib/supabase.mjs';
import { rpc } from '../lib/supabase.mjs';
import { dispatchDue } from '../lib/fulfillment.mjs';

export default async () => {
  if (!configured()) return new Response('Supabase service credentials missing', { status: 500 });
  const sweep = await rpc('fulfillment_sweep');
  let dispatched = [];
  try { dispatched = await dispatchDue(25); } catch (e) { console.error('dispatch failed', e); }
  const out = { sweep, dispatched };
  console.log(JSON.stringify(out));
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
};
