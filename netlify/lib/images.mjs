// Identify an image from its real bytes (not the file name or the browser's
// claimed MIME type) and read its pixel dimensions.
export function sniffImage(buf) {
  const b = new Uint8Array(buf);
  const u32be = (o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  const u16be = (o) => b[o] << 8 | b[o + 1];
  const u16le = (o) => b[o] | b[o + 1] << 8;
  const u24le = (o) => b[o] | b[o + 1] << 8 | b[o + 2] << 16;
  const ascii = (o, n) => String.fromCharCode(...b.slice(o, o + n));

  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    return { mime: 'image/png', width: u32be(16), height: u32be(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = u16be(o + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) {
        return { mime: 'image/jpeg', height: u16be(o + 5), width: u16be(o + 7) };
      }
      o += 2 + len;
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24;
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mime: 'image/webp', width: null, height: null };
  }
  const head = new TextDecoder().decode(b.slice(0, 1024)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { mime: 'image/svg+xml', width: null, height: null };
  }
  return null;
}

// SVGs can carry scripts and external references; only plain drawings pass.
export function svgProblems(text) {
  const t = text.toLowerCase();
  const issues = [];
  if (/<script[\s>]/.test(t)) issues.push('contains a script');
  if (/\son[a-z]+\s*=/.test(t)) issues.push('contains event handlers');
  if (/javascript:/.test(t)) issues.push('contains a javascript: link');
  if (/<foreignobject[\s>]/.test(t)) issues.push('embeds HTML');
  if (/(xlink:)?href\s*=\s*["'](?!#|data:image\/)/.test(t)) issues.push('loads external files');
  if (/<!entity/.test(t)) issues.push('declares XML entities');
  return issues;
}
