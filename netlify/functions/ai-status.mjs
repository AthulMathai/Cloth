// GET /api/ai-status — which AI provider is connected (no secrets).
// The designer and admin use it to label test mode honestly.
import { json } from '../lib/http.mjs';
import { provider, models, isTestMode } from '../lib/ai.mjs';

export default async () => json(200, { provider: provider(), test_mode: isTestMode(), models: models() },
  { 'Cache-Control': 'public, max-age=300' });
