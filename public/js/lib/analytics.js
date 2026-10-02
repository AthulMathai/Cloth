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

export function track(eventType, { path = location.pathname, entity_type = null, entity_id = null, ...properties } = {}) {
  db.rpc('track_event', {
    p_event_type: eventType, p_session_id: sessionId(), p_path: path,
    p_entity_type: entity_type || null, p_entity_id: entity_id || null, p_properties: properties,
  }).catch(() => { /* analytics must never break the store */ });
}
