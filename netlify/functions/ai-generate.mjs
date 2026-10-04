// POST /api/ai-generate  { prompt, style }
// Turns a customer's description into artwork for the Custom Designer.
//   1. signed-in customers only, per-person and store-wide daily limits
//   2. the description is screened (built-in list + staff term list); refused
//      requests are logged but never sent to the provider
//   3. the image is generated, stored privately under the customer's folder
//      and registered as their design asset
// The result still goes through normal design moderation when submitted.
import { rest, rpc, getUser, configured } from '../lib/supabase.mjs';
import { json, fail, readJson, rateLimited } from '../lib/http.mjs';
import { provider, models, isTestMode, generateImage, screenPrompt, STYLES } from '../lib/ai.mjs';
import { createHash } from 'node:crypto';

const keyHeaders = (key) => ({ apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) });
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

async function putObject(path, bytes, mime) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/designs/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { ...keyHeaders(key), 'Content-Type': mime, 'x-upsert': 'false' }, body: bytes,
  });
  if (!res.ok) throw new Error(`Storage upload failed (${res.status})`);
}

async function signedUrl(path) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/designs/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { ...keyHeaders(key), 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return null;
  const { signedURL } = await res.json();
  return signedURL ? `${process.env.SUPABASE_URL}/storage/v1${signedURL}` : null;
}

export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  if (!configured()) return fail(500, 'AI design is not configured.');
  if (rateLimited(req, 'ai-generate', 6)) return fail(429, 'Slow down a little — try again in a minute.');
  const user = await getUser(req);
  if (!user) return fail(401, 'Sign in to generate artwork.');

  let body;
  try { body = await readJson(req, 4096); } catch (e) { return fail(e.status || 400, e.message); }
  const prompt = String(body.prompt || '').replace(/\s+/g, ' ').trim();
  const style = STYLES.includes(body.style) ? body.style : 'none';
  if (prompt.length < 3) return fail(400, 'Describe what you want in a few words.');
  if (prompt.length > 600) return fail(400, 'Keep the description under 600 characters.');

  const q = await rpc('ai_quota', { p_user: user.id });
  if (!q.enabled) return fail(503, 'AI design is switched off right now.');
  if (q.global_used >= q.global_limit) return fail(429, 'AI design has reached today\'s limit for the store. Try again tomorrow, or upload your own artwork.');
  if (q.user_used >= q.user_limit) return fail(429, `You've used all ${q.user_limit} AI designs for today. Try again tomorrow.`, { left: 0 });

  const m = models(), prov = provider();
  const log = (row) => rest('ai_generations', { method: 'POST', prefer: 'return=representation',
    body: { user_id: user.id, prompt, style, provider: prov, model: m.image, ...row } }).then(r => r[0]);

  const terms = await rest('moderation_terms?select=term,category,action');
  const refused = screenPrompt(prompt, terms);
  if (refused) {
    await log({ status: 'blocked', reason: refused.category });
    return fail(422, refused.message, { blocked: true });
  }

  const gen = await log({ status: 'pending' });
  const started = Date.now();
  try {
    const img = await generateImage(prompt, style);
    const path = `${user.id}/ai/${gen.id}.${EXT[img.mime] || 'png'}`;
    await putObject(path, img.bytes, img.mime);
    const [asset] = await rest('design_assets', { method: 'POST', prefer: 'return=representation', body: {
      user_id: user.id, kind: 'original', bucket: 'designs', path, mime: img.mime, bytes: img.bytes.length,
      width_px: img.width, height_px: img.height, sha256: createHash('sha256').update(img.bytes).digest('hex'),
      original_name: `AI: ${prompt}`.slice(0, 200), verified: true,
    } });
    const duration = Date.now() - started;
    await rest(`ai_generations?id=eq.${gen.id}`, { method: 'PATCH', body: {
      status: 'succeeded', asset_id: asset.id, width_px: img.width, height_px: img.height, duration_ms: duration, model: img.model } });
    await rest('analytics_events', { method: 'POST', body: {
      event_type: 'ai_design_generated', user_id: user.id, properties: { style, provider: prov, test_mode: isTestMode(), ms: duration } } }).catch(() => {});
    return json(200, {
      generation_id: gen.id, asset_id: asset.id, url: await signedUrl(path), mime: img.mime, width: img.width, height: img.height,
      test_mode: isTestMode(), provider: prov, left: Math.max(0, q.user_limit - q.user_used - 1),
    });
  } catch (e) {
    console.error('ai-generate failed', e.message, e.detail || '');
    await rest(`ai_generations?id=eq.${gen.id}`, { method: 'PATCH', body: {
      status: 'failed', reason: String(e.message).slice(0, 200), duration_ms: Date.now() - started } }).catch(() => {});
    return fail(e.status === 429 ? 429 : 502, e.status === 429 ? e.message : 'The AI couldn\'t make that one. Try again or reword it.');
  }
};
