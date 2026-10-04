// Every 2 minutes (see netlify.toml): sends queued customer emails.
// The database decides WHAT to send (email_outbox, filled by triggers);
// this only renders and hands each one to the provider, then records the
// result. Failed sends retry with back-off; nothing is sent twice
// (rows are claimed under a lock and the provider gets an idempotency key).
import { rpc, rest, configured } from '../lib/supabase.mjs';
import { emailProvider, sendEmail } from '../lib/email.mjs';
import { render } from '../../public/js/lib/email-templates.js';

export default async () => {
  if (!configured()) return new Response('Supabase service credentials missing', { status: 500 });
  const settings = Object.fromEntries((await rest('store_settings?key=in.(email.from_name,email.reply_to)&select=key,value'))
    .map(r => [r.key, r.value]));
  const site = process.env.URL || process.env.SITE_URL || '';
  const provider = emailProvider();
  const tally = { sent: 0, skipped: 0, failed: 0 };
  for (let round = 0; round < 3; round++) {
    const batch = await rpc('email_claim', { p_limit: 20 });
    if (!batch.length) break;
    for (const m of batch) {
      let subject = null;
      try {
        const msg = render(m.template, m.data || {}, { siteUrl: site });
        subject = msg.subject;
        const r = await sendEmail({ id: m.id, to: m.to, ...msg, fromName: settings['email.from_name'], replyTo: settings['email.reply_to'] });
        const status = r.ok ? 'sent' : r.skipped ? 'skipped' : r.permanent ? 'failed_final' : 'failed';
        await rpc('email_result', { p_id: m.id, p_status: status, p_provider: provider, p_provider_id: r.id || null, p_subject: subject, p_error: r.error || null });
        tally[r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed']++;
      } catch (e) {
        console.error('email render/send failed', m.id, e.message);
        await rpc('email_result', { p_id: m.id, p_status: 'failed_final', p_provider: provider, p_provider_id: null, p_subject: subject, p_error: e.message }).catch(() => {});
        tally.failed++;
      }
    }
  }
  console.log(JSON.stringify({ provider, ...tally }));
  return new Response(JSON.stringify({ provider, ...tally }), { headers: { 'Content-Type': 'application/json' } });
};
