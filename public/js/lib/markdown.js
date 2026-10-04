// Tiny, safe Markdown subset for staff-written pages (legal pages):
// ## headings, - lists, **bold**, *italic*, [text](https://link), blank-line
// paragraphs. Everything is escaped first, so no HTML can be injected.
// [[placeholders]] are highlighted so unfinished drafts are obvious.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/\[\[([^\]]+)\]\]/g, '<mark class="md-todo">$1</mark>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2">$1</a>');
}

export function markdown(src = '') {
  const out = [];
  for (const block of String(src).trim().split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (/^#{2,3}\s/.test(lines[0]) && lines.length === 1) {
      const level = lines[0].startsWith('###') ? 3 : 2;
      out.push(`<h${level}>${inline(lines[0].replace(/^#+\s*/, ''))}</h${level}>`);
    } else if (/^#{2,3}\s/.test(lines[0])) {
      const level = lines[0].startsWith('###') ? 3 : 2;
      out.push(`<h${level}>${inline(lines[0].replace(/^#+\s*/, ''))}</h${level}>`, ...renderLines(lines.slice(1)));
    } else out.push(...renderLines(lines));
  }
  return out.join('\n');
}

function renderLines(lines) {
  if (!lines.length) return [];
  if (lines.every(l => /^\s*[-*]\s+/.test(l))) return [`<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`];
  return [`<p>${lines.map(inline).join('<br>')}</p>`];
}

export const hasPlaceholders = (src) => /\[\[[^\]]+\]\]/.test(src || '');
