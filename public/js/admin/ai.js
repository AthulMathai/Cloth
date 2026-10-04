// /admin/ai — AI design generation: switches and limits, today's usage,
// the meaning-search index, and a log of every request (including refused
// ones) with the image that came back.
import { db, storage } from '../lib/supabase.js';
import { esc, num, dateTime, pill, table, toast, errorText, kpi } from './ui.js';

const REASONS = { character: 'Refused: names someone else\'s character', trademark: 'Refused: names a brand', sports: 'Refused: names a team or league',
  explicit: 'Refused: explicit content', minors: 'Refused: sexual content involving minors', hate: 'Refused: hate symbols', violence: 'Refused: graphic violence',
  likeness: 'Refused: a real person\'s likeness', counterfeit: 'Refused: looks like counterfeit merch' };
const STATUS_TONE = { succeeded: 'Made', blocked: 'Refused', failed: 'Failed', pending: 'Working' };

export async function view(ctx) {
  const [o, status] = await Promise.all([
    db.rpc('admin_ai_overview', { p_limit: 100 }),
    fetch('/api/ai-status').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const st = o.settings, canSettings = ctx.can('settings.write');
  const thumbs = await storage.sign('designs', o.recent.map(r => r.path).filter(Boolean)).catch(() => ({}));
  const idx = o.embeddings;
  return {
    title: 'AI',
    html: `<header class="cc-head"><div><h1>AI</h1>
        <p class="cc-muted">Design generation in the Custom Designer, image descriptions for moderation, meaning-based search and recommendations.</p></div></header>
      ${status == null ? `<p class="cc-note">Couldn't reach the AI service status. In local development the Netlify functions may not be running.</p>`
        : status.test_mode ? `<p class="cc-note cc-note--warn"><strong>Test mode.</strong> No AI provider is connected, so customers get a labelled placeholder pattern and search uses a simple word-matching index.
            Add <code>CLOUDFLARE_ACCOUNT_ID</code> and <code>CLOUDFLARE_AI_TOKEN</code> in Netlify to switch on Cloudflare Workers AI (free daily allowance).</p>`
        : `<p class="cc-note">Connected to <strong>${esc(status.provider)}</strong> · images <code>${esc(status.models.image)}</code> · search <code>${esc(status.models.embed)}</code> · descriptions <code>${esc(status.models.vision)}</code></p>`}
      <div class="cc-kpis">
        ${kpi('Designs made today', `${num(o.today.succeeded)} <small class="cc-muted">/ ${num(st.daily_global_limit)}</small>`, `${num(o.today.blocked)} refused · ${num(o.today.failed)} failed`)}
        ${kpi('Last 30 days', num(o.last_30.succeeded), `${num(o.last_30.people)} people · ${num(o.last_30.blocked)} refused`)}
        ${kpi('Ordered (30 days)', num(o.last_30.ordered), 'order lines whose design uses AI art')}
        ${kpi('Search index', `${num(idx.indexed)} / ${num(idx.products)}`, idx.updated_at ? `products · updated ${dateTime(idx.updated_at)}` : 'products · builds hourly')}
      </div>
      <div class="cc-two">
        <section class="cc-card"><h2>Settings</h2>
          ${canSettings ? `<form class="ai-settings" data-settings>
            <label class="cc-check"><input type="checkbox" name="ai.enabled"${st.enabled ? ' checked' : ''}> <span>Let customers generate designs</span></label>
            <label class="cc-check"><input type="checkbox" name="ai.vision_moderation"${st.vision_moderation ? ' checked' : ''}> <span>Describe uploaded images for moderators (needs a provider)</span></label>
            <div class="cc-field"><label for="ai-u">Designs per customer per day</label><input id="ai-u" name="ai.daily_user_limit" type="number" min="0" max="200" value="${st.daily_user_limit}"></div>
            <div class="cc-field"><label for="ai-g">Designs per day, whole store</label><input id="ai-g" name="ai.daily_global_limit" type="number" min="0" max="100000" value="${st.daily_global_limit}">
              <small class="cc-muted">Protects the free allowance: about 10,000 “neurons” a day on Cloudflare, roughly a few hundred quick images.</small></div>
            <button class="cc-btn cc-btn--primary">Save</button></form>`
          : `<dl class="an-dl"><dt>Generation</dt><dd>${st.enabled ? 'On' : 'Off'}</dd><dt>Per customer / day</dt><dd>${num(st.daily_user_limit)}</dd>
              <dt>Store / day</dt><dd>${num(st.daily_global_limit)}</dd><dt>Image descriptions</dt><dd>${st.vision_moderation ? 'On' : 'Off'}</dd></dl>`}
        </section>
        <section class="cc-card"><h2>How it's kept safe</h2>
          <ul class="cc-list">
            <li>Descriptions naming brands, characters, teams (from the moderation term list) or explicit, hateful or violent content are refused before anything is generated.</li>
            <li>Generated art is stored privately in the customer's folder and goes through the same design moderation as uploads when they submit.</li>
            <li>Image descriptions only ever send a design <em>to</em> a person; they never approve one.</li>
            <li>Recommendations, forecasts and search ranking run inside the database on the store's own data.</li>
          </ul></section>
      </div>
      <section class="cc-card cc-card--flush"><div class="cc-card-head ff-pad"><h2>Recent requests</h2></div>
        ${table(o.recent, [
          { label: '', render: r => r.path && thumbs[r.path] ? `<img class="ai-thumb" src="${esc(thumbs[r.path])}" alt="" loading="lazy">` : '<span class="ai-thumb ai-thumb--none" aria-hidden="true"></span>' },
          { label: 'Description', render: r => `<span class="ai-desc">${esc(r.prompt)}${r.style && r.style !== 'none' ? ` <span class="cc-muted cc-small">· ${esc(r.style)}</span>` : ''}${r.reason ? `<br><span class="cc-small cc-muted">${esc(REASONS[r.reason] || r.reason)}</span>` : ''}</span>` },
          { label: 'Customer', render: r => r.user_id ? `<a href="/admin/customers/${r.user_id}">${esc(r.email || 'Customer')}</a>` : '—' },
          { label: 'Result', render: r => pill({ succeeded: 'active', blocked: 'rejected', failed: 'failed' }[r.status] || 'pending', STATUS_TONE[r.status]) },
          { label: 'Provider', render: r => `<span class="cc-small">${esc(r.provider)}${r.duration_ms ? ` · ${(r.duration_ms / 1000).toFixed(1)} s` : ''}</span>` },
          { label: 'When', render: r => dateTime(r.created_at) },
        ], { empty: 'No AI requests yet.' })}</section>`,
    mount(root) {
      const f = root.querySelector('[data-settings]');
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        const vals = {
          'ai.enabled': f.elements['ai.enabled'].checked, 'ai.vision_moderation': f.elements['ai.vision_moderation'].checked,
          'ai.daily_user_limit': Math.max(0, Math.round(Number(f.elements['ai.daily_user_limit'].value) || 0)),
          'ai.daily_global_limit': Math.max(0, Math.round(Number(f.elements['ai.daily_global_limit'].value) || 0)),
        };
        try { for (const [key, value] of Object.entries(vals)) await db.update('store_settings', { key }, { value }); toast('AI settings saved.'); ctx.go(location.pathname); }
        catch (err) { toast(errorText(err), 'bad'); }
      };
    },
  };
}
