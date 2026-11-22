// Portfolio backend: zero dependencies (Node 22.13+ built-ins only).
// Serves the static site from /public and a JSON API backed by SQLite.

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- config ----------
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'portfolio.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SITE_FILES = /^\/(index\.html|admin\.html|config\.js|photo\.jpg|cv\.pdf)$/;
// Comma-separated list of sites allowed to call the API from a browser,
// e.g. "https://sudeysdev.github.io". Same-origin requests never need this.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn('\n[!] ADMIN_PASSWORD is not set. Temporary password for this run: ' + ADMIN_PASSWORD +
    '\n    Set ADMIN_PASSWORD in your environment to keep one permanently.\n');
}
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.createHash('sha256').update('token:' + ADMIN_PASSWORD).digest('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
// Optional: get every new contact message on Telegram too, so nothing is lost if the database resets.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const TG_API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
const MAX_BODY = 20 * 1024;

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    bullets TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    emoji TEXT NOT NULL DEFAULT '💻',
    status TEXT NOT NULL DEFAULT 'Built',
    category TEXT NOT NULL DEFAULT 'web',
    demo_url TEXT NOT NULL DEFAULT '',
    repo_url TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS visits (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
`);

const seed = [
  { title: 'STUDYX — Student Command Center', summary: "One dashboard for a student's whole week, with no account needed.",
    bullets: ['Subjects, assignments and timetable', 'GPA calculator and Pomodoro focus timer', 'Expense tracker and study streaks', 'Dark mode, data saved in the browser'],
    tags: ['HTML', 'CSS', 'JavaScript', 'localStorage'], emoji: '📚', status: 'Built', category: 'web', repo_url: 'https://github.com/Sudeysdev' },
  { title: 'Quiz Game', summary: 'A browser quiz with instant feedback and a clean flow from start to results.',
    bullets: ['Multiple-choice questions with 4 options', 'Live score, question counter and progress bar', 'Right/wrong feedback and a results screen', 'One-click restart'],
    tags: ['HTML', 'CSS', 'JavaScript', 'DOM'], emoji: '🧠', status: 'Built', category: 'web', repo_url: 'https://github.com/Sudeysdev' },
  { title: 'AI-first Student Platform', summary: 'An AI-powered product for university students, from academics to social life and career growth. Currently in early planning.',
    bullets: ['Problem: students juggle scattered tools', 'Goal: one smart assistant for study, campus life and career', 'Stage: researching and designing the first version'],
    tags: ['AI', 'Product design', 'Startup'], emoji: '🤖', status: 'In progress', category: 'ai' },
  { title: 'Full-Stack Portfolio', summary: 'This site: a front end backed by its own REST API and database.',
    bullets: ['Node.js REST API with a SQLite database', 'Contact messages saved to the database', 'Admin dashboard to manage projects and read messages'],
    tags: ['Node.js', 'SQLite', 'REST API', 'JavaScript'], emoji: '💻', status: 'Built', category: 'web', repo_url: 'https://github.com/Sudeysdev' },
];
if (db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === 0) {
  const ins = db.prepare(`INSERT INTO projects (title, summary, bullets, tags, emoji, status, category, demo_url, repo_url, sort_order)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`);
  seed.forEach((p, i) => ins.run(p.title, p.summary, JSON.stringify(p.bullets), JSON.stringify(p.tags), p.emoji, p.status,
    p.category, p.demo_url || '', p.repo_url || '', i));
}

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Simple in-memory sliding-window rate limiter.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some(t => now - t < 3600e3)) buckets.delete(k); }, 10 * 60e3).unref();

function clientIp(req) {
  // Behind a proxy (Render, Fly, ...) the real IP is in X-Forwarded-For.
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function makeToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(String(exp)).digest('base64url');
  return `${exp}.${sig}`;
}
function validToken(token) {
  if (!token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', TOKEN_SECRET).update(exp).digest('base64url');
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
function requireAdmin(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || !validToken(h.slice(7))) throw new HttpError(401, 'Unauthorized');
}

// Fire-and-forget: a Telegram failure must never make the contact form fail.
function notifyTelegram(name, email, message) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const text = `New portfolio message\n\nFrom: ${name}\nEmail: ${email}\n\n${message}`.slice(0, 3900);
  fetch(`${TG_API}/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text }), signal: AbortSignal.timeout(8000),
  }).then(r => { if (!r.ok) console.warn('Telegram notify failed:', r.status); })
    .catch(e => console.warn('Telegram notify error:', e.name));
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v : []).map(x => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
const cleanUrl = (v) => {
  const s = str(v, 300);
  if (!s) return '';
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : ''; } catch { return ''; }
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const projectOut = r => ({ id: r.id, title: r.title, summary: r.summary, bullets: JSON.parse(r.bullets), tags: JSON.parse(r.tags),
  emoji: r.emoji, status: r.status, category: r.category, demo_url: r.demo_url, repo_url: r.repo_url,
  sort_order: r.sort_order, visible: !!r.visible });

function projectInput(b) {
  const title = str(b.title, 120);
  if (!title) throw new HttpError(400, 'Title is required');
  const category = ['web', 'ai', 'other'].includes(b.category) ? b.category : 'web';
  return {
    title, summary: str(b.summary, 400), bullets: strList(b.bullets, 8, 160), tags: strList(b.tags, 10, 30),
    emoji: str(b.emoji, 8) || '💻', status: str(b.status, 24) || 'Built', category,
    demo_url: cleanUrl(b.demo_url), repo_url: cleanUrl(b.repo_url),
    sort_order: Number.isInteger(b.sort_order) ? b.sort_order : 0, visible: b.visible === false ? 0 : 1,
  };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname, m = req.method;
  let id;

  if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true });

  if (p === '/api/projects' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM projects WHERE visible = 1 ORDER BY sort_order, id').all();
    return send(res, 200, rows.map(projectOut), { 'Cache-Control': 'public, max-age=60' });
  }

  if (p === '/api/visit' && m === 'POST') {
    if (rateLimit('visit:' + clientIp(req), 30, 3600e3)) {
      db.prepare(`INSERT INTO visits (day, count) VALUES (date('now'), 1) ON CONFLICT(day) DO UPDATE SET count = count + 1`).run();
    }
    return send(res, 204, '');
  }

  if (p === '/api/contact' && m === 'POST') {
    if (!rateLimit('contact:' + clientIp(req), 5, 3600e3)) throw new HttpError(429, 'Too many messages. Please try again later.');
    const b = await readJson(req);
    if (b.website) return send(res, 201, { ok: true }); // honeypot: bots fill hidden fields, pretend success
    const name = str(b.name, 100), email = str(b.email, 200), message = str(b.message, 3000);
    if (!name || !EMAIL_RE.test(email) || message.length < 5) throw new HttpError(400, 'Please enter your name, a valid email, and a message.');
    db.prepare('INSERT INTO messages (name, email, message) VALUES (?,?,?)').run(name, email, message);
    notifyTelegram(name, email, message);
    return send(res, 201, { ok: true });
  }

  if (p === '/api/admin/login' && m === 'POST') {
    if (!rateLimit('login:' + clientIp(req), 8, 15 * 60e3)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const b = await readJson(req);
    if (!safeEqual(b.password || '', ADMIN_PASSWORD)) throw new HttpError(401, 'Wrong password');
    return send(res, 200, { token: makeToken(), expires_in: TOKEN_TTL_MS / 1000 });
  }

  if (p.startsWith('/api/admin/')) {
    requireAdmin(req);

    if (p === '/api/admin/stats' && m === 'GET') {
      const total = db.prepare('SELECT COALESCE(SUM(count),0) AS n FROM visits').get().n;
      const days = db.prepare('SELECT day, count FROM visits ORDER BY day DESC LIMIT 14').all().reverse();
      const msgs = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(is_read = 0),0) AS unread FROM messages').get();
      const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
      return send(res, 200, { visits_total: total, visits_by_day: days, messages_total: msgs.total, messages_unread: msgs.unread, projects });
    }

    if (p === '/api/admin/messages' && m === 'GET') {
      return send(res, 200, db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 500').all().map(r => ({ ...r, is_read: !!r.is_read })));
    }
    if ((id = p.match(/^\/api\/admin\/messages\/(\d+)$/)) && m === 'PATCH') {
      const b = await readJson(req);
      db.prepare('UPDATE messages SET is_read = ? WHERE id = ?').run(b.is_read === false ? 0 : 1, Number(id[1]));
      return send(res, 200, { ok: true });
    }
    if ((id = p.match(/^\/api\/admin\/messages\/(\d+)$/)) && m === 'DELETE') {
      db.prepare('DELETE FROM messages WHERE id = ?').run(Number(id[1]));
      return send(res, 200, { ok: true });
    }

    if (p === '/api/admin/projects' && m === 'GET') {
      return send(res, 200, db.prepare('SELECT * FROM projects ORDER BY sort_order, id').all().map(projectOut));
    }
    if (p === '/api/admin/projects' && m === 'POST') {
      const v = projectInput(await readJson(req));
      const r = db.prepare(`INSERT INTO projects (title, summary, bullets, tags, emoji, status, category, demo_url, repo_url, sort_order, visible)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(v.title, v.summary, JSON.stringify(v.bullets), JSON.stringify(v.tags), v.emoji, v.status,
        v.category, v.demo_url, v.repo_url, v.sort_order, v.visible);
      return send(res, 201, { id: Number(r.lastInsertRowid) });
    }
    if ((id = p.match(/^\/api\/admin\/projects\/(\d+)$/)) && m === 'PUT') {
      const v = projectInput(await readJson(req));
      const r = db.prepare(`UPDATE projects SET title=?, summary=?, bullets=?, tags=?, emoji=?, status=?, category=?, demo_url=?, repo_url=?, sort_order=?, visible=?
        WHERE id=?`).run(v.title, v.summary, JSON.stringify(v.bullets), JSON.stringify(v.tags), v.emoji, v.status, v.category,
        v.demo_url, v.repo_url, v.sort_order, v.visible, Number(id[1]));
      if (!r.changes) throw new HttpError(404, 'Project not found');
      return send(res, 200, { ok: true });
    }
    if ((id = p.match(/^\/api\/admin\/projects\/(\d+)$/)) && m === 'DELETE') {
      db.prepare('DELETE FROM projects WHERE id = ?').run(Number(id[1]));
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

// ---------- static files ----------
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel === '/admin') rel = '/admin.html';
  // Normal layout: website files live in /public. If that folder is missing (files uploaded loose at the
  // top level of the repo), fall back to serving ONLY these exact website files from the top level.
  const flat = !fs.existsSync(PUBLIC_DIR);
  if (flat && !SITE_FILES.test(rel)) throw new HttpError(404, 'Not found');
  const root = flat ? __dirname : PUBLIC_DIR;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) throw new HttpError(403, 'Forbidden');
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'Not found'); }
  if (!st.isFile()) throw new HttpError(404, 'Not found');
  const ext = path.extname(file).toLowerCase();
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  const origin = req.headers.origin;
  if (origin && url.pathname.startsWith('/api/') && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Portfolio running at http://localhost:${PORT}  (admin: /admin)  db: ${DB_PATH}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
