const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'items.json');
const IMG_DIR = path.join(__dirname, 'uploads');
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = 'admin123';

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR);

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const COOLDOWN_MS = 5 * 60 * 1000;
let cooldownOn = false;
const lastPost = {};

function loadSettings() {
  try { cooldownOn = !!(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).cooldown); }
  catch (e) { cooldownOn = false; }
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ cooldown: cooldownOn }));
}
loadSettings();

function clientKey(req) {
  return req.headers['x-client-id'] || req.socket.remoteAddress || 'anon';
}
function rateLimited(req, res) {
  if (!cooldownOn) return false;
  if (Date.now() - (lastPost[clientKey(req)] || 0) < COOLDOWN_MS) {
    sendJSON(res, 429, { error: 'Cooldown is on — please wait a few minutes before posting again.' });
    return true;
  }
  return false;
}
function recordPost(req) {
  if (cooldownOn) lastPost[clientKey(req)] = Date.now();
}

const ACTIVITY_FILE = path.join(__dirname, 'activity.json');
function loadActivity() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); }
  catch (e) { return []; }
}
function logActivity(type, text) {
  const act = loadActivity();
  act.unshift({ id: genId(), type: type, text: text, time: new Date().toISOString() });
  if (act.length > 100) act.length = 100;
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(act));
}

const BROADCAST_FILE = path.join(__dirname, 'broadcast.json');
let broadcast = { message: '', time: 0, id: '' };
function loadBroadcast() {
  try { broadcast = JSON.parse(fs.readFileSync(BROADCAST_FILE, 'utf8')) || { message: '', time: 0, id: '' }; }
  catch (e) { broadcast = { message: '', time: 0, id: '' }; }
}
loadBroadcast();

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function genToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function loadItems() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}

function saveItems(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function saveImage(dataUrl, name) {
  if (typeof dataUrl === 'string' && dataUrl.indexOf('data:image/') === 0) {
    const comma = dataUrl.indexOf(',');
    if (comma !== -1) {
      const header = dataUrl.slice(0, comma);
      let ext = 'jpg';
      if (header.indexOf('image/png') !== -1) ext = 'png';
      else if (header.indexOf('image/webp') !== -1) ext = 'webp';
      else if (header.indexOf('image/gif') !== -1) ext = 'gif';
      const b64 = dataUrl.slice(comma + 1);
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 0 && buf.length < 10 * 1024 * 1024) {
        const filename = name + '.' + ext;
        fs.writeFileSync(path.join(IMG_DIR, filename), buf);
        return '/uploads/' + filename;
      }
    }
  }
  return null;
}

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

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = decodeURIComponent(url.pathname);
  const parts = pathname.split('/').filter(Boolean);

  if (parts[0] === 'api' && parts[1] === 'items') {
    if (parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, loadItems());
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
            authorToken: (type === 'lost') ? genToken() : null
          };

          if (typeof data.image === 'string' && data.image.indexOf('data:image/') === 0) {
            const comma = data.image.indexOf(',');
            if (comma !== -1) {
              const header = data.image.slice(0, comma);
              let ext = 'jpg';
              if (header.indexOf('image/png') !== -1) ext = 'png';
              else if (header.indexOf('image/webp') !== -1) ext = 'webp';
              else if (header.indexOf('image/gif') !== -1) ext = 'gif';
              const b64 = data.image.slice(comma + 1);
              const buf = Buffer.from(b64, 'base64');
              if (buf.length > 0 && buf.length < 10 * 1024 * 1024) {
                const filename = entry.id + '.' + ext;
                fs.writeFileSync(path.join(IMG_DIR, filename), buf);
                entry.image = '/uploads/' + filename;
              }
            }
          }

          const items = loadItems();
          items.unshift(entry);
          saveItems(items);
          recordPost(req);
          logActivity('post', name + ' lost "' + item + '"');
          return sendJSON(res, 201, entry);
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }

    if (parts.length === 4 && parts[3] === 'found' && req.method === 'POST') {
      const id = parts[2];
      const items = loadItems();
      const entry = items.find(function (i) { return i.id === id; });
      if (!entry) return sendJSON(res, 404, { error: 'Not found.' });
      if (entry.type !== 'found') {
        const pass = req.headers['x-admin-pass'];
        const token = req.headers['x-author-token'];
        if (pass !== ADMIN_PASS && token !== entry.authorToken) {
          return sendJSON(res, 403, { error: 'Only the author can mark this found.' });
        }
      }
      entry.found = !entry.found;
      entry.foundAt = entry.found ? new Date().toISOString() : null;
      saveItems(items);
      logActivity('claim', entry.item + (entry.found ? ' marked found/claimed' : ' marked available again'));
      return sendJSON(res, 200, entry);
    }

    if (parts.length === 3 && req.method === 'DELETE') {
      const id = parts[2];
      const items = loadItems();
      const entry = items.find(function (i) { return i.id === id; });
      if (!entry) return sendJSON(res, 404, { error: 'Not found.' });
      const pass = req.headers['x-admin-pass'];
      const token = req.headers['x-author-token'];
      const isAuthor = entry.authorToken && token && token === entry.authorToken;
      if (pass !== ADMIN_PASS && !isAuthor) {
        return sendJSON(res, 403, { error: 'You can only delete your own item.' });
      }
      const filtered = items.filter(function (i) { return i.id !== id; });
      saveItems(filtered);
      logActivity('delete', 'Deleted "' + entry.item + '"');
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
          const items = loadItems();
          const entry = items.find(function (i) { return i.id === id; });
          if (!entry) return sendJSON(res, 404, { error: 'Not found.' });
          if (!entry.replies) entry.replies = [];
          const replyId = genId();
          const imageUrl = saveImage(data.image, 'reply-' + replyId);
          entry.replies.push({
            id: replyId,
            name: name,
            message: message,
            image: imageUrl,
            createdAt: new Date().toISOString()
          });
          saveItems(items);
          recordPost(req);
          logActivity('reply', name + ' replied to "' + entry.item + '"');
          return sendJSON(res, 201, entry);
        } catch (e) {
          return sendJSON(res, 400, { error: 'Invalid request.' });
        }
      });
      return;
    }
  }

  if (parts[0] === 'api' && parts[1] === 'settings' && parts.length === 2) {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { cooldown: cooldownOn });
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          if (req.headers['x-admin-pass'] !== ADMIN_PASS) {
            return sendJSON(res, 403, { error: 'Admin required.' });
          }
          const data = JSON.parse(body || '{}');
          if (typeof data.cooldown === 'boolean') { cooldownOn = data.cooldown; saveSettings(); }
          return sendJSON(res, 200, { cooldown: cooldownOn });
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
        if (data.pass === ADMIN_PASS) return sendJSON(res, 200, { ok: true });
        return sendJSON(res, 403, { error: 'Wrong passcode.' });
      } catch (e) {
        return sendJSON(res, 400, { error: 'Invalid request.' });
      }
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'activity' && parts.length === 2 && req.method === 'GET') {
    return sendJSON(res, 200, loadActivity());
  }

  if (parts[0] === 'api' && parts[1] === 'broadcast' && parts.length === 2) {
    if (req.method === 'GET') {
      return sendJSON(res, 200, broadcast);
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        try {
          if (req.headers['x-admin-pass'] !== ADMIN_PASS) {
            return sendJSON(res, 403, { error: 'Admin required.' });
          }
          const data = JSON.parse(body || '{}');
          const message = String(data.message || '').trim();
          broadcast = { message: message, time: Date.now(), id: genId() };
          fs.writeFileSync(BROADCAST_FILE, JSON.stringify(broadcast));
          if (message) logActivity('broadcast', message);
          return sendJSON(res, 200, broadcast);
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

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log('Lost & Found running at http://localhost:' + PORT);
});
