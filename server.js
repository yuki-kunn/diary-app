/**
 * 日記帳PWA サーバー
 * - SQLiteに日記・写真・購読情報を保存
 * - パスワード認証(セッションCookie)
 * - 毎日22時(JST)に日記未登録ならリマインド通知
 */
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== DB =====
const db = new Database(path.join(DATA_DIR, 'diary.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
    title TEXT DEFAULT '',
    text TEXT DEFAULT '',
    mood TEXT,
    photo_ids TEXT DEFAULT '[]',    -- JSON配列(表示順)
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    mime TEXT DEFAULT 'image/jpeg',
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date);
  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
`);

const getConfig = (key) => {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
};
const setConfig = (key, value) =>
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// ===== VAPID鍵 =====
let vapidPublic = getConfig('vapid_public');
let vapidPrivate = getConfig('vapid_private');
if (!vapidPublic || !vapidPrivate) {
  // 旧バージョンの data/vapid.json があれば引き継ぐ(購読を無効化しないため)
  const legacy = path.join(DATA_DIR, 'vapid.json');
  if (fs.existsSync(legacy)) {
    const keys = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    vapidPublic = keys.publicKey;
    vapidPrivate = keys.privateKey;
  } else {
    const keys = webpush.generateVAPIDKeys();
    vapidPublic = keys.publicKey;
    vapidPrivate = keys.privateKey;
  }
  setConfig('vapid_public', vapidPublic);
  setConfig('vapid_private', vapidPrivate);
}
webpush.setVapidDetails('mailto:hokuyoyuki@gmail.com', vapidPublic, vapidPrivate);

// 旧バージョンの subscriptions.json を引き継ぐ
const legacySubs = path.join(DATA_DIR, 'subscriptions.json');
if (fs.existsSync(legacySubs)) {
  try {
    const subs = JSON.parse(fs.readFileSync(legacySubs, 'utf8'));
    const ins = db.prepare('INSERT OR IGNORE INTO subscriptions (endpoint, json) VALUES (?, ?)');
    for (const [endpoint, v] of Object.entries(subs)) {
      ins.run(endpoint, JSON.stringify(v.subscription));
    }
    fs.renameSync(legacySubs, legacySubs + '.migrated');
  } catch (e) { /* 壊れていたら無視 */ }
}

// ===== パスワード =====
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return orig.length === test.length && crypto.timingSafeEqual(orig, test);
}

// ログイン試行の制限(IPごとに15分で5回まで)
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
  if (rec.count >= 5) return false;
  return true;
}
function recordFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
  rec.count++;
  loginAttempts.set(ip, rec);
}

// ===== セッション(Cookie) =====
const TOKEN_COOKIE = 'diary_token';
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 180; // 180日

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
function issueToken(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens (token, created_at) VALUES (?, ?)').run(token, Date.now());
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TOKEN_TTL / 1000)}${secure ? '; Secure' : ''}`);
}
function clearToken(req, res) {
  const token = parseCookies(req)[TOKEN_COOKIE];
  if (token) db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function isAuthed(req) {
  const token = parseCookies(req)[TOKEN_COOKIE];
  if (!token) return false;
  const row = db.prepare('SELECT created_at FROM tokens WHERE token = ?').get(token);
  if (!row) return false;
  if (Date.now() - row.created_at > TOKEN_TTL) {
    db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
    return false;
  }
  return true;
}
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'ログインが必要です' });
  next();
}

function todayJST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

// ===== アプリ =====
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- 認証 ----
app.get('/api/auth/status', (req, res) => {
  res.json({ setup: !!getConfig('password'), authed: isAuthed(req) });
});

app.post('/api/auth/setup', (req, res) => {
  if (getConfig('password')) return res.status(400).json({ error: 'すでに設定済みです' });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
  setConfig('password', hashPassword(password));
  issueToken(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: '試行回数が多すぎます。15分後にやり直してください' });
  const stored = getConfig('password');
  const { password } = req.body;
  if (!stored || !password || !verifyPassword(password, stored)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  loginAttempts.delete(ip);
  issueToken(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearToken(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/change', requireAuth, (req, res) => {
  const { current, next } = req.body;
  const stored = getConfig('password');
  if (!current || !verifyPassword(current, stored)) return res.status(401).json({ error: '現在のパスワードが違います' });
  if (!next || next.length < 6) return res.status(400).json({ error: '新しいパスワードは6文字以上にしてください' });
  setConfig('password', hashPassword(next));
  res.json({ ok: true });
});

// ---- 日記 ----
function rowToEntry(row) {
  return {
    date: row.date, title: row.title, text: row.text, mood: row.mood,
    photoIds: JSON.parse(row.photo_ids || '[]'), updatedAt: row.updated_at,
  };
}

app.get('/api/entries', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM entries ORDER BY date').all();
  res.json(rows.map(rowToEntry));
});

app.get('/api/entries/:date', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE date = ?').get(req.params.date);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(rowToEntry(row));
});

app.put('/api/entries/:date', requireAuth, (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });
  const { title = '', text = '', mood = null, photoIds = [] } = req.body;
  db.prepare(`
    INSERT INTO entries (date, title, text, mood, photo_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET title = excluded.title, text = excluded.text,
      mood = excluded.mood, photo_ids = excluded.photo_ids, updated_at = excluded.updated_at
  `).run(date, title, text, mood, JSON.stringify(photoIds), Date.now());
  res.json({ ok: true });
});

app.delete('/api/entries/:date', requireAuth, (req, res) => {
  db.prepare('DELETE FROM photos WHERE date = ?').run(req.params.date);
  db.prepare('DELETE FROM entries WHERE date = ?').run(req.params.date);
  res.json({ ok: true });
});

// ---- 写真 ----
app.get('/api/photos-meta', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, date, created_at FROM photos ORDER BY date DESC, created_at DESC').all();
  res.json(rows.map(r => ({ id: r.id, date: r.date, createdAt: r.created_at })));
});

app.post('/api/photos', requireAuth, (req, res) => {
  const { date, base64, mime } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !base64) return res.status(400).json({ error: 'invalid request' });
  const data = Buffer.from(base64, 'base64');
  if (data.length > 10 * 1024 * 1024) return res.status(413).json({ error: '画像が大きすぎます' });
  const id = 'p-' + crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO photos (id, date, mime, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, date, mime || 'image/jpeg', data, Date.now());
  res.json({ id });
});

app.get('/api/photos/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT mime, data FROM photos WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(row.data);
});

app.delete('/api/photos/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- エクスポート / インポート ----
app.get('/api/export', requireAuth, (req, res) => {
  const entries = db.prepare('SELECT * FROM entries ORDER BY date').all().map(rowToEntry);
  const photos = db.prepare('SELECT * FROM photos').all().map(p => ({
    id: p.id, date: p.date, mime: p.mime, createdAt: p.created_at, base64: p.data.toString('base64'),
  }));
  res.setHeader('Content-Disposition', `attachment; filename="hidamari-diary-${todayJST()}.json"`);
  res.json({ version: 2, exportedAt: new Date().toISOString(), entries, photos });
});

app.post('/api/import', requireAuth, (req, res) => {
  const { entries, photos } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'invalid file' });
  const insEntry = db.prepare(`
    INSERT INTO entries (date, title, text, mood, photo_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET title = excluded.title, text = excluded.text,
      mood = excluded.mood, photo_ids = excluded.photo_ids, updated_at = excluded.updated_at
  `);
  const insPhoto = db.prepare('INSERT OR REPLACE INTO photos (id, date, mime, data, created_at) VALUES (?, ?, ?, ?, ?)');
  const run = db.transaction(() => {
    for (const e of entries) {
      insEntry.run(e.date, e.title || '', e.text || '', e.mood || null,
        JSON.stringify(e.photoIds || []), e.updatedAt || Date.now());
    }
    for (const p of (photos || [])) {
      insPhoto.run(p.id, p.date, p.mime || 'image/jpeg', Buffer.from(p.base64, 'base64'), p.createdAt || Date.now());
    }
  });
  run();
  res.json({ ok: true, entries: entries.length, photos: (photos || []).length });
});

// ---- プッシュ通知 ----
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidPublic });
});

app.post('/api/subscribe', requireAuth, (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  db.prepare('INSERT OR REPLACE INTO subscriptions (endpoint, json) VALUES (?, ?)')
    .run(sub.endpoint, JSON.stringify(sub));
  res.json({ ok: true });
});

app.post('/api/unsubscribe', requireAuth, (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(req.body.endpoint || '');
  res.json({ ok: true });
});

app.post('/api/test-push', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT json FROM subscriptions WHERE endpoint = ?').get(req.body.endpoint || '');
  if (!row) return res.status(404).json({ error: 'subscription not found' });
  try {
    await webpush.sendNotification(JSON.parse(row.json), JSON.stringify({
      type: 'test',
      title: 'ひだまり日記',
      body: '通知のテストです。この通知が見えていれば設定は完了です 🌿',
    }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 毎日22:00 JST — 今日の日記がまだなら全購読端末へリマインド
cron.schedule('0 22 * * *', async () => {
  const today = todayJST();
  const hasEntry = db.prepare('SELECT 1 FROM entries WHERE date = ?').get(today);
  console.log(`[cron] 22:00 チェック (${today}) 日記=${hasEntry ? 'あり' : 'なし'}`);
  if (hasEntry) return;
  const rows = db.prepare('SELECT endpoint, json FROM subscriptions').all();
  for (const row of rows) {
    try {
      await webpush.sendNotification(JSON.parse(row.json), JSON.stringify({
        type: 'reminder',
        date: today,
        title: '今日の日記、まだ書いていませんよ 🌙',
        body: '今日はどんな一日でしたか?寝る前に少しだけ振り返ってみましょう。',
      }));
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(row.endpoint);
      } else {
        console.error('[cron] push失敗:', e.message);
      }
    }
  }
}, { timezone: 'Asia/Tokyo' });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ひだまり日記 サーバー起動: port=${PORT}`);
});
