// Email provider adapter. Resend (free: 3,000 emails/month, 100/day) when
// RESEND_API_KEY is set; otherwise test mode — emails are rendered and
// logged as "skipped" so staff can preview them, but nothing is sent.
//   EMAIL_FROM   address on a domain verified in Resend, e.g. orders@th8rty.ca
//                (without it Resend's shared onboarding@resend.dev is used,
//                which only delivers to the Resend account owner's inbox)
export function emailProvider() {
  if ((process.env.EMAIL_PROVIDER || '').toLowerCase() === 'mock') return 'mock';
  return process.env.RESEND_API_KEY ? 'resend' : 'mock';
}

/** -> { ok, id?, permanent?, error? } */
export async function sendEmail({ id, to, subject, html, text, fromName, replyTo }) {
  if (emailProvider() === 'mock') return { ok: false, skipped: true, error: 'Test mode: no email provider configured' };
  const from = `${(fromName || 'TH8RTY').replace(/[<>"]/g, '')} <${process.env.EMAIL_FROM || 'onboarding@resend.dev'}>`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `outbox-${id}` },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: body.id || null };
    // 4xx (except rate limits) won't succeed on retry: bad address, unverified domain, invalid key
    return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 429, error: `${res.status} ${body.message || body.name || 'send failed'}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Email provider timed out' : e.message };
  } finally { clearTimeout(t); }
}
