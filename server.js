/**
 * 日記帳PWA サーバー
 * - 静的ファイル配信
 * - Web Push 購読管理
 * - 毎日22時(JST)に日記未登録の購読者へリマインド通知
 */
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- VAPID鍵(初回起動時に生成して保存) ----
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  console.log('VAPID鍵を新規生成しました');
}
webpush.setVapidDetails('mailto:hokuyoyuki@gmail.com', vapidKeys.publicKey, vapidKeys.privateKey);

// ---- 購読情報 ----
// { endpoint: { subscription, lastEntryDate } }
let subs = {};
if (fs.existsSync(SUBS_FILE)) {
  try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) { subs = {}; }
}
function saveSubs() {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

// 日本時間の YYYY-MM-DD
function todayJST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  subs[sub.endpoint] = {
    subscription: sub,
    lastEntryDate: subs[sub.endpoint] ? subs[sub.endpoint].lastEntryDate : null,
  };
  saveSubs();
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint && subs[endpoint]) {
    delete subs[endpoint];
    saveSubs();
  }
  res.json({ ok: true });
});

// 日記を保存したことをサーバーへ通知(その日はリマインドしない)
app.post('/api/activity', (req, res) => {
  const { endpoint, date } = req.body;
  if (endpoint && subs[endpoint]) {
    subs[endpoint].lastEntryDate = date || todayJST();
    saveSubs();
  }
  res.json({ ok: true });
});

// テスト送信用
app.post('/api/test-push', async (req, res) => {
  const { endpoint } = req.body;
  const entry = subs[endpoint];
  if (!entry) return res.status(404).json({ error: 'subscription not found' });
  try {
    await webpush.sendNotification(entry.subscription, JSON.stringify({
      type: 'test',
      title: 'ひだまり日記',
      body: '通知のテストです。この通知が見えていれば設定は完了です 🌿',
    }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 毎日22:00 JST: 未登録の購読者へリマインド ----
cron.schedule('0 22 * * *', async () => {
  const today = todayJST();
  console.log(`[cron] 22:00 リマインドチェック (${today})`);
  for (const endpoint of Object.keys(subs)) {
    const entry = subs[endpoint];
    if (entry.lastEntryDate === today) continue; // 今日はもう書いた
    try {
      await webpush.sendNotification(entry.subscription, JSON.stringify({
        type: 'reminder',
        date: today,
        title: '今日の日記、まだ書いていませんよ 🌙',
        body: '今日はどんな一日でしたか?寝る前に少しだけ振り返ってみましょう。',
      }));
    } catch (e) {
      // 購読が失効していたら削除
      if (e.statusCode === 404 || e.statusCode === 410) {
        delete subs[endpoint];
        saveSubs();
      } else {
        console.error('[cron] push失敗:', e.message);
      }
    }
  }
}, { timezone: 'Asia/Tokyo' });

app.listen(PORT, () => {
  console.log(`ひだまり日記 サーバー起動: http://localhost:${PORT}`);
});
