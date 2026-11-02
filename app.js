'use strict';
/* RichPlayer Web — offline music player PWA. Everything is stored on-device in IndexedDB. */

// ---------------------------------------------------------------- utils
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('rp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('rp.' + k, JSON.stringify(v)); } catch {} },
};
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------- IndexedDB
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('richplayer', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('tracks', { keyPath: 'id' });
        db.createObjectStore('playlists', { keyPath: 'id' });
        db.createObjectStore('files');
        db.createObjectStore('art');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(storeName, mode, fn) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(storeName, mode);
      const r = fn(tx.objectStore(storeName));
      tx.oncomplete = () => res(r && r.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  },
  all: (s) => DB.req(s, 'readonly', (o) => o.getAll()),
  get: (s, k) => DB.req(s, 'readonly', (o) => o.get(k)),
  put: (s, v, k) => DB.req(s, 'readwrite', (o) => (k === undefined ? o.put(v) : o.put(v, k))),
  del: (s, k) => DB.req(s, 'readwrite', (o) => o.delete(k)),
};

// ---------------------------------------------------------------- library
const L = { tracks: [], playlists: [], byId: new Map() };
const artURLs = new Map();

async function loadLibrary() {
  L.tracks = await DB.all('tracks');
  L.playlists = (await DB.all('playlists')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  L.byId = new Map(L.tracks.map((t) => [t.id, t]));
  await Promise.all(L.tracks.filter((t) => t.hasArt).map(async (t) => {
    const b = await DB.get('art', t.id);
    if (b) artURLs.set(t.id, URL.createObjectURL(b));
  }));
}
const T = (id) => L.byId.get(id);
const artSrc = (id) => artURLs.get(id) || PLACEHOLDER;
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff2d6f"/><stop offset="1" stop-color="#7a1cf0"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><path d="M40 68V32l28-5v34" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round" opacity=".9"/><circle cx="33" cy="68" r="8" fill="#fff" opacity=".9"/><circle cx="61" cy="62" r="8" fill="#fff" opacity=".9"/></svg>');

const saveTrack = (t) => { L.byId.set(t.id, t); return DB.put('tracks', t); };
const savePlaylist = (p) => DB.put('playlists', p);

const SORTS = { title: 'Title', artist: 'Artist', album: 'Album', added: 'Recently Added', duration: 'Duration', plays: 'Most Played' };
function sortTracks(list, by) {
  const c = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const l = [...list];
  switch (by) {
    case 'artist': return l.sort((a, b) => c(a.artist, b.artist) || c(a.title, b.title));
    case 'album': return l.sort((a, b) => c(a.album, b.album) || c(a.title, b.title));
    case 'added': return l.sort((a, b) => b.addedAt - a.addedAt);
    case 'duration': return l.sort((a, b) => b.duration - a.duration);
    case 'plays': return l.sort((a, b) => b.playCount - a.playCount);
    default: return l.sort((a, b) => c(a.title, b.title));
  }
}
const smart = {
  favorites: { name: 'Favorites', icon: 'i-heart-fill', color: '#ff2d6f', get: () => sortTracks(L.tracks.filter((t) => t.fav), 'title') },
  recent: { name: 'Recently Added', icon: 'i-plus', color: '#ff9f0a', get: () => sortTracks(L.tracks, 'added').slice(0, 50) },
  played: { name: 'Recently Played', icon: 'i-play', color: '#0a84ff', get: () => L.tracks.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 50) },
  most: { name: 'Most Played', icon: 'i-wave', color: '#ff453a', get: () => L.tracks.filter((t) => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 50) },
};
const groupBy = (key) => {
  const m = new Map();
  for (const t of L.tracks) { const k = t[key] || 'Unknown'; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
};

// ---------------------------------------------------------------- import
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', ogg: 'audio/ogg', opus: 'audio/ogg', caf: 'audio/x-caf' };

function probeDuration(blob) {
  return new Promise((res) => {
    const a = new Audio(); const url = URL.createObjectURL(blob);
    const done = (d) => { URL.revokeObjectURL(url); a.removeAttribute('src'); res(isFinite(d) ? d : 0); };
    const timer = setTimeout(() => done(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { clearTimeout(timer); done(a.duration); };
    a.onerror = () => { clearTimeout(timer); done(0); };
    a.src = url;
  });
}

async function thumbnail(blob, size = 512) {
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const s = Math.max(size / bmp.width, size / bmp.height);
    const w = bmp.width * s, h = bmp.height * s;
    c.getContext('2d').drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch { return null; }
}

function titleFromName(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

async function importFiles(files) {
  files = [...files].filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|m4b|aac|wav|flac|aiff?|ogg|opus|caf)$/i.test(f.name));
  if (!files.length) return toast('No audio files selected');
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  let added = 0;
  for (const [i, f] of files.entries()) {
    toast(`Importing ${i + 1} of ${files.length}…`, 0);
    const dup = L.tracks.find((t) => t.name === f.name && t.size === f.size);
    if (dup) continue;
    try {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const blob = new Blob([f], { type: f.type || MIME[ext] || 'audio/mpeg' });
      const tags = await Tags.read(f);
      const guess = titleFromName(f.name);
      const id = uid();
      const t = {
        id, name: f.name, size: f.size, type: blob.type,
        title: tags.title || guess.title, artist: tags.artist || guess.artist || 'Unknown Artist', album: tags.album || 'Unknown Album',
        duration: await probeDuration(blob), addedAt: Date.now(), playCount: 0, lastPlayed: 0, fav: false, hasArt: false,
      };
      await DB.put('files', blob, id);
      if (tags.picture) {
        const thumb = await thumbnail(tags.picture);
        if (thumb) { await DB.put('art', thumb, id); t.hasArt = true; artURLs.set(id, URL.createObjectURL(thumb)); }
      }
      await saveTrack(t);
      L.tracks.push(t);
      added++;
    } catch (e) {
      console.error(e);
      toast(`Couldn't import ${f.name}${e && e.name === 'QuotaExceededError' ? ' — storage full' : ''}`, 3000);
    }
  }
  toast(added ? `Added ${plural(added, 'song')}` : 'Those songs are already in your library');
  render();
}

async function deleteTracks(ids) {
  ids = new Set(ids);
  for (const id of ids) {
    await DB.del('tracks', id); await DB.del('files', id); await DB.del('art', id);
    L.byId.delete(id);
    if (artURLs.has(id)) { URL.revokeObjectURL(artURLs.get(id)); artURLs.delete(id); }
  }
  L.tracks = L.tracks.filter((t) => !ids.has(t.id));
  for (const p of L.playlists) {
    const n = p.trackIds.filter((id) => !ids.has(id));
    if (n.length !== p.trackIds.length) { p.trackIds = n; await savePlaylist(p); }
  }
  Player.removeIds(ids);
  render();
}

async function createPlaylist(name, trackIds = []) {
  const p = { id: uid(), name: name.trim() || 'New Playlist', trackIds: [...trackIds], createdAt: Date.now(), order: L.playlists.length };
  L.playlists.push(p); await savePlaylist(p);
  return p;
}
async function addToPlaylist(pid, ids) {
  const p = L.playlists.find((x) => x.id === pid); if (!p) return;
  let n = 0;
  for (const id of ids) if (!p.trackIds.includes(id)) { p.trackIds.push(id); n++; }
  await savePlaylist(p);
  toast(n ? `Added to “${p.name}”` : 'Already in playlist');
}

// ---------------------------------------------------------------- equalizer (Web Audio)
const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_LABELS = ['32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
const PRESETS = {
  'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'Bass Boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], 'Treble Boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Vocal': [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1], 'Rock': [5, 4, 2, 0, -1, -1, 1, 3, 4, 5], 'Pop': [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  'Jazz': [3, 2, 1, 2, -1, -1, 0, 1, 2, 3], 'Classical': [4, 3, 2, 1, -1, -1, 0, 2, 3, 4], 'Electronic': [5, 4, 1, 0, -2, 2, 1, 2, 4, 5],
  'Hip-Hop': [6, 5, 2, 3, -1, -1, 1, 0, 2, 3], 'Loudness': [5, 3, 0, 0, -1, 0, -1, -3, 4, 2],
};
const EQ = {
  enabled: store.get('eqOn', false), gains: store.get('eqGains', PRESETS.Flat.slice()), preamp: store.get('preamp', 0),
  ctx: null, filters: [], pre: null,
  // The element is routed through Web Audio only once EQ is first switched on (Safari can't un-route it).
  ensure() {
    if (this.ctx || !this.enabled) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    this.ctx = new AC();
    const src = this.ctx.createMediaElementSource(audio);
    this.pre = this.ctx.createGain();
    this.filters = EQ_FREQS.map((f, i) => {
      const b = this.ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.1;
      return b;
    });
    [src, this.pre, ...this.filters].reduce((a, b) => (a.connect(b), b)).connect(this.ctx.destination);
    this.apply();
  },
  apply() {
    if (!this.ctx) return;
    this.filters.forEach((b, i) => (b.gain.value = this.enabled ? this.gains[i] : 0));
    this.pre.gain.value = this.enabled ? Math.pow(10, this.preamp / 20) : 1;
  },
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); },
  save() { store.set('eqOn', this.enabled); store.set('eqGains', this.gains); store.set('preamp', this.preamp); this.apply(); },
};

// ---------------------------------------------------------------- player
const audio = new Audio();
audio.setAttribute('playsinline', '');
audio.preload = 'auto';
let curURL = null;

const Player = {
  queue: [], orig: [], index: -1, shuffle: store.get('shuffle', false), repeat: store.get('repeat', 'off'),
  rate: store.get('rate', 1), sleepAt: 0, sleepEnd: false, sleepTimer: null, pendingResume: null, loadToken: 0,

  get current() { return T(this.queue[this.index]); },
  get playing() { return !audio.paused && !audio.ended; },

  async playList(ids, startId, shuffled = false) {
    if (!ids.length) return;
    this.orig = [...ids];
    if (shuffled) this.shuffle = true;
    let start = Math.max(0, startId ? ids.indexOf(startId) : 0);
    if (this.shuffle) {
      const first = shuffled && !startId ? ids[Math.floor(Math.random() * ids.length)] : ids[start];
      this.queue = [first, ...shuffle(ids.filter((x) => x !== first))];
      start = 0;
    } else this.queue = [...ids];
    store.set('shuffle', this.shuffle);
    await this.load(start, true);
  },

  async load(i, autoplay = true, startAt = 0) {
    if (i < 0 || i >= this.queue.length) return;
    const token = ++this.loadToken;
    this.index = i;
    this.pendingResume = null;
    const t = this.current;
    const blob = await DB.get('files', t.id);
    if (token !== this.loadToken) return;
    if (!blob) { toast(`Missing file: ${t.title}`); return this.next(true); }
    if (curURL) URL.revokeObjectURL(curURL);
    curURL = URL.createObjectURL(blob);
    audio.src = curURL;
    audio.defaultPlaybackRate = audio.playbackRate = this.rate;
    if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
    if (autoplay) {
      EQ.ensure(); EQ.resume();
      try { await audio.play(); } catch (e) { console.warn(e); }
      t.playCount++; t.lastPlayed = Date.now(); saveTrack(t);
    }
    updateMediaSession(); updateNow(); this.persist(); refreshCurrentRows();
  },

  toggle() {
    if (this.pendingResume) { const r = this.pendingResume; return this.load(r.index, true, r.time); }
    if (!this.current) return;
    if (audio.paused) { EQ.ensure(); EQ.resume(); audio.play().catch(() => {}); } else audio.pause();
  },
  play() { if (audio.paused) this.toggle(); },
  pause() { audio.pause(); },

  next(auto = false) {
    if (!this.queue.length) return;
    if (this.index + 1 < this.queue.length) return this.load(this.index + 1, true);
    if (this.repeat === 'all' || !auto) return this.load(0, this.repeat === 'all' || !auto ? true : false);
    audio.pause(); audio.currentTime = 0;
  },
  prev() {
    if (audio.currentTime > 3 || this.index <= 0) { audio.currentTime = 0; return; }
    this.load(this.index - 1, true);
  },
  seek(s) { if (isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(s, audio.duration - 0.1)); },
  skip(d) { this.seek(audio.currentTime + d); },

  toggleShuffle() {
    this.shuffle = !this.shuffle; store.set('shuffle', this.shuffle);
    const cur = this.queue[this.index];
    if (cur) {
      if (this.shuffle) { this.queue = [cur, ...shuffle(this.queue.filter((x) => x !== cur))]; this.index = 0; }
      else { this.queue = this.orig.length ? [...this.orig] : this.queue; this.index = Math.max(0, this.queue.indexOf(cur)); }
    }
    this.persist(); updateNow();
  },
  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    store.set('repeat', this.repeat); updateNow();
    toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[this.repeat], 1200);
  },
  setRate(r) { this.rate = r; audio.playbackRate = audio.defaultPlaybackRate = r; store.set('rate', r); updateNow(); },

  playNext(id) {
    if (!this.current) return this.playList([id]);
    this.queue.splice(this.index + 1, 0, id); this.orig.push(id); this.persist(); toast('Playing next');
  },
  addToQueue(ids) {
    if (!this.current) return this.playList(ids);
    this.queue.push(...ids); this.orig.push(...ids); this.persist(); toast(ids.length > 1 ? `Added ${ids.length} to queue` : 'Added to queue');
  },
  removeIds(ids) {
    const cur = this.queue[this.index];
    if (cur && ids.has(cur)) return this.close();
    this.queue = this.queue.filter((x) => !ids.has(x)); this.orig = this.orig.filter((x) => !ids.has(x));
    this.index = this.queue.indexOf(cur); this.persist();
  },
  close() {
    audio.pause(); audio.removeAttribute('src'); audio.load();
    if (curURL) { URL.revokeObjectURL(curURL); curURL = null; }
    this.queue = []; this.orig = []; this.index = -1; this.pendingResume = null;
    store.set('session', null);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    closeNowPlaying(); updateNow(); refreshCurrentRows();
  },

  setSleep(min) {
    clearTimeout(this.sleepTimer); this.sleepEnd = false; this.sleepAt = 0;
    if (min === 'end') { this.sleepEnd = true; toast('Will stop after this song'); }
    else if (min) {
      this.sleepAt = Date.now() + min * 60000;
      this.sleepTimer = setTimeout(() => { audio.pause(); this.sleepAt = 0; updateNow(); }, min * 60000);
      toast(`Sleep timer: ${min} min`);
    }
    updateNow();
  },

  persist() {
    if (!this.current) return;
    store.set('session', { queue: this.queue, orig: this.orig, index: this.index, time: audio.currentTime || 0 });
  },
  restore() {
    const s = store.get('session', null);
    if (!s || !s.queue?.length) return;
    const valid = s.queue.filter((id) => L.byId.has(id));
    if (!valid.length) return;
    const curId = s.queue[s.index];
    this.queue = valid; this.orig = (s.orig || valid).filter((id) => L.byId.has(id));
    this.index = Math.max(0, valid.indexOf(curId));
    this.pendingResume = { index: this.index, time: valid.includes(curId) ? s.time : 0 };
    updateNow();
  },
};
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

audio.addEventListener('ended', () => {
  if (Player.sleepEnd) { Player.sleepEnd = false; audio.currentTime = 0; updateNow(); return; }
  if (Player.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  Player.next(true);
});
audio.addEventListener('play', () => { updateNow(); setPlaybackState(); });
audio.addEventListener('pause', () => { updateNow(); setPlaybackState(); Player.persist(); });
audio.addEventListener('loadedmetadata', () => {
  const t = Player.current;
  if (t && isFinite(audio.duration) && Math.abs(t.duration - audio.duration) > 1) { t.duration = audio.duration; saveTrack(t); }
  updatePosition(); updateProgress();
});
audio.addEventListener('timeupdate', () => updateProgress());
audio.addEventListener('error', () => { if (Player.current && audio.src) toast(`Can't play “${Player.current.title}” (unsupported format)`, 3000); });
setInterval(() => { if (Player.playing) Player.persist(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) EQ.resume(); else Player.persist(); });

// Lock screen / Control Center / headphones
const artDataCache = new Map();
async function artDataURL(id) {
  if (artDataCache.has(id)) return artDataCache.get(id);
  const b = await DB.get('art', id); if (!b) return null;
  const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  artDataCache.set(id, url); return url;
}
async function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = Player.current; if (!t) return;
  const art = t.hasArt ? await artDataURL(t.id) : new URL('icons/icon-512.png', location.href).href;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album,
    artwork: art ? [{ src: art, sizes: '512x512', type: art.startsWith('data:image/png') || art.endsWith('.png') ? 'image/png' : 'image/jpeg' }] : [],
  });
}
function setPlaybackState() { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'; updatePosition(); }
function updatePosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !isFinite(audio.duration)) return;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  h('play', () => Player.play()); h('pause', () => Player.pause());
  h('previoustrack', () => Player.prev()); h('nexttrack', () => Player.next());
  h('seekto', (d) => { Player.seek(d.seekTime); updatePosition(); });
}

// ---------------------------------------------------------------- UI state & router
const UI = { tab: 'library', stack: [], seg: store.get('seg', 'songs'), sort: store.get('sort', 'title'), q: '', selecting: false, selected: new Set(), editing: false, ctx: {} };
const curView = () => UI.stack[UI.stack.length - 1] || { v: UI.tab };
function go(view) { UI.stack.push(view); UI.editing = false; render(); $('#view').scrollTop = 0; }
function back() { UI.stack.pop(); UI.editing = false; render(); }
function setTab(tab) {
  UI.tab = tab; UI.stack = []; UI.selecting = false; UI.selected.clear(); UI.editing = false;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render(); $('#view').scrollTop = 0;
}

function trackRows(list, ctxKey, opts = {}) {
  UI.ctx[ctxKey] = list.map((t) => t.id);
  const cur = Player.queue[Player.index];
  return `<div class="list">${list.map((t, i) => {
    const isCur = t.id === cur;
    const sel = UI.selecting && UI.selected.has(t.id);
    return `<div class="row ${isCur ? 'current' : ''} ${sel ? 'selected' : ''}" data-action="${opts.edit ? '' : UI.selecting && opts.selectable ? 'select' : 'play-from'}" data-id="${t.id}" data-ctx="${ctxKey}">
      ${UI.selecting && opts.selectable ? '<span class="check"></span>' : ''}
      <span class="art-wrap"><img class="art" src="${artSrc(t.id)}" alt="" loading="lazy">${isCur ? `<span class="playing ${Player.playing ? 'anim' : ''}">${icon('i-wave')}</span>` : ''}</span>
      <div class="meta"><div class="t1">${esc(t.title)}</div><div class="t2">${esc(t.artist)}</div></div>
      ${t.fav && !opts.edit ? icon('i-heart-fill', 'fav') : ''}
      ${opts.edit
        ? `<button class="more" data-action="pl-up" data-i="${i}">${icon('i-up', 'sm')}</button><button class="more" data-action="pl-down" data-i="${i}" style="transform:rotate(180deg)">${icon('i-up', 'sm')}</button><button class="more" data-action="pl-remove" data-i="${i}" style="color:#ff453a">${icon('i-trash', 'sm')}</button>`
        : `<span class="dur">${fmt(t.duration)}</span>${UI.selecting ? '' : `<button class="more" data-action="track-menu" data-id="${t.id}">${icon('i-more')}</button>`}`}
    </div>`;
  }).join('')}</div>`;
}
function refreshCurrentRows() { if (!$('#sheet').classList.contains('hidden') && $('#sheet').dataset.kind === 'add-songs') return; render(true); }

function playShuffle(ctxKey, count) {
  return `<div class="btn-row"><button class="btn" data-action="play-ctx" data-ctx="${ctxKey}" ${count ? '' : 'disabled'}>${icon('i-play')}Play</button>
    <button class="btn" data-action="shuffle-ctx" data-ctx="${ctxKey}" ${count ? '' : 'disabled'}>${icon('i-shuffle')}Shuffle</button></div>`;
}
function mosaic(ids, size, radius) {
  const arts = ids.filter((id) => artURLs.has(id)).slice(0, 4);
  if (arts.length < 4) return `<img class="art" style="width:${size}px;height:${size}px;border-radius:${radius}px" src="${arts[0] ? artSrc(arts[0]) : PLACEHOLDER}" alt="">`;
  return `<div class="mosaic" style="width:${size}px;height:${size}px;border-radius:${radius}px">${arts.map((id) => `<img src="${artSrc(id)}" alt="">`).join('')}</div>`;
}

// ---------------------------------------------------------------- views
const views = {
  library() {
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const installed = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    const songs = sortTracks(L.tracks.filter((t) => !UI.q || [t.title, t.artist, t.album].some((s) => s.toLowerCase().includes(UI.q.toLowerCase()))), UI.sort);
    let body;
    if (!L.tracks.length) {
      body = `<div class="empty">${icon('i-note')}<h3>No Music Yet</h3><div>Import MP3 or other audio files from the Files app. They're stored on this iPhone and play offline.</div>
        <button class="btn primary" data-action="import">${icon('i-plus')}Import Songs</button></div>`;
    } else if (UI.q || UI.seg === 'songs') {
      body = (UI.selecting ? '' : playShuffle('songs', songs.length)) + `<div id="songList">${trackRows(songs, 'songs', { selectable: true })}</div>`;
    } else if (UI.seg === 'albums') {
      body = `<div class="list">${groupBy('album').map(([name, ts]) => `<button class="row" data-action="open-group" data-key="album" data-name="${esc(name)}">
        <img class="art lg" src="${artSrc((ts.find((t) => t.hasArt) || ts[0]).id)}" alt=""><div class="meta"><div class="t1">${esc(name)}</div><div class="t2">${esc(ts[0].artist)} · ${plural(ts.length, 'song')}</div></div>${icon('i-back', 'chev')}</button>`).join('')}</div>`;
    } else {
      body = `<div class="list">${groupBy('artist').map(([name, ts]) => `<button class="row" data-action="open-group" data-key="artist" data-name="${esc(name)}">
        <img class="art round" src="${artSrc((ts.find((t) => t.hasArt) || ts[0]).id)}" alt=""><div class="meta"><div class="t1">${esc(name)}</div><div class="t2">${plural(ts.length, 'song')}</div></div>${icon('i-back', 'chev')}</button>`).join('')}</div>`;
    }
    return `<div class="page">
      <div class="topbar">${L.tracks.length ? `<button class="pill ${UI.selecting ? 'on' : ''}" data-action="select-mode">${UI.selecting ? 'Done' : 'Select'}</button>` : ''}<span class="spacer"></span>
        ${L.tracks.length ? `<button class="circle-btn" data-action="sort">${icon('i-sort')}</button>` : ''}
        <button class="circle-btn" data-action="import">${icon('i-plus')}</button></div>
      <h1>Library</h1>
      ${isIOS && !installed ? `<div class="banner"><div><b>Install RichPlayer:</b> tap <b>Share</b> › <b>Add to Home Screen</b>. Install first, then import — Safari and the Home Screen app keep separate libraries.</div></div>` : ''}
      ${L.tracks.length ? `<label class="search">${icon('i-search')}<input id="q" type="search" placeholder="Songs, artists, albums" value="${esc(UI.q)}" autocomplete="off"></label>` : ''}
      ${L.tracks.length && !UI.q && !UI.selecting ? `<div class="cards">${Object.entries(smart).map(([k, s]) => `<button class="card" data-action="open-smart" data-key="${k}">
        <span style="color:${s.color}">${icon(s.icon)}</span><div class="t1">${s.name}</div><div class="t2">${plural(s.get().length, 'song')}</div></button>`).join('')}</div>
        <div class="segmented">${['songs', 'albums', 'artists'].map((s) => `<button class="${UI.seg === s ? 'active' : ''}" data-action="seg" data-seg="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>` : ''}
      ${body}
      ${UI.selecting ? `<div style="height:60px"></div>` : ''}
    </div>`;
  },

  group({ key, name }) {
    const ts = sortTracks(L.tracks.filter((t) => (t[key] || 'Unknown') === name), 'title');
    return listPage(name, ts, `${key}:${name}`, ts[0] && key === 'album' ? ts[0].artist : '');
  },
  smart({ key }) { return listPage(smart[key].name, smart[key].get(), 'smart:' + key); },

  playlists() {
    return `<div class="page"><div class="topbar"><span class="spacer"></span><button class="circle-btn" data-action="new-playlist">${icon('i-plus')}</button></div>
      <h1>Playlists</h1>
      <button class="row" data-action="new-playlist"><span class="art" style="display:grid;place-items:center;background:var(--card2);color:var(--accent)">${icon('i-plus')}</span><div class="meta"><div class="t1 accent">New Playlist</div></div></button>
      <div class="list">${L.playlists.map((p) => {
        const ts = p.trackIds.map(T).filter(Boolean);
        return `<button class="row" data-action="open-playlist" data-id="${p.id}">${mosaic(p.trackIds, 56, 8)}
          <div class="meta"><div class="t1">${esc(p.name)}</div><div class="t2">${plural(ts.length, 'song')} · ${fmt(ts.reduce((s, t) => s + t.duration, 0))}</div></div>${icon('i-back', 'chev')}</button>`;
      }).join('')}</div></div>`;
  },

  playlist({ id }) {
    const p = L.playlists.find((x) => x.id === id);
    if (!p) return `<div class="page"><button class="back" data-action="back">${icon('i-back')}Playlists</button><div class="empty">Playlist deleted</div></div>`;
    const ts = p.trackIds.map(T).filter(Boolean);
    return `<div class="page">
      <div class="topbar"><button class="back" data-action="back">${icon('i-back')}Playlists</button><span class="spacer"></span>
        <button class="pill ${UI.editing ? 'on' : ''}" data-action="pl-edit">${UI.editing ? 'Done' : 'Edit'}</button>
        <button class="circle-btn" data-action="pl-add" data-id="${id}">${icon('i-plus')}</button>
        <button class="circle-btn" data-action="pl-menu" data-id="${id}">${icon('i-more')}</button></div>
      <div class="center" style="display:flex;justify-content:center;margin:8px 0 10px">${mosaic(p.trackIds, 200, 22)}</div>
      <h2 class="center" style="margin:0">${esc(p.name)}</h2>
      <div class="center dim small" style="margin-top:4px">${plural(ts.length, 'song')} · ${fmt(ts.reduce((s, t) => s + t.duration, 0))}</div>
      ${playShuffle('pl:' + id, ts.length)}
      ${ts.length ? trackRows(ts, 'pl:' + id, { edit: UI.editing }) : `<div class="empty"><div>This playlist is empty.</div><button class="btn primary" data-action="pl-add" data-id="${id}">${icon('i-plus')}Add Songs</button></div>`}
    </div>`;
  },

  settings() {
    return `<div class="page"><div class="topbar"></div><h1>Settings</h1>
      <div class="group">
        <button class="item" data-action="eq"><span>Equalizer</span><span class="v">${EQ.enabled ? 'On' : 'Off'}</span></button>
        <button class="item" data-action="speed"><span>Playback Speed</span><span class="v">${Player.rate}x</span></button>
        <button class="item" data-action="sleep"><span>Sleep Timer</span><span class="v">${Player.sleepAt ? 'On' : Player.sleepEnd ? 'End of song' : 'Off'}</span></button>
        <button class="item" data-action="sort"><span>Sort Songs By</span><span class="v">${SORTS[UI.sort]}</span></button>
      </div>
      <h2>Library</h2>
      <div class="group">
        <div class="item"><span>Songs</span><span class="v">${L.tracks.length}</span></div>
        <div class="item"><span>Playlists</span><span class="v">${L.playlists.length}</span></div>
        <div class="item"><span>Storage used</span><span class="v" id="storageUsed">…</span></div>
        <div class="item"><span>Protected from cleanup</span><span class="v" id="persisted">…</span></div>
        <button class="item" data-action="import"><span class="accent">Import Songs</span></button>
        <button class="item danger" data-action="delete-all"><span>Delete All Songs</span></button>
      </div>
      <div class="foot">Songs are stored inside this app on your iPhone and play offline. Nothing is uploaded anywhere.</div>
      <h2>About</h2>
      <div class="group"><div class="item"><span>Version</span><span class="v">Web 1.0</span></div>
        <div class="item"><span>Privacy</span><span class="v">No tracking · No accounts</span></div></div>
    </div>`;
  },
};
function listPage(title, ts, ctxKey, sub = '') {
  return `<div class="page"><div class="topbar"><button class="back" data-action="back">${icon('i-back')}Back</button></div>
    <h1>${esc(title)}</h1>${sub ? `<div class="dim" style="margin:-6px 0 8px">${esc(sub)}</div>` : ''}
    ${playShuffle(ctxKey, ts.length)}${ts.length ? trackRows(ts, ctxKey) : '<div class="empty">No songs here yet.</div>'}</div>`;
}

function render(keepScroll = false) {
  const v = curView(), el = $('#view');
  const top = el.scrollTop;
  const focusQ = document.activeElement && document.activeElement.id === 'q';
  el.innerHTML = views[v.v](v);
  if (keepScroll) el.scrollTop = top;
  const q = $('#q');
  if (q) {
    q.addEventListener('input', () => { UI.q = q.value; $('#songList') ? ($('#songList').innerHTML = trackRows(filteredSongs(), 'songs', { selectable: true })) : render(); });
    if (focusQ) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }
  if (v.v === 'settings') fillStorage();
  document.body.classList.toggle('has-mini', !!Player.current);
  renderSelectionBar();
}
const filteredSongs = () => sortTracks(L.tracks.filter((t) => !UI.q || [t.title, t.artist, t.album].some((s) => s.toLowerCase().includes(UI.q.toLowerCase()))), UI.sort);

async function fillStorage() {
  try {
    const e = await navigator.storage.estimate();
    $('#storageUsed') && ($('#storageUsed').textContent = `${(e.usage / 1048576).toFixed(0)} MB`);
    const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('#persisted') && ($('#persisted').textContent = p ? 'Yes' : 'Not yet');
  } catch { $('#storageUsed') && ($('#storageUsed').textContent = '—'); }
}

function renderSelectionBar() {
  let bar = $('#selbar');
  if (!UI.selecting) { bar && bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'selbar'; document.body.appendChild(bar); }
  const n = UI.selected.size;
  bar.className = 'mini';
  bar.style.cssText = `z-index:22;justify-content:space-around;bottom:calc(var(--tabs-h) + var(--safe-bottom) + 8px)`;
  bar.innerHTML = `<button class="pill" data-action="sel-all">All</button>
    <button class="icon-btn ${n ? '' : 'dim'}" data-action="sel-queue" ${n ? '' : 'disabled'}>${icon('i-queue')}</button>
    <button class="icon-btn ${n ? '' : 'dim'}" data-action="sel-playlist" ${n ? '' : 'disabled'}>${icon('i-list')}</button>
    <button class="icon-btn ${n ? '' : 'dim'}" data-action="sel-delete" ${n ? '' : 'disabled'} style="${n ? 'color:#ff453a' : ''}">${icon('i-trash')}</button>
    <span class="small dim">${n} selected</span>`;
}

// ---------------------------------------------------------------- now playing & mini
function updateNow() {
  const t = Player.current;
  document.body.classList.toggle('has-mini', !!t);
  $('#mini').classList.toggle('hidden', !t);
  if (!t) return;
  const playing = Player.playing;
  const playIcon = playing ? '#i-pause' : '#i-play';
  $('#miniPlayIcon use').setAttribute('href', playIcon);
  $('#npPlayIcon use').setAttribute('href', playIcon);
  const art = artSrc(t.id);
  if ($('#miniArt').src !== art) { $('#miniArt').src = art; $('#npArt').src = art; $('#npBg').src = t.hasArt ? art : ''; }
  $('#miniTitle').textContent = t.title; $('#miniArtist').textContent = t.artist;
  $('#npTitle').textContent = t.title; $('#npArtist').textContent = t.artist;
  $('#npFavIcon use').setAttribute('href', t.fav ? '#i-heart-fill' : '#i-heart');
  $('#npFavIcon').style.color = t.fav ? 'var(--accent)' : '';
  $('#shuffleIcon').parentElement.classList.toggle('on', Player.shuffle);
  $('#repeatIcon use').setAttribute('href', Player.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  $('#repeatIcon').parentElement.classList.toggle('on', Player.repeat !== 'off');
  $('#speedBtn').textContent = `${Player.rate}x`;
  $('#speedBtn').classList.toggle('on', Player.rate !== 1);
  $('#sleepIcon use').setAttribute('href', Player.sleepAt || Player.sleepEnd ? '#i-moon-fill' : '#i-moon');
  $('#sleepIcon').parentElement.classList.toggle('on', !!(Player.sleepAt || Player.sleepEnd));
  $('#np').classList.toggle('paused', !playing);
  document.querySelectorAll('.row.current .playing').forEach((el) => el.classList.toggle('anim', playing));
  updateProgress();
}
let scrubbing = false;
function updateProgress() {
  const t = Player.current; if (!t) return;
  const dur = isFinite(audio.duration) && audio.duration ? audio.duration : t.duration;
  const cur = Player.pendingResume ? Player.pendingResume.time : audio.currentTime || 0;
  const p = dur ? Math.min(1, cur / dur) : 0;
  $('#miniBar').style.width = `${p * 100}%`;
  if (!scrubbing && !$('#np').classList.contains('hidden')) {
    const s = $('#seek'); s.value = Math.round(p * 1000); s.style.setProperty('--p', `${p * 100}%`);
    $('#tCur').textContent = fmt(cur); $('#tLeft').textContent = '-' + fmt(dur - cur);
  }
}
function openNowPlaying() { if (!Player.current) return; const np = $('#np'); np.classList.remove('hidden', 'closing'); updateNow(); }
function closeNowPlaying() {
  const np = $('#np'); if (np.classList.contains('hidden')) return;
  np.classList.add('closing'); setTimeout(() => { np.classList.add('hidden'); np.classList.remove('closing'); }, 300);
}
const seek = $('#seek');
const seekDur = () => (isFinite(audio.duration) && audio.duration) || Player.current?.duration || 0;
seek.addEventListener('input', () => {
  scrubbing = true;
  const p = seek.value / 1000; seek.style.setProperty('--p', `${p * 100}%`);
  $('#tCur').textContent = fmt(p * seekDur()); $('#tLeft').textContent = '-' + fmt((1 - p) * seekDur());
});
seek.addEventListener('change', () => {
  const target = (seek.value / 1000) * seekDur();
  if (Player.pendingResume) Player.pendingResume.time = target; else Player.seek(target);
  scrubbing = false; updatePosition();
});
// Swipe down on Now Playing to close (ignores drags that start on the seek bar).
(() => {
  let y0 = null;
  $('#np').addEventListener('touchstart', (e) => { y0 = e.target.closest('input') ? null : e.touches[0].clientY; }, { passive: true });
  $('#np').addEventListener('touchend', (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 110) closeNowPlaying(); y0 = null; }, { passive: true });
  let x0 = null;
  $('#mini').addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  $('#mini').addEventListener('touchend', (e) => {
    if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (dx < -60) Player.next(); else if (dx > 60) Player.prev();
  }, { passive: true });
})();

// ---------------------------------------------------------------- sheets
function openSheet(html, kind = '', full = false) {
  const s = $('#sheet');
  s.innerHTML = `<div class="grabber"></div>${html}`;
  s.dataset.kind = kind; s.classList.toggle('full', full);
  s.classList.remove('hidden'); $('#sheetBackdrop').classList.remove('hidden');
  s.scrollTop = 0;
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden'); $('#sheet').dataset.kind = ''; }
$('#sheetBackdrop').addEventListener('click', closeSheet);

const sheets = {
  track(id) {
    const t = T(id); if (!t) return;
    openSheet(`<div class="sheet-track"><img class="art" src="${artSrc(id)}" alt=""><div class="meta" style="min-width:0"><div class="t1">${esc(t.title)}</div><div class="t2">${esc(t.artist)}</div></div></div>
      <div class="actions">
        <button data-action="m-next" data-id="${id}">Play Next ${icon('i-next')}</button>
        <button data-action="m-queue" data-id="${id}">Add to Queue ${icon('i-queue')}</button>
        <button data-action="m-playlist" data-id="${id}">Add to Playlist ${icon('i-list')}</button>
        <button data-action="m-fav" data-id="${id}">${t.fav ? 'Remove from Favorites' : 'Add to Favorites'} ${icon(t.fav ? 'i-heart-fill' : 'i-heart')}</button>
        <button data-action="m-edit" data-id="${id}">Edit Info ${icon('i-more')}</button>
      </div>
      <div class="actions"><button class="danger" data-action="m-delete" data-id="${id}">Delete from Library ${icon('i-trash')}</button></div>`);
  },
  addToPlaylist(ids) {
    openSheet(`<div class="sheet-head"><button data-action="close-sheet">Cancel</button><h3>Add to Playlist</h3><span style="width:52px"></span></div>
      <div class="actions"><button data-action="pick-new-playlist">New Playlist… ${icon('i-plus')}</button>
      ${L.playlists.map((p) => `<button data-action="pick-playlist" data-id="${p.id}"><span>${esc(p.name)}</span><span class="dim small">${p.trackIds.length}</span></button>`).join('')}</div>`, 'pick');
    $('#sheet')._ids = ids;
  },
  input(title, value, onOk, okLabel = 'Save') {
    openSheet(`<div class="sheet-head"><button data-action="close-sheet">Cancel</button><h3>${esc(title)}</h3><button data-action="input-ok">${okLabel}</button></div>
      <label class="field"><input id="sheetInput" value="${esc(value)}" placeholder="Name" autocomplete="off"></label>`, 'input');
    $('#sheet')._ok = onOk;
    const inp = $('#sheetInput'); setTimeout(() => inp.focus(), 50);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('[data-action="input-ok"]').click(); } });
  },
  edit(id) {
    const t = T(id);
    openSheet(`<div class="sheet-head"><button data-action="close-sheet">Cancel</button><h3>Edit Info</h3><button data-action="edit-save" data-id="${id}">Save</button></div>
      <img class="cover" src="${artSrc(id)}" alt="" style="width:140px;height:140px">
      <label class="field"><span>Title</span><input id="eTitle" value="${esc(t.title)}"></label>
      <label class="field"><span>Artist</span><input id="eArtist" value="${esc(t.artist)}"></label>
      <label class="field"><span>Album</span><input id="eAlbum" value="${esc(t.album)}"></label>
      <div class="foot">${esc(t.name)} · ${(t.size / 1048576).toFixed(1)} MB · played ${plural(t.playCount, 'time')}</div>`, 'edit');
  },
  sort() {
    openSheet(`<div class="sheet-head"><span></span><h3>Sort Songs By</h3><button data-action="close-sheet">Done</button></div>
      <div class="actions">${Object.entries(SORTS).map(([k, n]) => `<button data-action="pick-sort" data-key="${k}"><span>${n}</span>${UI.sort === k ? '<span class="accent">✓</span>' : ''}</button>`).join('')}</div>`);
  },
  speed() {
    openSheet(`<div class="sheet-head"><span></span><h3>Playback Speed</h3><button data-action="close-sheet">Done</button></div>
      <div class="big-num" id="rateNum">${Player.rate}x</div>
      <div class="slider-row"><input id="rateSlider" type="range" min="0.5" max="2" step="0.05" value="${Player.rate}"></div>
      <div class="chips" style="justify-content:space-between">${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => `<button class="pill ${Player.rate === r ? 'on' : ''}" data-action="pick-rate" data-r="${r}">${r}x</button>`).join('')}</div>`, 'speed');
    const s = $('#rateSlider'); paintRange(s);
    s.addEventListener('input', () => { const r = Math.round(s.value * 100) / 100; Player.setRate(r); $('#rateNum').textContent = r + 'x'; paintRange(s); });
  },
  sleep() {
    const left = Player.sleepAt ? Math.max(0, Math.round((Player.sleepAt - Date.now()) / 60000)) : 0;
    openSheet(`<div class="sheet-head"><span></span><h3>Sleep Timer</h3><button data-action="close-sheet">Done</button></div>
      ${Player.sleepAt || Player.sleepEnd ? `<div class="banner"><div>${Player.sleepEnd ? 'Stopping after this song' : `Stopping in about <b>${left} min</b>`}</div></div>
        <div class="actions"><button class="danger" data-action="pick-sleep" data-m="0">Turn Off Timer</button></div>` : ''}
      <div class="actions">${[5, 10, 15, 30, 45, 60, 90, 120].map((m) => `<button data-action="pick-sleep" data-m="${m}">${m} minutes</button>`).join('')}
        <button data-action="pick-sleep" data-m="end">End of current song</button></div>`);
  },
  eq() {
    openSheet(`<div class="sheet-head"><span></span><h3>Equalizer</h3><button data-action="close-sheet">Done</button></div>
      <div class="group"><div class="item"><span>Equalizer</span><label class="switch"><input id="eqToggle" type="checkbox" ${EQ.enabled ? 'checked' : ''}><span></span></label></div></div>
      <div class="foot">Note: iOS may pause web-app audio on the lock screen while the equalizer is active.</div>
      <div id="eqBody" style="${EQ.enabled ? '' : 'opacity:.4;pointer-events:none'}">
        <div class="chips">${Object.keys(PRESETS).map((n) => `<button class="pill ${PRESETS[n].every((g, i) => g === EQ.gains[i]) ? 'on' : ''}" data-action="eq-preset" data-name="${n}">${n}</button>`).join('')}</div>
        <div class="eq">${EQ_FREQS.map((f, i) => `<div class="band"><span class="db" id="db${i}">${EQ.gains[i] > 0 ? '+' : ''}${EQ.gains[i]}</span>
          <div class="vwrap"><input type="range" min="-12" max="12" step="1" value="${EQ.gains[i]}" data-band="${i}"></div><span>${EQ_LABELS[i]}</span></div>`).join('')}</div>
        <div class="slider-row"><label><span>Preamp</span><span id="preVal">${EQ.preamp > 0 ? '+' : ''}${EQ.preamp} dB</span></label>
          <input id="preamp" type="range" min="-12" max="12" step="1" value="${EQ.preamp}"></div>
        <button class="btn" style="width:100%" data-action="eq-preset" data-name="Flat">Reset</button>
      </div>`, 'eq', true);
    $('#sheet').querySelectorAll('input[type=range]').forEach(paintRange);
    $('#eqToggle').addEventListener('change', (e) => { EQ.enabled = e.target.checked; EQ.ensure(); EQ.resume(); EQ.save(); sheets.eq(); });
    $('#sheet').querySelectorAll('[data-band]').forEach((inp) => inp.addEventListener('input', () => {
      const i = +inp.dataset.band; EQ.gains[i] = +inp.value; $('#db' + i).textContent = (inp.value > 0 ? '+' : '') + inp.value; paintRange(inp); EQ.save();
    }));
    const pre = $('#preamp');
    pre.addEventListener('input', () => { EQ.preamp = +pre.value; $('#preVal').textContent = (pre.value > 0 ? '+' : '') + pre.value + ' dB'; paintRange(pre); EQ.save(); });
  },
  queue() {
    const cur = Player.current;
    const up = Player.queue.slice(Player.index + 1).map(T).filter(Boolean);
    openSheet(`<div class="sheet-head"><span style="width:52px"></span><h3>Queue</h3><button data-action="close-sheet">Done</button></div>
      ${cur ? `<div class="dim small" style="margin:4px 0">NOW PLAYING</div><div class="row current"><img class="art" src="${artSrc(cur.id)}" alt=""><div class="meta"><div class="t1">${esc(cur.title)}</div><div class="t2">${esc(cur.artist)}</div></div></div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px"><span class="dim small">UP NEXT · ${up.length}</span>${up.length ? '<button class="accent small" data-action="q-clear">Clear</button>' : ''}</div>
      <div class="list">${up.map((t, i) => `<div class="row" data-action="q-jump" data-i="${Player.index + 1 + i}"><img class="art" src="${artSrc(t.id)}" alt="">
        <div class="meta"><div class="t1">${esc(t.title)}</div><div class="t2">${esc(t.artist)}</div></div>
        <button class="more" data-action="q-up" data-i="${Player.index + 1 + i}">${icon('i-up', 'sm')}</button>
        <button class="more" data-action="q-remove" data-i="${Player.index + 1 + i}" style="color:#ff453a">${icon('i-x', 'sm')}</button></div>`).join('')}</div>`, 'queue', true);
  },
  addSongs(pid) {
    const p = L.playlists.find((x) => x.id === pid);
    const ts = sortTracks(L.tracks.filter((t) => !p.trackIds.includes(t.id)), 'title');
    const picked = new Set();
    openSheet(`<div class="sheet-head"><button data-action="close-sheet">Cancel</button><h3>Add Songs</h3><button data-action="add-songs-ok" data-id="${pid}" id="addOk">Add</button></div>
      <label class="search">${icon('i-search')}<input id="addQ" type="search" placeholder="Search" autocomplete="off"></label>
      <div class="list" id="addList">${ts.map((t) => `<div class="row" data-action="add-pick" data-id="${t.id}" data-search="${esc((t.title + ' ' + t.artist).toLowerCase())}"><span class="check"></span>
        <img class="art" src="${artSrc(t.id)}" alt=""><div class="meta"><div class="t1">${esc(t.title)}</div><div class="t2">${esc(t.artist)}</div></div></div>`).join('') || '<div class="empty">All songs are already in this playlist.</div>'}</div>`, 'add-songs', true);
    $('#sheet')._picked = picked;
    $('#addQ').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $('#addList').querySelectorAll('.row').forEach((r) => r.classList.toggle('hidden', !!q && !r.dataset.search.includes(q)));
    });
  },
  playlistMenu(pid) {
    const p = L.playlists.find((x) => x.id === pid);
    openSheet(`<div class="sheet-head"><span></span><h3>${esc(p.name)}</h3><button data-action="close-sheet">Done</button></div>
      <div class="actions"><button data-action="pl-rename" data-id="${pid}">Rename ${icon('i-more')}</button>
        <button data-action="pl-dup" data-id="${pid}">Duplicate ${icon('i-plus')}</button>
        <button data-action="pl-queue" data-id="${pid}">Add All to Queue ${icon('i-queue')}</button></div>
      <div class="actions"><button class="danger" data-action="pl-delete" data-id="${pid}">Delete Playlist ${icon('i-trash')}</button></div>`);
  },
};
function paintRange(r) { const p = ((r.value - r.min) / (r.max - r.min)) * 100; r.style.setProperty('--p', p + '%'); }

// ---------------------------------------------------------------- actions (event delegation)
const actions = {
  import: () => $('#fileInput').click(),
  seg: (el) => { UI.seg = el.dataset.seg; store.set('seg', UI.seg); render(); },
  sort: () => sheets.sort(),
  'pick-sort': (el) => { UI.sort = el.dataset.key; store.set('sort', UI.sort); closeSheet(); render(); },
  'select-mode': () => { UI.selecting = !UI.selecting; UI.selected.clear(); UI.seg = 'songs'; render(); },
  select: (el) => { const id = el.dataset.id; UI.selected.has(id) ? UI.selected.delete(id) : UI.selected.add(id); el.classList.toggle('selected'); renderSelectionBar(); },
  'sel-all': () => { const ids = UI.ctx.songs || []; const all = ids.every((id) => UI.selected.has(id)); UI.selected = new Set(all ? [] : ids); render(true); },
  'sel-queue': () => { Player.addToQueue([...UI.selected]); UI.selecting = false; UI.selected.clear(); render(true); },
  'sel-playlist': () => sheets.addToPlaylist([...UI.selected]),
  'sel-delete': async () => {
    if (!confirm(`Delete ${plural(UI.selected.size, 'song')} from this iPhone?`)) return;
    const ids = [...UI.selected]; UI.selecting = false; UI.selected.clear(); await deleteTracks(ids);
  },
  'play-from': (el) => Player.playList(UI.ctx[el.dataset.ctx] || [el.dataset.id], el.dataset.id),
  'play-ctx': (el) => { Player.shuffle = false; store.set('shuffle', false); Player.playList(UI.ctx[el.dataset.ctx] || []); },
  'shuffle-ctx': (el) => Player.playList(UI.ctx[el.dataset.ctx] || [], null, true),
  'open-group': (el) => go({ v: 'group', key: el.dataset.key, name: el.dataset.name }),
  'open-smart': (el) => go({ v: 'smart', key: el.dataset.key }),
  'open-playlist': (el) => go({ v: 'playlist', id: el.dataset.id }),
  back: () => back(),

  'track-menu': (el) => sheets.track(el.dataset.id),
  'm-next': (el) => { Player.playNext(el.dataset.id); closeSheet(); },
  'm-queue': (el) => { Player.addToQueue([el.dataset.id]); closeSheet(); },
  'm-playlist': (el) => sheets.addToPlaylist([el.dataset.id]),
  'm-fav': async (el) => { const t = T(el.dataset.id); t.fav = !t.fav; await saveTrack(t); closeSheet(); updateNow(); render(true); },
  'm-edit': (el) => sheets.edit(el.dataset.id),
  'm-delete': async (el) => { const t = T(el.dataset.id); if (!confirm(`Delete “${t.title}” from this iPhone?`)) return; closeSheet(); await deleteTracks([t.id]); },
  'edit-save': async (el) => {
    const t = T(el.dataset.id);
    t.title = $('#eTitle').value.trim() || t.title; t.artist = $('#eArtist').value.trim() || 'Unknown Artist'; t.album = $('#eAlbum').value.trim() || 'Unknown Album';
    await saveTrack(t); closeSheet(); render(true); updateNow(); updateMediaSession();
  },

  'new-playlist': () => sheets.input('New Playlist', '', async (name) => { await createPlaylist(name); render(); }, 'Create'),
  'pick-new-playlist': () => { const ids = $('#sheet')._ids; sheets.input('New Playlist', '', async (name) => { await createPlaylist(name, ids); toast('Playlist created'); afterPick(); }, 'Create'); },
  'pick-playlist': async (el) => { await addToPlaylist(el.dataset.id, $('#sheet')._ids); afterPick(); },
  'input-ok': async () => { const fn = $('#sheet')._ok; const v = $('#sheetInput').value; closeSheet(); if (fn) await fn(v); },
  'close-sheet': () => closeSheet(),
  'pl-edit': () => { UI.editing = !UI.editing; render(true); },
  'pl-add': (el) => sheets.addSongs(el.dataset.id),
  'add-pick': (el) => { const s = $('#sheet')._picked; const id = el.dataset.id; s.has(id) ? s.delete(id) : s.add(id); el.classList.toggle('selected'); $('#addOk').textContent = s.size ? `Add (${s.size})` : 'Add'; },
  'add-songs-ok': async (el) => { const ids = [...$('#sheet')._picked]; closeSheet(); if (ids.length) await addToPlaylist(el.dataset.id, ids); render(true); },
  'pl-menu': (el) => sheets.playlistMenu(el.dataset.id),
  'pl-rename': (el) => { const p = L.playlists.find((x) => x.id === el.dataset.id); sheets.input('Rename Playlist', p.name, async (n) => { p.name = n.trim() || p.name; await savePlaylist(p); render(); }); },
  'pl-dup': async (el) => { const p = L.playlists.find((x) => x.id === el.dataset.id); await createPlaylist(p.name + ' Copy', p.trackIds); closeSheet(); toast('Playlist duplicated'); render(); },
  'pl-queue': (el) => { const p = L.playlists.find((x) => x.id === el.dataset.id); Player.addToQueue(p.trackIds.filter((id) => L.byId.has(id))); closeSheet(); },
  'pl-delete': async (el) => {
    const p = L.playlists.find((x) => x.id === el.dataset.id); if (!confirm(`Delete playlist “${p.name}”? Songs stay in your library.`)) return;
    await DB.del('playlists', p.id); L.playlists = L.playlists.filter((x) => x.id !== p.id); closeSheet(); back();
  },
  'pl-up': (el) => movePl(+el.dataset.i, -1),
  'pl-down': (el) => movePl(+el.dataset.i, 1),
  'pl-remove': async (el) => { const p = curPlaylist(); const ids = p.trackIds.filter((id) => L.byId.has(id)); ids.splice(+el.dataset.i, 1); p.trackIds = ids; await savePlaylist(p); render(true); },

  toggle: () => Player.toggle(),
  next: () => Player.next(),
  prev: () => Player.prev(),
  back10: () => Player.skip(-10),
  fwd10: () => Player.skip(10),
  shuffle: () => Player.toggleShuffle(),
  repeat: () => Player.cycleRepeat(),
  'close-player': () => Player.close(),
  'close-np': () => closeNowPlaying(),
  'np-fav': async () => { const t = Player.current; if (!t) return; t.fav = !t.fav; await saveTrack(t); updateNow(); render(true); },
  'np-menu': () => Player.current && sheets.track(Player.current.id),
  speed: () => sheets.speed(),
  'pick-rate': (el) => { Player.setRate(+el.dataset.r); sheets.speed(); },
  sleep: () => sheets.sleep(),
  'pick-sleep': (el) => { const m = el.dataset.m; Player.setSleep(m === 'end' ? 'end' : +m); closeSheet(); if (curView().v === 'settings') render(true); },
  eq: () => sheets.eq(),
  'eq-preset': (el) => { EQ.gains = PRESETS[el.dataset.name].slice(); if (el.dataset.name === 'Flat') EQ.preamp = 0; EQ.save(); sheets.eq(); },
  queue: () => sheets.queue(),
  'q-jump': (el) => { Player.load(+el.dataset.i, true); closeSheet(); },
  'q-up': (el) => { const i = +el.dataset.i; if (i > Player.index + 1) { [Player.queue[i - 1], Player.queue[i]] = [Player.queue[i], Player.queue[i - 1]]; Player.persist(); } sheets.queue(); },
  'q-remove': (el) => { Player.queue.splice(+el.dataset.i, 1); Player.persist(); sheets.queue(); },
  'q-clear': () => { Player.queue = Player.queue.slice(0, Player.index + 1); Player.persist(); sheets.queue(); },
  'delete-all': async () => { if (!confirm('Delete ALL songs and playlists from this iPhone? This cannot be undone.')) return;
    for (const p of L.playlists) await DB.del('playlists', p.id); L.playlists = []; await deleteTracks(L.tracks.map((t) => t.id)); toast('Library cleared'); },
};
function afterPick() {
  closeSheet();
  if (UI.selecting) { UI.selecting = false; UI.selected.clear(); }
  render(true);
}
const curPlaylist = () => L.playlists.find((x) => x.id === curView().id);
async function movePl(i, d) {
  const p = curPlaylist(); const ids = p.trackIds.filter((id) => L.byId.has(id));
  const j = i + d; if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]]; p.trackIds = ids; await savePlaylist(p); render(true);
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  const el = e.target.closest('[data-action]');
  if (el && el.dataset.action && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](el, e); return; }
  if (e.target.closest('#mini')) openNowPlaying();
});
$('#fileInput').addEventListener('change', async (e) => { const files = [...e.target.files]; e.target.value = ''; await importFiles(files); });

// ---------------------------------------------------------------- boot
(async function init() {
  try { await DB.open(); } catch (e) { $('#view').innerHTML = `<div class="empty"><h3>Storage unavailable</h3><div>${esc(e && e.message)}</div></div>`; return; }
  await loadLibrary();
  Player.restore();
  render();
  updateNow();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
})();
