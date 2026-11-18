const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'louisaintadmin';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'lostfound.db');

// Legacy flat files (used only for one-time import on first run)
const LEGACY_ITEMS = path.join(__dirname, 'items.json');
const LEGACY_ACTIVITY = path.join(__dirname, 'activity.json');
const LEGACY_SETTINGS = path.join(__dirname, 'settings.json');
const LEGACY_BROADCAST = path.join(__dirname, 'broadcast.json');
const LEGACY_UPLOADS = path.join(__dirname, 'uploads');

const COOLDOWN_MS = 5 * 60 * 1000;

function adminPassOk(pass) {
  const a = Buffer.from(String(pass || ''));
  const b = Buffer.from(ADMIN_PASS);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- DB ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    item TEXT NOT NULL,
    color TEXT,
    found INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    foundAt TEXT,
    authorToken TEXT,
    image TEXT,
    images TEXT NOT NULL DEFAULT '[]',
    hidden INTEGER NOT NULL DEFAULT 0,
    replies TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    time TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_archive (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    time TEXT NOT NULL,
    archivedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rate_limit (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
`);

// migrate: add images + hidden columns if missing (existing DBs)
(function migrateColumns() {
  const cols = db.prepare('PRAGMA table_info(items)').all().map(function (c) { return c.name; });
  if (cols.indexOf('images') === -1) db.exec("ALTER TABLE items ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
  if (cols.indexOf('hidden') === -1) db.exec("ALTER TABLE items ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  const legacy = db.prepare("SELECT id, image FROM items WHERE images = '[]' AND image IS NOT NULL").all();
  const upImg = db.prepare('UPDATE items SET images = ? WHERE id = ?');
  for (const r of legacy) upImg.run(JSON.stringify([r.image]), r.id);
})();

// ---------- helpers ----------
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function genToken() {
  return crypto.randomBytes(24).toString('hex');
}
function sendJSON(res, status, data) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, SEC_HEADERS));
  res.end(JSON.stringify(data));
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function dataUrlToImage(dataUrl, name) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const header = dataUrl.slice(0, comma);
  let ext = 'jpg', mime = 'image/jpeg';
  if (header.indexOf('image/png') !== -1) { ext = 'png'; mime = 'image/png'; }
  else if (header.indexOf('image/webp') !== -1) { ext = 'webp'; mime = 'image/webp'; }
  else if (header.indexOf('image/gif') !== -1) { ext = 'gif'; mime = 'image/gif'; }
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (buf.length === 0 || buf.length >= 10 * 1024 * 1024) return null;
  const filename = name + '.' + ext;
  db.prepare('INSERT OR REPLACE INTO images (id, mime, data) VALUES (?, ?, ?)').run(filename, mime, buf);
  try {
    fs.mkdirSync(LEGACY_UPLOADS, { recursive: true });
    fs.writeFileSync(path.join(LEGACY_UPLOADS, filename), buf);
  } catch (e) { console.error('upload write failed:', e.message); }
  return '/uploads/' + filename;
}

function rowToItem(row) {
  let replies = [];
  try { replies = JSON.parse(row.replies || '[]'); } catch (e) { replies = []; }
  let images = [];
  try { images = JSON.parse(row.images || '[]'); } catch (e) { images = []; }
  if (!Array.isArray(images)) images = [];
  if (images.length === 0 && row.image) images = [row.image];
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    item: row.item,
    color: row.color || null,
    image: images[0] || null,
    images: images,
    hidden: !!row.hidden,
    found: !!row.found,
    createdAt: row.createdAt,
    foundAt: row.foundAt || null,
    authorToken: null, // never exposed in list responses
    replies: replies
  };
}

// ---------- data access ----------
const qAllItems = db.prepare('SELECT * FROM items ORDER BY seq DESC');
const qItemById = db.prepare('SELECT * FROM items WHERE id = ?');
const qInsertItem = db.prepare('INSERT INTO items (id, type, name, item, color, found, createdAt, foundAt, authorToken, image, images, replies) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const qUpdateFound = db.prepare('UPDATE items SET found = ?, foundAt = ? WHERE id = ?');
const qDeleteItem = db.prepare('DELETE FROM items WHERE id = ?');
const qUpdateReplies = db.prepare('UPDATE items SET replies = ? WHERE id = ?');
const qUpdateImages = db.prepare('UPDATE items SET images = ? WHERE id = ?');
const qSetHidden = db.prepare('UPDATE items SET hidden = ? WHERE id = ?');

function getItems(includeHidden) {
  return qAllItems.all()
    .filter(function (r) { return includeHidden || !r.hidden; })
    .map(rowToItem);
}
function getItem(id) {
  return qItemById.get(id);
}
function syncItemToSeedById(id) {
  const row = getItem(id);
  if (!row) return;
  try {
    let arr = [];
    if (fs.existsSync(LEGACY_ITEMS)) {
      try {
        const existing = JSON.parse(fs.readFileSync(LEGACY_ITEMS, 'utf8'));
        if (Array.isArray(existing)) arr = existing;
      } catch (e) {}
    }
    let images = [];
    try { const a = JSON.parse(row.images || '[]'); if (Array.isArray(a)) images = a; } catch (e) { images = []; }
    const imgs = images.length ? images : (row.image ? [row.image] : []);
    let replies = [];
    try { const r = JSON.parse(row.replies || '[]'); if (Array.isArray(r)) replies = r; } catch (e) { replies = []; }
    const seedItem = {
      id: row.id,
      type: row.type,
      name: row.name,
      item: row.item,
      color: row.color || null,
      found: !!row.found,
      createdAt: row.createdAt,
      foundAt: row.foundAt || null,
      authorToken: row.authorToken || null,
      image: imgs[0] || null,
      images: imgs,
      replies: replies
    };
    const i = arr.findIndex(function (x) { return x.id === row.id; });
    if (i === -1) arr.unshift(seedItem); else arr[i] = seedItem;
    fs.writeFileSync(LEGACY_ITEMS, JSON.stringify(arr, null, 2));
  } catch (e) { console.error('items.json sync failed:', e.message); }
}
function createItem(entry) {
  const images = Array.isArray(entry.images) && entry.images.length ? entry.images : (entry.image ? [entry.image] : []);
  qInsertItem.run(
    entry.id, entry.type, entry.name, entry.item,
    entry.color || null,
    entry.found ? 1 : 0,
    entry.createdAt, entry.foundAt || null,
    entry.authorToken || null,
    images[0] || null,
    JSON.stringify(images),
    JSON.stringify(entry.replies || [])
  );
  bumpDataVersion();
  syncItemToSeedById(entry.id);
  return entry;
}
function updateItemFound(id, found, foundAt) {
  qUpdateFound.run(found ? 1 : 0, foundAt || null, id);
  bumpDataVersion();
  syncItemToSeedById(id);
}
function removeItemFromSeed(id) {
  if (!fs.existsSync(LEGACY_ITEMS)) return;
  try {
    const items = JSON.parse(fs.readFileSync(LEGACY_ITEMS, 'utf8'));
    const filtered = items.filter(function (it) { return it.id !== id; });
    if (filtered.length !== items.length) {
      fs.writeFileSync(LEGACY_ITEMS, JSON.stringify(filtered, null, 2));
      console.log('Removed ' + id + ' from items.json seed');
    }
  } catch (e) { console.error('items.json seed update failed:', e.message); }
}
function deleteItem(id) {
  const row = getItem(id);
  if (row) {
    let imgs = [];
    try { imgs = JSON.parse(row.images || '[]'); } catch (e) { imgs = []; }
    if (!Array.isArray(imgs)) imgs = [];
    if (imgs.length === 0 && row.image) imgs = [row.image];
    for (const u of imgs) {
      if (typeof u === 'string' && u.startsWith('/uploads/')) {
        const fn = path.basename(u);
        db.prepare('DELETE FROM images WHERE id = ?').run(fn);
        const p = path.join(LEGACY_UPLOADS, fn);
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
      }
    }
  }
  qDeleteItem.run(id);
  removeItemFromSeed(id);
  bumpDataVersion();
}
function updateItemReplies(id, replies) {
  qUpdateReplies.run(JSON.stringify(replies), id);
  bumpDataVersion();
  syncItemToSeedById(id);
}

function setItemImages(id, images) {
  qUpdateImages.run(JSON.stringify(images), id);
  bumpDataVersion();
  syncItemToSeedById(id);
}
function setItemHidden(id, hidden) {
  qSetHidden.run(hidden ? 1 : 0, id);
  bumpDataVersion();
  syncItemToSeedById(id);
}

function getActivity() {
  return db.prepare('SELECT id, type, text, time FROM activity ORDER BY seq DESC LIMIT 100').all();
}
function logActivity(type, text) {
  db.prepare('INSERT INTO activity (id, type, text, time) VALUES (?, ?, ?, ?)').run(genId(), type, text, new Date().toISOString());
}

function getArchivedActivity() {
  return db.prepare('SELECT id, type, text, time, archivedAt FROM activity_archive ORDER BY seq DESC LIMIT 1000').all();
}
function clearActivity() {
  const rows = db.prepare('SELECT id, type, text, time FROM activity').all();
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT INTO activity_archive (id, type, text, time, archivedAt) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.type, r.text, r.time, now);
  db.prepare('DELETE FROM activity').run();
  return rows.length;
}

function getKv(key, fallback) {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setKv(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function getCooldown() {
  return getKv('cooldown', '0') === '1';
}
function setCooldown(v) {
  setKv('cooldown', v ? '1' : '0');
}

function getBroadcast() {
  try { return JSON.parse(getKv('broadcast', '{"message":"","time":0,"id":""}')); }
  catch (e) { return { message: '', time: 0, id: '' }; }
}
function setBroadcast(b) {
  setKv('broadcast', JSON.stringify(b));
}

function getEffect() {
  try { return JSON.parse(getKv('effect', '{"effect":"","id":"","time":0}')); }
  catch (e) { return { effect: '', id: '', time: 0 }; }
}
function setEffect(e) {
  setKv('effect', JSON.stringify(e));
}

function getDataVersion() {
  return parseInt(getKv('data_version', '0'), 10) || 0;
}
function bumpDataVersion() {
  setKv('data_version', String(getDataVersion() + 1));
}

function getLastPost(key) {
  const r = db.prepare('SELECT at FROM rate_limit WHERE key = ?').get(key);
  return r ? r.at : 0;
}
function setLastPost(key, at) {
  db.prepare('INSERT INTO rate_limit (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at').run(key, at);
  db.prepare('DELETE FROM rate_limit WHERE at < ?').run(Date.now() - COOLDOWN_MS * 2);
}

// ---------- one-time legacy migration ----------
function migrateLegacy() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
  if (count > 0) return;

  // items
  if (fs.existsSync(LEGACY_ITEMS)) {
    try {
      const items = JSON.parse(fs.readFileSync(LEGACY_ITEMS, 'utf8'));
      for (const it of items) {
        createItem({
          id: it.id || genId(),
          type: it.type === 'found' ? 'found' : 'lost',
          name: it.name || 'Anonymous',
          item: it.item || '',
          color: it.color || null,
          found: !!it.found,
          createdAt: it.createdAt || new Date().toISOString(),
          foundAt: it.foundAt || null,
          authorToken: it.authorToken || null,
          image: it.image || null,
          images: Array.isArray(it.images) && it.images.length ? it.images : (it.image ? [it.image] : []),
          replies: Array.isArray(it.replies) ? it.replies : []
        });
      }
      console.log('Migrated ' + items.length + ' items from items.json');
    } catch (e) { console.error('items.json migration failed:', e.message); }
  }

  // activity
  if (fs.existsSync(LEGACY_ACTIVITY)) {
    try {
      const acts = JSON.parse(fs.readFileSync(LEGACY_ACTIVITY, 'utf8'));
      for (const a of acts) {
        db.prepare('INSERT INTO activity (id, type, text, time) VALUES (?, ?, ?, ?)').run(a.id || genId(), a.type || 'note', a.text || '', a.time || new Date().toISOString());
      }
      console.log('Migrated ' + acts.length + ' activity entries');
    } catch (e) { console.error('activity.json migration failed:', e.message); }
  }

  // settings (cooldown)
  if (fs.existsSync(LEGACY_SETTINGS)) {
    try {
      const s = JSON.parse(fs.readFileSync(LEGACY_SETTINGS, 'utf8'));
      if (typeof s.cooldown === 'boolean') setCooldown(s.cooldown);
    } catch (e) { /* ignore */ }
  }

  // broadcast
  if (fs.existsSync(LEGACY_BROADCAST)) {
    try {
      const b = JSON.parse(fs.readFileSync(LEGACY_BROADCAST, 'utf8'));
      if (b) setBroadcast(b);
    } catch (e) { /* ignore */ }
  }

  // uploads -> images table
  if (fs.existsSync(LEGACY_UPLOADS)) {
    try {
      let n = 0;
      for (const f of fs.readdirSync(LEGACY_UPLOADS)) {
        const p = path.join(LEGACY_UPLOADS, f);
        if (!fs.statSync(p).isFile()) continue;
        const ext = path.extname(f).toLowerCase();
        const mime = EXT_MIME[ext] || 'application/octet-stream';
        db.prepare('INSERT OR REPLACE INTO images (id, mime, data) VALUES (?, ?, ?)').run(f, mime, fs.readFileSync(p));
        n++;
      }
      if (n) console.log('Migrated ' + n + ' uploaded images into DB');
    } catch (e) { console.error('uploads migration failed:', e.message); }
  }
}
migrateLegacy();

// ---------- rate limiting ----------
function clientKey(req) {
  return req.headers['x-client-id'] || req.socket.remoteAddress || 'anon';
}
function rateLimited(req, res) {
  if (!getCooldown()) return false;
  if (Date.now() - getLastPost(clientKey(req)) < COOLDOWN_MS) {
    sendJSON(res, 429, { error: 'Cooldown is on — please wait a few minutes before posting again.' });
    return true;
  }
  return false;
}
function recordPost(req) {
  if (getCooldown()) setLastPost(clientKey(req), Date.now());
}

// ---------- chat bot ----------
function botReply(msg) {
  const m = (msg || '').toLowerCase();
  const has = function (re) { return re.test(m); };

  if (/^(hi|hello|hey|yo|sup|hiya|hola)\b/.test(m.trim())) {
    return "Hey! I'm the Lost & Found helper. Ask me how to report a lost item, search for something, or post something you found.";
  }
  if (has(/what can you do|help|what do you do|how do you work|what are you/)) {
    return "I can help you with the Lost & Found board. Try asking:\n\u2022 \"How do I report a lost item?\"\n\u2022 \"How do I search?\"\n\u2022 \"How do I mark something found?\"\n\u2022 \"How do I post something I found?\"\n\u2022 \"How do I reply to a post?\"";
  }
  if (has(/report|post|add|submit|register/) && has(/lost|missing|gone|lose|lost my/)) {
    return "To report a lost item: scroll to the form, pick \"Lost\" as the type, enter your name and what you lost (add a photo and color if you can), then submit. It will show up on the board for everyone.";
  }
  if (has(/found|turned in|hand in|picked up|find someone/) && has(/post|report|add|submit|where|how/)) {
    return "Found something? Choose \"Found\" in the form, describe the item (and add a photo/color if you can), then submit. The owner can claim it with the \"That's mine\" button.";
  }
  if (has(/search|find my|look for|looking for|locate|check if/)) {
    return "Use the search box at the top of the page. Type what you're looking for (e.g. \"water bottle\", \"jacket\", \"pens\") and matching items will appear instantly.";
  }
  if (has(/mark.*found|claim|that's mine|found my|got it back|it's mine/)) {
    return "If you see your item on the board, click the \"That's mine\" button on the item card. If you posted it, you (or an admin) can mark it as found/claimed.";
  }
  if (has(/reply|respond|comment|message someone|contact.*poster|contact.*owner/)) {
    return "You can reply to any post by clicking \"Reply\" on the item card, entering your name and message, and sending it. The original poster will see your reply.";
  }
  if (has(/what is this|what's this|about this site|who made this|what is this site/)) {
    return "This is the Lost & Found board \u2014 a place to post items you've lost or found so people can reconnect with their stuff.";
  }
  if (has(/cooldown|rate limit|wait|how often|how many times|limit/)) {
    return "To prevent spam, there's a short cooldown between posts when the admin enables it. Just wait a few minutes and try again.";
  }
  if (has(/admin|contact|staff|who runs|moderator|owner of the site/)) {
    return "If you need help from the admin, look for the lock button in the top-right corner of the site.";
  }
  if (has(/lost|missing/)) {
    return "Lost something? Use the search box first to see if it's already been turned in. If not, post a \"Lost\" entry from the form so others can watch for it.";
  }
  if (has(/found/)) {
    return "If you found an item, post a \"Found\" entry so its owner can claim it. Use the search box to check if it's already been posted as lost.";
  }
  return "I'm not sure about that one, but I can help with the Lost & Found board. Try: \"How do I report a lost item?\", \"How do I search?\", or \"How do I post something I found?\"";
}

// ---------- MIME ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

// ---------- server ----------
const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = decodeURIComponent(url.pathname);
  const parts = pathname.split('/').filter(Boolean);

  // serve uploaded images from DB
  if (pathname.startsWith('/uploads/')) {
    const filename = path.basename(pathname);
    const row = db.prepare('SELECT mime, data FROM images WHERE id = ?').get(filename);
    if (!row) {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SEC_HEADERS));
      return res.end('Not found');
    }
    res.writeHead(200, Object.assign({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=86400' }, SEC_HEADERS));
    return res.end(Buffer.from(row.data));
  }

  // health check for deploy probes
  if (pathname === '/healthz') {
    return sendJSON(res, 200, { ok: true });
  }

  // data version for live item sync
  if (pathname === '/api/version') {
    return sendJSON(res, 200, { version: getDataVersion() });
  }

  if (parts[0] === 'api' && parts[1] === 'items') {
    if (parts.length === 2 && req.method === 'GET') {
      const all = adminPassOk(req.headers['x-admin-pass']) && url.searchParams.get('all') === '1';
      return sendJSON(res, 200, getItems(all));
    }

    if (parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          const data = JSON.parse(body || '{}');
          const name = String(data.name || '').trim();
          const item = String(data.item || '').trim();
          if (!name || !item) {
            return sendJSON(res, 400, { error: 'Name and item are required.' });
          }
          const type = (data.type === 'found') ? 'found' : 'lost';
          if (type !== 'found' && rateLimited(req, res)) return;
          const entry = {
            id: genId(),
            type: type,
            name: name,
            item: item,
            color: (typeof data.color === 'string' && data.color) ? data.color : null,
            image: null,
            found: false,
            createdAt: new Date().toISOString(),
            foundAt: null,
            authorToken: (type === 'lost') ? genToken() : null,
            replies: []
          };
          const images = [];
          if (Array.isArray(data.images) && data.images.length) {
            for (let i = 0; i < data.images.length; i++) {
              const u = dataUrlToImage(data.images[i], entry.id + '-' + i);
              if (u) images.push(u);
            }
          } else if (data.image) {
            const u = dataUrlToImage(data.image, entry.id);
            if (u) images.push(u);
          }
          entry.image = images[0] || null;
          entry.images = images;
          createItem(entry);
          recordPost(req);
          logActivity('post', name + ' lost "' + item + '"');
          // return authorToken only on creation so the creator can manage the item
          return sendJSON(res, 201, Object.assign({}, rowToItem(db.prepare('SELECT * FROM items WHERE id = ?').get(entry.id)), { authorToken: entry.authorToken }));
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }

    if (parts.length === 4 && parts[3] === 'found' && req.method === 'POST') {
      const id = parts[2];
      const row = getItem(id);
      if (!row) return sendJSON(res, 404, { error: 'Not found.' });
      const entry = rowToItem(row);
      if (row.type !== 'found') {
        const pass = req.headers['x-admin-pass'];
        const token = req.headers['x-author-token'];
        if (!adminPassOk(pass) && token !== row.authorToken) {
          return sendJSON(res, 403, { error: 'Only the author can mark this found.' });
        }
      }
      const next = !row.found;
      updateItemFound(id, next, next ? new Date().toISOString() : null);
      logActivity('claim', entry.item + (next ? ' marked found/claimed' : ' marked available again'));
      const updated = rowToItem(getItem(id));
      return sendJSON(res, 200, updated);
    }

    if (parts.length === 3 && req.method === 'DELETE') {
      const id = parts[2];
      const row = getItem(id);
      if (!row) return sendJSON(res, 404, { error: 'Not found.' });
      const pass = req.headers['x-admin-pass'];
      const token = req.headers['x-author-token'];
      const isAuthor = row.authorToken && token && token === row.authorToken;
      if (!adminPassOk(pass) && !isAuthor) {
        return sendJSON(res, 403, { error: 'You can only delete your own item.' });
      }
      deleteItem(id);
      logActivity('delete', 'Deleted "' + row.item + '"');
      return sendJSON(res, 200, { ok: true });
    }

    if (parts.length === 4 && parts[3] === 'replies' && req.method === 'POST') {
      const id = parts[2];
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          if (rateLimited(req, res)) return;
          const data = JSON.parse(body || '{}');
          const name = String(data.name || '').trim() || 'Anonymous';
          const message = String(data.message || '').trim();
          if (!message) return sendJSON(res, 400, { error: 'Message is required.' });
          const row = getItem(id);
          if (!row) return sendJSON(res, 404, { error: 'Not found.' });
          const entry = rowToItem(row);
          const replies = entry.replies || [];
          const replyId = genId();
          replies.push({
            id: replyId,
            name: name,
            message: message,
            image: dataUrlToImage(data.image, 'reply-' + replyId),
            createdAt: new Date().toISOString()
          });
          updateItemReplies(id, replies);
          recordPost(req);
          logActivity('reply', name + ' replied to "' + entry.item + '"');
          return sendJSON(res, 201, rowToItem(getItem(id)));
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }

    if (parts.length === 4 && parts[3] === 'images' && req.method === 'POST') {
      const id = parts[2];
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          const row = getItem(id);
          if (!row) return sendJSON(res, 404, { error: 'Not found.' });
          const pass = req.headers['x-admin-pass'];
          const token = req.headers['x-author-token'];
          const isAuthor = row.authorToken && token && token === row.authorToken;
          if (!adminPassOk(pass) && !isAuthor) return sendJSON(res, 403, { error: 'Admin or author required.' });
          const data = JSON.parse(body || '{}');
          let images = [];
          try { images = JSON.parse(row.images || '[]'); } catch (e) { images = []; }
          if (!Array.isArray(images)) images = [];
          if (images.length === 0 && row.image) images = [row.image];
          const url = dataUrlToImage(data.image, id + '-' + genId());
          if (!url) return sendJSON(res, 400, { error: 'Invalid image.' });
          if (data.replace) { images = [url]; } else { images.push(url); }
          setItemImages(id, images);
          logActivity('photo', (data.replace ? 'Updated' : 'Added') + ' a photo for "' + row.item + '"');
          return sendJSON(res, 200, rowToItem(getItem(id)));
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }

    if (parts.length === 5 && parts[3] === 'images' && req.method === 'DELETE') {
      const id = parts[2];
      const idx = parseInt(parts[4], 10);
      const row = getItem(id);
      if (!row) return sendJSON(res, 404, { error: 'Not found.' });
      const pass = req.headers['x-admin-pass'];
      const token = req.headers['x-author-token'];
      const isAuthor = row.authorToken && token && token === row.authorToken;
      if (!adminPassOk(pass) && !isAuthor) return sendJSON(res, 403, { error: 'Admin or author required.' });
      let images = [];
      try { images = JSON.parse(row.images || '[]'); } catch (e) { images = []; }
      if (!Array.isArray(images)) images = [];
      if (images.length === 0 && row.image) images = [row.image];
      if (isNaN(idx) || idx < 0 || idx >= images.length) return sendJSON(res, 400, { error: 'Invalid index.' });
      images.splice(idx, 1);
      setItemImages(id, images);
      return sendJSON(res, 200, rowToItem(getItem(id)));
    }

    if (parts.length === 4 && parts[3] === 'hidden' && req.method === 'POST') {
      const id = parts[2];
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          if (!adminPassOk(req.headers['x-admin-pass'])) return sendJSON(res, 403, { error: 'Admin required.' });
          const row = getItem(id);
          if (!row) return sendJSON(res, 404, { error: 'Not found.' });
          const data = JSON.parse(body || '{}');
          const hidden = !!data.hidden;
          setItemHidden(id, hidden);
          logActivity(hidden ? 'hide' : 'restore', (hidden ? 'Removed ' : 'Restored ') + '"' + row.item + '"' + (hidden ? ' from the catalog' : ' to the catalog'));
          return sendJSON(res, 200, rowToItem(getItem(id)));
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }
  }

  if (parts[0] === 'api' && parts[1] === 'settings' && parts.length === 2) {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { cooldown: getCooldown() });
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          if (!adminPassOk(req.headers['x-admin-pass'])) {
            return sendJSON(res, 403, { error: 'Admin required.' });
          }
          const data = JSON.parse(body || '{}');
          if (typeof data.cooldown === 'boolean') setCooldown(data.cooldown);
          return sendJSON(res, 200, { cooldown: getCooldown() });
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }
  }

  if (parts[0] === 'api' && parts[1] === 'admin-check' && parts.length === 2 && req.method === 'POST') {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      try {
        const data = JSON.parse(body || '{}');
        if (adminPassOk(data.pass)) return sendJSON(res, 200, { ok: true });
        return sendJSON(res, 403, { error: 'Wrong passcode.' });
      } catch (e) {
        return sendJSON(res, 400, { error: 'Invalid request.' });
      }
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'activity') {
    if (parts.length === 3 && parts[2] === 'count' && req.method === 'GET') {
      const row = db.prepare('SELECT COUNT(*) AS c FROM activity').get();
      return sendJSON(res, 200, { count: row.c });
    }
    if (parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, getActivity());
    }
    if (parts.length === 3 && parts[2] === 'archive' && req.method === 'GET') {
      if (!adminPassOk(req.headers['x-admin-pass'])) return sendJSON(res, 403, { error: 'Admin required.' });
      return sendJSON(res, 200, getArchivedActivity());
    }
    if (parts.length === 3 && parts[2] === 'clear' && req.method === 'POST') {
      if (!adminPassOk(req.headers['x-admin-pass'])) return sendJSON(res, 403, { error: 'Admin required.' });
      const n = clearActivity();
      return sendJSON(res, 200, { ok: true, cleared: n });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'broadcast' && parts.length === 2) {
    if (req.method === 'GET') {
      return sendJSON(res, 200, getBroadcast());
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          if (!adminPassOk(req.headers['x-admin-pass'])) {
            return sendJSON(res, 403, { error: 'Admin required.' });
          }
          const data = JSON.parse(body || '{}');
          const message = String(data.message || '').trim();
          const b = { message: message, time: Date.now(), id: genId() };
          setBroadcast(b);
          if (message) logActivity('broadcast', message);
          return sendJSON(res, 200, b);
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }
  }

  if (parts[0] === 'api' && parts[1] === 'effect' && parts.length === 2) {
    if (req.method === 'GET') {
      return sendJSON(res, 200, getEffect());
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          if (!adminPassOk(req.headers['x-admin-pass'])) {
            return sendJSON(res, 403, { error: 'Admin required.' });
          }
          const data = JSON.parse(body || '{}');
          const effect = String(data.effect || '').trim();
          const allowed = ['meteor', 'nuke', 'tsunami', 'spacebattle', 'penguins', 'disco', 'everything'];
          if (allowed.indexOf(effect) === -1) return sendJSON(res, 400, { error: 'Unknown effect.' });
          const e = { effect: effect, id: genId(), time: Date.now() };
          setEffect(e);
          logActivity('effect', effect);
          return sendJSON(res, 200, e);
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }
  }

  if (parts[0] === 'api' && parts[1] === 'chat' && parts.length === 2 && req.method === 'POST') {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      try {
        const data = JSON.parse(body || '{}');
        const message = String(data.message || '').trim();
        return sendJSON(res, 200, { reply: botReply(message) });
      } catch (e) {
        return sendJSON(res, 400, { error: 'Invalid request.' });
      }
    });
    return;
  }

  // static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname + path.sep)) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SEC_HEADERS));
    return res.end('Forbidden');
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SEC_HEADERS));
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SEC_HEADERS));
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('Lost & Found running at http://localhost:' + PORT);
  console.log('SQLite DB: ' + DB_PATH);
});

// Keep the main SQLite file current so recently added images/items survive sleep and restarts.
setInterval(function () {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
}, 30 * 1000);
function gracefulCheckpoint() {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', gracefulCheckpoint);
process.on('SIGINT', gracefulCheckpoint);
