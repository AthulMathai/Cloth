// GET /api/launch-status — which integrations are configured in Netlify
// (true/false only, never the values). Staff with settings access only.
import { rpcAs, configured } from '../lib/supabase.mjs';
import { json, fail } from '../lib/http.mjs';
import { providerName } from '../lib/payments.mjs';
import { emailProvider } from '../lib/email.mjs';
import { provider as aiProvider } from '../lib/ai.mjs';

export default async (req) => {
  if (!configured()) return fail(500, 'Not configured.');
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return fail(401, 'Sign in.');
  const perms = await rpcAs(token, 'my_permissions').catch(() => null);
  const set = new Set((perms || []).map(r => r.permission ?? r));
  if (!set.has('*') && !set.has('settings.write')) return fail(403, 'Settings access needed.');
  const e = process.env, site = e.SITE_URL || e.URL || '';
  return json(200, {
    integrations_live: e.INTEGRATIONS_MODE === 'live',
    payments: { provider: providerName(), stripe_keys: Boolean(e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET), test_key: (e.STRIPE_SECRET_KEY || '').startsWith('sk_test_') },
    email: { provider: emailProvider(), from: Boolean(e.EMAIL_FROM) },
    ai: { provider: aiProvider() },
    carrier_webhook: Boolean(e.CARRIER_WEBHOOK_SECRET),
    cron_secret: Boolean(e.CRON_SECRET),
    site, custom_domain: Boolean(site) && !/\.netlify\.app/.test(site),
  });
};
