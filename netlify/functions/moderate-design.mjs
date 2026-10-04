// POST /api/moderate-design  { design_id }
// Runs automated checks on the submitted version of a customer's design
// and records the decision. The caller must own the design.
import { rest, rpc, getUser, configured } from '../lib/supabase.mjs';
import { json, fail, readJson, rateLimited } from '../lib/http.mjs';
import { moderateDesign } from '../lib/moderation.mjs';
import { provider as aiProvider, describeImage, captionLooksRisky } from '../lib/ai.mjs';

const keyHeaders = (key) => ({ apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) });

async function fetchBytes(asset, range) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/${asset.bucket}/${asset.path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { headers: { ...keyHeaders(key), ...(range ? { Range: `bytes=0-${range}` } : {}) } });
  if (!res.ok) return null;
  return res.arrayBuffer();
}

export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  if (!configured()) return fail(500, 'Moderation is not configured.');
  if (rateLimited(req, 'moderate', 15)) return fail(429, 'Too many submissions. Wait a minute.');
  const user = await getUser(req);
  if (!user) return fail(401, 'Sign in to submit designs.');
  let body;
  try { body = await readJson(req, 1024); } catch (e) { return fail(400, e.message); }
  const id = String(body.design_id || '');
  if (!/^[0-9a-f-]{36}$/.test(id)) return fail(400, 'Missing design.');

  const [design] = await rest(`custom_designs?id=eq.${id}&select=*`);
  if (!design || design.user_id !== user.id) return fail(404, 'Design not found.');
  if (design.status !== 'pending') return json(200, { status: design.status, findings: [] });

  const assetIds = [...new Set((design.config.layers || []).filter(l => l.type === 'image').map(l => l.asset_id))];
  const assets = assetIds.length
    ? await rest(`design_assets?id=in.(${assetIds.join(',')})&user_id=eq.${user.id}&select=*`) : [];
  const terms = await rest('moderation_terms?select=term,category,action');

  // Optional AI description of each image (needs a real AI provider and the
  // ai.vision_moderation setting; skipped in test mode).
  let describe = null;
  if (aiProvider() !== 'mock') {
    const [s] = await rest('store_settings?key=eq.ai.vision_moderation&select=value');
    if (!s || s.value === true || s.value === 'true') describe = describeImage;
  }
  const result = await moderateDesign({ design, assets, terms, fetchBytes, live: process.env.INTEGRATIONS_MODE === 'live',
    describe, isRisky: captionLooksRisky });
  const saved = await rpc('record_moderation', {
    p_design_id: design.id, p_version: design.version, p_provider: result.provider, p_score: result.score,
    p_decision: result.decision, p_findings: result.findings, p_asset_ids: result.verified,
  });
  return json(200, {
    status: saved.status, provider: result.provider,
    findings: result.findings.filter(f => f.severity !== 'info' || f.category === 'quality').map(f => ({ severity: f.severity, message: f.message })),
  });
};
