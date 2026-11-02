// Minimal tag readers: ID3v2 (MP3/AAC) and iTunes-style MP4 atoms (M4A). Returns {title, artist, album, picture: Blob|null}.
'use strict';

const Tags = (() => {
  const td = (label) => { try { return new TextDecoder(label); } catch { return new TextDecoder('utf-8'); } };
  const latin1 = td('latin1'), utf8 = td('utf-8'), utf16le = td('utf-16le'), utf16be = td('utf-16be');

  const clean = (s) => (s || '').replace(/\u0000+$/g, '').replace(/^﻿/, '').trim();

  function decodeText(bytes, enc) {
    if (enc === 0) return clean(latin1.decode(bytes));
    if (enc === 3) return clean(utf8.decode(bytes));
    if (enc === 1) { // UTF-16 with BOM
      if (bytes[0] === 0xFE && bytes[1] === 0xFF) return clean(utf16be.decode(bytes.subarray(2)));
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) return clean(utf16le.decode(bytes.subarray(2)));
      return clean(utf16le.decode(bytes));
    }
    if (enc === 2) return clean(utf16be.decode(bytes));
    return clean(utf8.decode(bytes));
  }

  // Index of the encoding-appropriate string terminator.
  function findTerminator(bytes, start, enc) {
    if (enc === 1 || enc === 2) {
      for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
      return bytes.length;
    }
    const i = bytes.indexOf(0, start);
    return i < 0 ? bytes.length : i;
  }

  const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

  async function readID3(file) {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null; // "ID3"
    const ver = head[3];
    const size = synchsafe(head, 6);
    const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    const out = { title: '', artist: '', album: '', picture: null };
    let o = 0;
    if (head[5] & 0x40 && ver >= 3) o += ver === 4 ? synchsafe(buf, 0) : u32(buf, 0) + 4; // extended header

    const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
    while (o + hdrLen <= buf.length) {
      const id = String.fromCharCode(...buf.subarray(o, o + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break;
      let fsize = ver === 2 ? (buf[o + 3] << 16) | (buf[o + 4] << 8) | buf[o + 5]
                : ver === 4 ? synchsafe(buf, o + 4) : u32(buf, o + 4);
      const body = buf.subarray(o + hdrLen, o + hdrLen + fsize);
      o += hdrLen + fsize;
      if (!fsize || !body.length) continue;
      const enc = body[0];
      switch (id) {
        case 'TIT2': case 'TT2': out.title = decodeText(body.subarray(1), enc); break;
        case 'TPE1': case 'TP1': out.artist = decodeText(body.subarray(1), enc); break;
        case 'TALB': case 'TAL': out.album = decodeText(body.subarray(1), enc); break;
        case 'APIC': case 'PIC': {
          if (out.picture) break;
          let p = 1, mime;
          if (id === 'PIC') { mime = 'image/' + latin1.decode(body.subarray(1, 4)).toLowerCase().replace('jpg', 'jpeg'); p = 4; }
          else { const e = body.indexOf(0, 1); mime = latin1.decode(body.subarray(1, e)) || 'image/jpeg'; p = e + 1; }
          p += 1; // picture type
          const d = findTerminator(body, p, enc);
          p = d + (enc === 1 || enc === 2 ? 2 : 1);
          if (mime && !mime.includes('/')) mime = 'image/' + mime;
          out.picture = new Blob([body.slice(p)], { type: mime || 'image/jpeg' });
          break;
        }
      }
    }
    return out;
  }

  async function readMP4(file) {
    // Find the top-level 'moov' atom (may sit at the start or the end of the file).
    let off = 0, moov = null;
    for (let guard = 0; off + 8 <= file.size && guard < 64; guard++) {
      const h = new Uint8Array(await file.slice(off, off + 16).arrayBuffer());
      let size = u32(h, 0);
      const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
      if (size === 1) size = u32(h, 8) * 4294967296 + u32(h, 12);
      if (size === 0) size = file.size - off;
      if (size < 8) break;
      if (type === 'moov') { moov = new Uint8Array(await file.slice(off, off + Math.min(size, 32 * 1024 * 1024)).arrayBuffer()); break; }
      off += size;
    }
    if (!moov) return null;
    const out = { title: '', artist: '', album: '', picture: null };

    const walk = (b, start, end, path) => {
      let p = start;
      while (p + 8 <= end) {
        const size = u32(b, p);
        const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
        if (size < 8 || p + size > end) break;
        if (type === 'udta' || type === 'ilst' || type === 'moov') walk(b, p + 8, p + size, path + '/' + type);
        else if (type === 'meta') walk(b, p + 12, p + size, path + '/meta'); // full box: 4 bytes version/flags
        else if (path.endsWith('/ilst')) {
          // item → 'data' atom: size(4) 'data'(4) type(4) locale(4) payload
          const d = p + 8;
          if (u32(b, d + 4) === 0x64617461 /* data */) {
            const dsize = u32(b, d), dtype = u32(b, d + 8) & 0xffffff;
            const payload = b.subarray(d + 16, d + dsize);
            if (type === '©nam') out.title = clean(utf8.decode(payload));
            else if (type === '©ART' || type === 'aART') out.artist = out.artist || clean(utf8.decode(payload));
            else if (type === '©alb') out.album = clean(utf8.decode(payload));
            else if (type === 'covr' && !out.picture) out.picture = new Blob([payload.slice()], { type: dtype === 14 ? 'image/png' : 'image/jpeg' });
          }
        }
        p += size;
      }
    };
    walk(moov, 8, moov.length, '/moov');
    return out;
  }

  async function read(file) {
    try {
      const id3 = await readID3(file);
      if (id3) return id3;
      const name = (file.name || '').toLowerCase();
      if (/\.(m4a|m4b|mp4|aac|alac|mov)$/.test(name) || /mp4|m4a/.test(file.type)) return (await readMP4(file)) || {};
    } catch (e) { console.warn('tag read failed', e); }
    return {};
  }

  return { read };
})();
