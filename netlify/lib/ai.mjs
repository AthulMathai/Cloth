// AI provider adapter. Everything AI-related on the server goes through
// here so the provider can be swapped with environment variables only.
//
//   cloudflare  Cloudflare Workers AI (free daily allowance). Used when
//               CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN are set.
//   mock        Development adapter: draws a labelled test pattern, makes
//               deterministic word-hash embeddings and fixed captions.
//               The UI says "Test mode" whenever this is in use.
//
// AI_PROVIDER forces one of the above. Models can be changed with
// AI_IMAGE_MODEL, AI_EMBED_MODEL and AI_VISION_MODEL.
import { deflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const CF = 'https://api.cloudflare.com/client/v4/accounts';
const DIMS = 384;   // product_embeddings.embedding is vector(384)

export function provider() {
  const forced = (process.env.AI_PROVIDER || '').toLowerCase();
  if (forced === 'mock') return 'mock';
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN) return 'cloudflare';
  return 'mock';
}
export const isTestMode = () => provider() === 'mock';

export const models = () => provider() === 'mock'
  ? { image: 'mock-pattern', embed: 'mock-hash-384', vision: 'mock-caption' }
  : {
      image: process.env.AI_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell',
      embed: process.env.AI_EMBED_MODEL || '@cf/baai/bge-small-en-v1.5',
      vision: process.env.AI_VISION_MODEL || '@cf/llava-hf/llava-1.5-7b-hf',
    };

async function cfRun(model, body, { timeoutMs = 60_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CF}/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_AI_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(res.status === 429 ? 'The free AI allowance is used up for today.' : `AI provider error (${res.status})`);
      err.status = res.status; err.detail = text.slice(0, 500);
      throw err;
    }
    if (type.startsWith('image/')) return { binary: new Uint8Array(await res.arrayBuffer()), type };
    const data = await res.json();
    if (data && data.success === false) throw Object.assign(new Error('AI provider error'), { detail: JSON.stringify(data.errors || []).slice(0, 500) });
    return data?.result ?? data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The AI provider took too long. Try again.');
    throw e;
  } finally { clearTimeout(timer); }
}

const STYLE_HINTS = {
  none: '',
  illustration: 'bold vector illustration, clean outlines, flat colours',
  anime: 'anime style illustration, cel shading, dynamic linework',
  streetwear: 'streetwear graphic, gritty screen-print texture, bold shapes',
  minimal: 'minimal line art, single colour, lots of negative space',
  vintage: 'vintage distressed print, retro palette, halftone texture',
  photo: 'photographic, dramatic studio lighting',
};
export const STYLES = Object.keys(STYLE_HINTS);

/** Wraps the customer's words so the result works as a garment print. */
export function printPrompt(prompt, style) {
  const hint = STYLE_HINTS[style] || '';
  return [prompt.trim(), hint, 'isolated graphic centred on a plain solid white background, t-shirt print design, no text unless asked, no watermark, no mockup, no garment']
    .filter(Boolean).join(', ');
}

/** -> { bytes: Uint8Array, mime, width, height, model } */
export async function generateImage(prompt, style = 'none') {
  const m = models();
  if (provider() === 'mock') {
    const { bytes, width, height } = mockPattern(prompt + '|' + style);
    return { bytes, mime: 'image/png', width, height, model: m.image };
  }
  // Netlify ends synchronous functions after ~10 s, so keep the step count low
  // (FLUX schnell is built for 4 steps) and stop waiting before the platform does.
  const out = await cfRun(m.image, { prompt: printPrompt(prompt, style), steps: 4 }, { timeoutMs: 8_500 });
  let bytes, mime;
  if (out?.binary) { bytes = out.binary; mime = out.type; }
  else if (typeof out?.image === 'string') { bytes = Uint8Array.from(Buffer.from(out.image, 'base64')); mime = sniffMime(bytes); }
  else throw new Error('The AI provider returned no image.');
  const size = imageSize(bytes) || { width: 1024, height: 1024 };
  return { bytes, mime: mime || sniffMime(bytes), ...size, model: m.image };
}

/** texts: string[] -> number[][] (unit length, 384 dims) */
export async function embed(texts) {
  if (!texts.length) return [];
  if (provider() === 'mock') return texts.map(hashEmbed);
  const out = await cfRun(models().embed, { text: texts }, { timeoutMs: 8_000 });
  const data = out?.data;
  if (!Array.isArray(data) || data.length !== texts.length || data[0]?.length !== DIMS) {
    throw new Error(`Embedding model must return ${DIMS} numbers per text.`);
  }
  return data.map(normalize);
}

/** Short plain description of an image, for the moderation queue. */
export async function describeImage(bytes) {
  if (provider() === 'mock') return null;   // nothing pretended in test mode
  const out = await cfRun(models().vision, {
    image: [...bytes],
    prompt: 'Describe this image in one or two sentences. Mention any visible text, logos, brand names, famous characters or real people, nudity, weapons, blood or hate symbols.',
    max_tokens: 120,
  }, { timeoutMs: 6_000 });
  const text = out?.description || out?.response || '';
  return String(text).trim().slice(0, 600) || null;
}

// ---------------------------------------------------------------------
// Prompt screening (before anything is generated)
// ---------------------------------------------------------------------
// Words that are never generated, whatever the staff term list says.
const BLOCKED = [
  ['explicit', /\b(nude|naked|nsfw|porn\w*|sex|sexual|topless|genitals?|hentai|fetish|erotic)\b/i],
  ['minors', /\b(child|kid|teen|minor|loli|schoolgirl)s?\b.*\b(sexy|nude|naked|lingerie)\b|\b(sexy|nude|naked|lingerie)\b.*\b(child|kid|teen|minor|loli|schoolgirl)s?\b/i],
  ['hate', /\b(swastika|nazi|kkk|white power|sieg heil|1488|isis flag|confederate flag)\b/i],
  ['violence', /\b(gore|gory|beheading|decapitat\w*|dismember\w*|mutilat\w*|corpse|school shooting|mass shooting)\b/i],
  ['likeness', /\b(photo|portrait|face|picture) of (a |the )?(real |famous )?(celebrity|president|prime minister|politician)\b/i],
  ['counterfeit', /\b(logo|official|authentic|replica|fake)\b.*\b(brand|jersey|merch)\b/i],
];

/** -> null (fine) or { category, message } */
export function screenPrompt(prompt, terms = []) {
  const text = prompt.normalize('NFKC');
  for (const [category, re] of BLOCKED) {
    if (re.test(text)) return { category, message: 'That description asks for something we can\'t print. Try describing your own idea instead.' };
  }
  for (const t of terms) {
    const re = new RegExp(`(^|[^a-z0-9])${t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]*')}($|[^a-z0-9])`, 'i');
    if (re.test(text)) {
      return { category: t.category, message: `"${t.term}" is someone else's ${t.category === 'character' ? 'character' : t.category === 'sports' ? 'team or league' : 'brand'}, so we can't generate it. Describe an original idea instead.` };
    }
  }
  return null;
}

/** Words in an image caption that send a design to a person. */
const RISKY_CAPTION = /\b(logo|brand|trademark|mickey|pikachu|batman|superman|spider-?man|nude|naked|topless|blood|gore|gun|rifle|weapon|swastika|nazi|celebrity|famous|president)\b/i;
export const captionLooksRisky = (caption) => RISKY_CAPTION.test(caption || '');

// ---------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const STOP = new Set('a an and the of for with to in on at by or is are be my our your this that it its from as into'.split(' '));
function tokens(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));
}

/** Deterministic bag-of-words vector: similar wording → similar vectors. */
export function hashEmbed(text) {
  const v = new Array(DIMS).fill(0);
  const words = tokens(text);
  for (const w of words) {
    const stem = w.length > 4 ? w.replace(/(ing|ers|ies|es|s)$/, '') : w;
    for (const [tok, weight] of [[stem, 1], [stem.slice(0, 4), 0.35]]) {
      const h = hashStr(tok);
      v[h % DIMS] += (h & 1 ? 1 : -1) * weight;
      v[(h >>> 9) % DIMS] += ((h >>> 1) & 1 ? 1 : -1) * weight * 0.5;
    }
  }
  return normalize(v);
}

function normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => Math.round((x / n) * 1e6) / 1e6);
}

export const toVectorLiteral = (v) => `[${v.join(',')}]`;

/** A seeded geometric test emblem on a transparent background (PNG). */
export function mockPattern(seed, size = 768) {
  let s = hashStr(seed) || 1;
  const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
  const hue = rnd() * 360, hue2 = (hue + 120 + rnd() * 120) % 360;
  const c1 = hsl(hue, 0.75, 0.55), c2 = hsl(hue2, 0.8, 0.5), ink = [20, 20, 24];
  const points = 3 + Math.floor(rnd() * 5), rot = rnd() * Math.PI, rings = 2 + Math.floor(rnd() * 3);
  const px = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2, R = size * 0.44;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    px[row] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx) + rot;
      // star outline radius at this angle
      const k = Math.cos(points * a);
      const star = R * (0.62 + 0.3 * k);
      let col = null;
      if (d < star) {
        const band = Math.floor((d / star) * rings * 2);
        col = band % 2 ? c1 : c2;
        if (Math.abs(d - star) < 6) col = ink;
      } else if (Math.abs(d - R) < 5) col = ink;
      // "TEST" stripe so a mock image can never be mistaken for real output
      if (Math.abs(dy) < 18 && Math.abs(dx) < R * 0.9 && ((x >> 4) + (y >> 4)) % 2 === 0) col = ink;
      const o = row + 1 + x * 4;
      if (col) { px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255; }
    }
  }
  return { bytes: encodePng(size, size, px), width: size, height: size };
}

function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function encodePng(w, h, raw) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

export function sniffMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  return null;
}

function imageSize(b) {
  const mime = sniffMime(b);
  if (mime === 'image/png') return { width: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, height: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}
