// Automated design checks. The rules here are real (file verification,
// unsafe SVG, resolution, a staff-editable term list). Image *content*
// classification (nudity, violence, logos, likeness) needs a vision
// provider; until MODERATION_PROVIDER is set to one, this adapter is
// labelled "mock" and — in live mode — sends every image to a human.
import { sniffImage, svgProblems } from './images.mjs';

const MAX_SVG = 2 * 1024 * 1024;

export function providerName() {
  return (process.env.MODERATION_PROVIDER || 'mock').toLowerCase();
}

/**
 * design: custom_designs row; assets: design_assets rows used by the design;
 * terms: moderation_terms rows; fetchBytes(asset, range?) -> ArrayBuffer|null
 */
export async function moderateDesign({ design, assets, terms, fetchBytes, live }) {
  const findings = [];
  const add = (severity, category, message, extra = {}) => findings.push({ severity, category, message, ...extra });
  const verified = [];

  for (const a of assets) {
    const head = await fetchBytes(a, a.mime === 'image/svg+xml' ? null : 65535);
    if (!head) { add('block', 'file', `"${a.original_name || 'artwork'}" couldn't be found. Upload it again.`); continue; }
    const kind = sniffImage(head);
    if (!kind) { add('block', 'file', `"${a.original_name || 'artwork'}" isn't a valid PNG, JPG, WebP or SVG image.`); continue; }
    if (kind.mime !== a.mime) {
      add('block', 'file', `"${a.original_name || 'artwork'}" is really a ${kind.mime.split('/')[1].toUpperCase()} file, not ${a.mime.split('/')[1].toUpperCase()}.`);
      continue;
    }
    if (kind.mime === 'image/svg+xml') {
      if (head.byteLength > MAX_SVG) { add('block', 'file', 'SVG files must be under 2 MB.'); continue; }
      const issues = svgProblems(new TextDecoder().decode(head));
      if (issues.length) { add('block', 'file', `The SVG ${issues.join(' and ')}, so it can't be printed. Export it again as a plain drawing or PNG.`); continue; }
    } else if (kind.width && kind.height) {
      if (a.width_px && (Math.abs(kind.width - a.width_px) > 1 || Math.abs(kind.height - a.height_px) > 1)) {
        add('info', 'file', 'Image size reported by the browser didn\'t match the file; the file\'s real size was used.');
      }
      a.width_px = kind.width; a.height_px = kind.height;
    }
    verified.push(a.id);
  }

  // Resolution at the printed size
  for (const l of design.config.layers || []) {
    if (l.type !== 'image') continue;
    const a = assets.find(x => x.id === l.asset_id);
    if (!a || !a.width_px || a.mime === 'image/svg+xml') continue;
    const dpi = Math.min(a.width_px / l.w_in, a.height_px / l.h_in);
    if (dpi < 90) add('warn', 'quality', `Artwork on the ${label(l.placement)} is ${Math.round(dpi)} DPI at that size and will print blurry. Use a larger image or make it smaller.`);
    else if (dpi < 150) add('info', 'quality', `Artwork on the ${label(l.placement)} is ${Math.round(dpi)} DPI at that size; edges may look soft.`);
  }

  // Term list: design name, file names, text layers (stand-in for OCR)
  const haystacks = [
    ['design name', design.name],
    ...assets.map(a => ['file name', a.original_name || '']),
    ...(design.config.layers || []).filter(l => l.type === 'text').map(l => ['text', l.text || '']),
  ];
  for (const term of terms) {
    const re = new RegExp(`(^|[^a-z0-9])${term.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]*')}($|[^a-z0-9])`, 'i');
    const hit = haystacks.find(([, text]) => re.test(text));
    if (hit) {
      add(term.action === 'reject' ? 'block' : 'review', term.category,
        term.category === 'hate' || term.category === 'explicit' || term.category === 'violence'
          ? `The ${hit[0]} may contain prohibited content and needs a person to review it.`
          : `The ${hit[0]} may contain protected material (${term.category}) and needs a person to review it.`,
        { term: term.term });
    }
  }

  const hasImages = (design.config.layers || []).some(l => l.type === 'image');
  if (hasImages) {
    if (live) add('review', 'content', 'Images are checked by a person before printing.');
    else add('info', 'content', 'Image content wasn\'t scanned automatically (development moderation adapter).');
  }

  const blocks = findings.filter(f => f.severity === 'block').length;
  const reviews = findings.filter(f => f.severity === 'review').length;
  const warns = findings.filter(f => f.severity === 'warn').length;
  const score = Math.min(100, blocks * 60 + reviews * 35 + warns * 10);
  const decision = blocks ? 'rejected' : reviews ? 'needs_review' : 'approved';
  return { provider: providerName(), decision, score, findings, verified };
}

const LABELS = { front: 'front', back: 'back', left_chest: 'left chest', left_sleeve: 'left sleeve', right_sleeve: 'right sleeve' };
const label = (p) => LABELS[p] || p;
