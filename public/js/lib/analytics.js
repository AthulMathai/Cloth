// Fire-and-forget analytics events. Event types are open-ended strings
// (validated server-side: lowercase snake_case), properties are JSON.
import { db } from './supabase.js';

function sessionId() {
  try {
    let id = sessionStorage.getItem('th8rty.sid');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('th8rty.sid', id); }
    return id;
  } catch { return 'no-storage'; }
}

// First page view of a session records where the visit came from and the
// device class — no fingerprinting, no third-party scripts.
function landing() {
  try {
    if (sessionStorage.getItem('th8rty.landed')) return null;
    sessionStorage.setItem('th8rty.landed', '1');
  } catch { return null; }
  const q = new URLSearchParams(location.search);
  let ref = '';
  try { const r = document.referrer && new URL(document.referrer); ref = r && r.hostname !== location.hostname ? r.hostname.replace(/^www\./, '') : ''; } catch {}
  const w = window.innerWidth;
  return { landing: true, source: (q.get('utm_source') || ref || 'direct').slice(0, 60), medium: q.get('utm_medium')?.slice(0, 40) || undefined,
           campaign: q.get('utm_campaign')?.slice(0, 60) || undefined, device: w < 768 ? 'mobile' : w < 1100 ? 'tablet' : 'desktop' };
}

export function track(eventType, { path = location.pathname, entity_type = null, entity_id = null, ...properties } = {}) {
  if (eventType === 'page_view') Object.assign(properties, landing() || {});
  db.rpc('track_event', {
    p_event_type: eventType, p_session_id: sessionId(), p_path: path,
    p_entity_type: entity_type || null, p_entity_id: entity_id || null, p_properties: properties,
  }).catch(() => { /* analytics must never break the store */ });
}
