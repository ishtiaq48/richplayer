// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const Tags = new Function(readFileSync(new URL('./tags.js', import.meta.url), 'utf8') + '; return Tags;')();
const enc = (s) => [...Buffer.from(s, 'latin1')];
const u32 = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];

function id3v23() {
  const frame = (id, body) => [...enc(id), ...u32(body.length), 0, 0, ...body];
  const frames = [
    ...frame('TIT2', [0, ...enc('Night Drive')]),
    ...frame('TPE1', [1, 0xff, 0xfe, ...[...Buffer.from('Arijit', 'utf16le')]]),   // UTF-16 with BOM
    ...frame('TALB', [3, ...[...Buffer.from('Album ✓', 'utf8')]]),
    ...frame('APIC', [0, ...enc('image/jpeg'), 0, 3, 0, ...JPEG]),
  ];
  const n = frames.length, size = [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]; // synchsafe
  return new Uint8Array([...enc('ID3'), 3, 0, 0, ...size, ...frames, 0xff, 0xfb, 0x90, 0x00]);
}

function m4a() {
  const atom = (type, ...kids) => { const body = kids.flat(); return [...u32(8 + body.length), ...enc(type), ...body]; };
  const data = (type, bytes) => atom('data', u32(type), u32(0), bytes);
  const ilst = atom('ilst',
    atom('©nam', data(1, [...Buffer.from('Tum Hi Ho', 'utf8')])),
    atom('©ART', data(1, [...Buffer.from('Mithoon', 'utf8')])),
    atom('covr', data(13, JPEG)));
  const meta = [...u32(8 + 4 + ilst.length), ...enc('meta'), 0, 0, 0, 0, ...ilst];   // full box
  return new Uint8Array([...atom('ftyp', enc('M4A '), u32(0)), ...atom('moov', atom('udta', meta)), ...atom('mdat', [0, 0])]);
}

test('reads ID3v2.3 title, UTF-16 artist, UTF-8 album and cover', async () => {
  const t = await Tags.read(new File([id3v23()], 'song.mp3'));
  assert.equal(t.title, 'Night Drive');
  assert.equal(t.artist, 'Arijit');
  assert.equal(t.album, 'Album ✓');
  assert.equal(t.picture.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await t.picture.arrayBuffer())], JPEG);
});

test('reads M4A ilst title, artist and cover', async () => {
  const t = await Tags.read(new File([m4a()], 'song.m4a'));
  assert.equal(t.title, 'Tum Hi Ho');
  assert.equal(t.artist, 'Mithoon');
  assert.deepEqual([...new Uint8Array(await t.picture.arrayBuffer())], JPEG);
});

test('untagged or garbage files return no tags instead of throwing', async () => {
  assert.deepEqual(await Tags.read(new File([new Uint8Array([1, 2, 3])], 'x.mp3')), {});
  assert.deepEqual(await Tags.read(new File([new Uint8Array(4)], 'x.m4a')), {});
});
