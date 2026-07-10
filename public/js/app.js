/* ひだまり日記 — メインアプリ */
(() => {
  'use strict';

  // ===== ユーティリティ =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function fmtDate(d) { // Date -> 'YYYY-MM-DD' (ローカル時刻)
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function todayStr() { return fmtDate(new Date()); }
  function jpDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
    return `${y}年${m}月${d}日(${w})`;
  }
  function uuid() {
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ===== 状態 =====
  let currentMonth = new Date(); // カレンダー表示中の月
  let editingDate = null;        // 編集中の日付
  let editorPhotos = [];         // [{id, blob, isNew}]
  let removedPhotoIds = [];
  const objectUrls = new Set();

  function makeUrl(blob) {
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    return url;
  }
  function revokeAllUrls() {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls.clear();
  }

  // ===== ビュー切り替え =====
  const views = ['calendar', 'editor', 'gallery', 'settings'];
  function showView(name) {
    views.forEach(v => $(`#view-${v}`).classList.toggle('hidden', v !== name));
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'calendar') renderCalendar();
    if (name === 'gallery') renderGallery();
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // ===== ログイン(パスコード) =====
  const PIN_KEY = 'diary-pin-hash';
  let pinBuffer = '';
  let pinMode = 'verify'; // verify | set | confirm
  let pinFirst = '';
  let pinResolve = null;

  function updatePinDots() {
    $$('#pin-dots span').forEach((s, i) => s.classList.toggle('filled', i < pinBuffer.length));
  }
  function showLogin(mode, message) {
    pinMode = mode;
    pinBuffer = '';
    pinFirst = '';
    updatePinDots();
    $('#login-message').textContent = message;
    $('#login-message').classList.remove('error');
    $('#view-login').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
    return new Promise(res => { pinResolve = res; });
  }
  function hideLogin() {
    $('#view-login').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
  }
  async function handlePinComplete() {
    const msg = $('#login-message');
    if (pinMode === 'verify') {
      const hash = await sha256(pinBuffer);
      if (hash === localStorage.getItem(PIN_KEY)) {
        hideLogin();
        pinResolve && pinResolve(true);
      } else {
        msg.textContent = 'パスコードが違います';
        msg.classList.add('error');
        $('#pin-dots').classList.add('shake');
        setTimeout(() => $('#pin-dots').classList.remove('shake'), 400);
        pinBuffer = '';
        updatePinDots();
      }
    } else if (pinMode === 'set') {
      pinFirst = pinBuffer;
      pinBuffer = '';
      pinMode = 'confirm';
      updatePinDots();
      msg.textContent = 'もう一度入力してください';
      msg.classList.remove('error');
    } else if (pinMode === 'confirm') {
      if (pinBuffer === pinFirst) {
        localStorage.setItem(PIN_KEY, await sha256(pinBuffer));
        hideLogin();
        toast('パスコードを設定しました 🔒');
        pinResolve && pinResolve(true);
      } else {
        pinMode = 'set';
        pinBuffer = '';
        updatePinDots();
        msg.textContent = '一致しません。新しいパスコードを入力';
        msg.classList.add('error');
      }
    }
  }
  $('#pin-pad').addEventListener('click', (e) => {
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    if (key === 'del') {
      pinBuffer = pinBuffer.slice(0, -1);
    } else if (pinBuffer.length < 4) {
      pinBuffer += key;
    }
    updatePinDots();
    if (pinBuffer.length === 4) setTimeout(handlePinComplete, 120);
  });

  // ===== カレンダー =====
  async function renderCalendar() {
    const y = currentMonth.getFullYear();
    const m = currentMonth.getMonth();
    $('#cal-title').textContent = `${y}年${m + 1}月`;

    const entries = await DiaryDB.getAllEntries();
    const entryMap = {};
    entries.forEach(e => { entryMap[e.date] = e; });

    const first = new Date(y, m, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const grid = $('#cal-grid');
    grid.innerHTML = '';
    revokeAllUrls();

    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
    const today = todayStr();

    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startOffset + 1;
      const cell = document.createElement('button');
      cell.className = 'cal-cell';
      if (dayNum < 1 || dayNum > daysInMonth) {
        cell.classList.add('out');
        cell.disabled = true;
        grid.appendChild(cell);
        continue;
      }
      const dateStr = fmtDate(new Date(y, m, dayNum));
      const entry = entryMap[dateStr];
      if (dateStr === today) cell.classList.add('today');

      const num = document.createElement('span');
      num.className = 'cal-daynum';
      num.textContent = dayNum;

      if (entry && entry.photoIds && entry.photoIds.length > 0) {
        cell.classList.add('has-photo');
        DiaryDB.getPhoto(entry.photoIds[0]).then(photo => {
          if (photo) {
            const img = document.createElement('img');
            img.className = 'thumb';
            img.src = makeUrl(photo.blob);
            img.alt = '';
            cell.prepend(img);
          }
        });
      }
      cell.appendChild(num);
      if (entry) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        cell.appendChild(dot);
      }
      cell.addEventListener('click', () => openEditor(dateStr));
      grid.appendChild(cell);
    }
    $('#header-date').textContent = jpDate(today);
  }

  $('#cal-prev').addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  $('#cal-next').addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  $('#cal-today').addEventListener('click', () => {
    currentMonth = new Date();
    renderCalendar();
  });
  $('#fab-write').addEventListener('click', () => openEditor(todayStr()));

  // ===== エディター =====
  async function openEditor(dateStr) {
    editingDate = dateStr;
    editorPhotos = [];
    removedPhotoIds = [];
    $('#editor-date').textContent = jpDate(dateStr);
    const entry = await DiaryDB.getEntry(dateStr);
    $('#editor-title').value = entry ? (entry.title || '') : '';
    $('#editor-text').value = entry ? (entry.text || '') : '';
    $$('#mood-row .mood-options button').forEach(b => {
      b.classList.toggle('selected', !!entry && b.dataset.mood === entry.mood);
    });
    $('#editor-delete').classList.toggle('hidden', !entry);
    if (entry && entry.photoIds) {
      for (const id of entry.photoIds) {
        const p = await DiaryDB.getPhoto(id);
        if (p) editorPhotos.push({ id: p.id, blob: p.blob, isNew: false });
      }
    }
    renderEditorPhotos();
    showView('editor');
  }

  function renderEditorPhotos() {
    const grid = $('#editor-photos');
    grid.innerHTML = '';
    editorPhotos.forEach((p, idx) => {
      const item = document.createElement('div');
      item.className = 'photo-item';
      const img = document.createElement('img');
      img.src = makeUrl(p.blob);
      img.alt = '';
      const rm = document.createElement('button');
      rm.className = 'photo-remove';
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        if (!p.isNew) removedPhotoIds.push(p.id);
        editorPhotos.splice(idx, 1);
        renderEditorPhotos();
      });
      item.appendChild(img);
      item.appendChild(rm);
      grid.appendChild(item);
    });
  }

  // 写真を縮小してJPEG化(最大1600px)
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const MAX = 1600;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = MAX / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('圧縮に失敗しました')), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めません')); };
      img.src = url;
    });
  }

  $('#photo-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const file of files) {
      try {
        const blob = await compressImage(file);
        editorPhotos.push({ id: uuid(), blob, isNew: true });
      } catch (err) {
        toast('画像の追加に失敗しました');
      }
    }
    renderEditorPhotos();
  });

  $('#mood-row').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mood]');
    if (!btn) return;
    const wasSelected = btn.classList.contains('selected');
    $$('#mood-row .mood-options button').forEach(b => b.classList.remove('selected'));
    if (!wasSelected) btn.classList.add('selected');
  });

  $('#editor-save').addEventListener('click', async () => {
    const title = $('#editor-title').value.trim();
    const text = $('#editor-text').value.trim();
    const moodBtn = $('#mood-row .mood-options button.selected');
    const mood = moodBtn ? moodBtn.dataset.mood : null;

    if (!title && !text && editorPhotos.length === 0) {
      toast('内容を入力してください');
      return;
    }
    // 写真を保存/削除
    for (const id of removedPhotoIds) await DiaryDB.deletePhoto(id);
    for (const p of editorPhotos) {
      if (p.isNew) {
        await DiaryDB.putPhoto({ id: p.id, date: editingDate, blob: p.blob, createdAt: Date.now() });
      }
    }
    await DiaryDB.putEntry({
      date: editingDate,
      title, text, mood,
      photoIds: editorPhotos.map(p => p.id),
      updatedAt: Date.now(),
    });
    reportActivity(editingDate);
    toast('保存しました 🌿');
    showView('calendar');
  });

  $('#editor-delete').addEventListener('click', async () => {
    if (!confirm('この日の日記と写真を削除します。よろしいですか?')) return;
    const entry = await DiaryDB.getEntry(editingDate);
    if (entry && entry.photoIds) {
      for (const id of entry.photoIds) await DiaryDB.deletePhoto(id);
    }
    await DiaryDB.deleteEntry(editingDate);
    toast('削除しました');
    showView('calendar');
  });

  $('#editor-back').addEventListener('click', () => showView('calendar'));

  // ===== ギャラリー =====
  async function renderGallery() {
    const photos = await DiaryDB.getAllPhotos();
    photos.sort((a, b) => (b.date > a.date ? 1 : -1) || b.createdAt - a.createdAt);
    const grid = $('#gallery-grid');
    grid.innerHTML = '';
    revokeAllUrls();
    $('#gallery-count').textContent = photos.length ? `${photos.length}枚の思い出` : '';
    $('#gallery-empty').classList.toggle('hidden', photos.length > 0);

    photos.forEach(p => {
      const item = document.createElement('button');
      item.className = 'gallery-item';
      const img = document.createElement('img');
      img.src = makeUrl(p.blob);
      img.alt = p.date;
      const cap = document.createElement('span');
      cap.className = 'gallery-date';
      cap.textContent = p.date.replace(/-/g, '/');
      item.appendChild(img);
      item.appendChild(cap);
      item.addEventListener('click', () => openLightbox(p));
      grid.appendChild(item);
    });
  }

  function openLightbox(photo) {
    $('#lightbox-img').src = makeUrl(photo.blob);
    $('#lightbox-caption').textContent = jpDate(photo.date) + ' — タップで日記を開く';
    $('#lightbox').classList.remove('hidden');
    $('#lightbox-img').onclick = () => {
      closeLightbox();
      openEditor(photo.date);
    };
  }
  function closeLightbox() {
    $('#lightbox').classList.add('hidden');
    $('#lightbox-img').src = '';
  }
  $('#lightbox-close').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });

  // ===== 通知(Web Push) =====
  const NOTIFY_KEY = 'diary-notify-enabled';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function getSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function enableNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('この環境はプッシュ通知に対応していません');
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('通知が許可されませんでした');

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const res = await fetch('/api/vapid-public-key');
      const { publicKey } = await res.json();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    localStorage.setItem(NOTIFY_KEY, '1');
    // 今日すでに書いていればサーバーに伝えておく
    const entry = await DiaryDB.getEntry(todayStr());
    if (entry) reportActivity(todayStr());
    return sub;
  }

  async function disableNotifications() {
    const sub = await getSubscription();
    if (sub) {
      await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
    localStorage.removeItem(NOTIFY_KEY);
  }

  // 日記保存をサーバーへ報告(22時のリマインド抑止)
  async function reportActivity(date) {
    try {
      const sub = await getSubscription();
      if (!sub) return;
      await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint, date }),
      });
    } catch (e) { /* オフライン時は無視 */ }
  }

  // ===== 設定 =====
  async function renderSettings() {
    // 通知
    const notifyToggle = $('#notify-toggle');
    const sub = await getSubscription().catch(() => null);
    notifyToggle.checked = !!sub && localStorage.getItem(NOTIFY_KEY) === '1';

    const hint = $('#notify-hint');
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (isIOS && !isStandalone) {
      hint.textContent = '📱 iPhoneでは、共有メニューから「ホーム画面に追加」した後にアプリを開くと通知を有効にできます。';
    } else if (!('PushManager' in window)) {
      hint.textContent = 'この環境はプッシュ通知に対応していません。';
    } else {
      hint.textContent = '';
    }

    // パスコード
    const hasPin = !!localStorage.getItem(PIN_KEY);
    $('#lock-toggle').checked = hasPin;
    $('#lock-change').classList.toggle('hidden', !hasPin);

    // ストレージ
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const used = (est.usage / 1024 / 1024).toFixed(1);
      const entries = await DiaryDB.getAllEntries();
      const photos = await DiaryDB.getAllPhotos();
      $('#storage-info').textContent = `日記 ${entries.length}件 / 写真 ${photos.length}枚 / 使用容量 約${used}MB`;
    }
  }

  $('#notify-toggle').addEventListener('change', async (e) => {
    const toggle = e.target;
    toggle.disabled = true;
    try {
      if (toggle.checked) {
        await enableNotifications();
        toast('通知をオンにしました 🔔');
      } else {
        await disableNotifications();
        toast('通知をオフにしました');
      }
    } catch (err) {
      toggle.checked = false;
      toast(err.message);
    } finally {
      toggle.disabled = false;
    }
  });

  $('#notify-test').addEventListener('click', async () => {
    const sub = await getSubscription();
    if (!sub) { toast('先に通知をオンにしてください'); return; }
    const res = await fetch('/api/test-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    toast(res.ok ? 'テスト通知を送信しました' : '送信に失敗しました');
  });

  $('#lock-toggle').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const ok = await showLogin('set', '新しいパスコード(4桁)を入力');
      if (!ok) e.target.checked = false;
      renderSettings();
      showView('settings');
    } else {
      localStorage.removeItem(PIN_KEY);
      toast('パスコードを解除しました');
      renderSettings();
    }
  });

  $('#lock-change').addEventListener('click', async () => {
    await showLogin('set', '新しいパスコード(4桁)を入力');
    showView('settings');
  });

  // ===== エクスポート / インポート =====
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const arr = Uint8Array.from([...bin].map(c => c.charCodeAt(0)));
    return new Blob([arr], { type: type || 'image/jpeg' });
  }

  $('#export-btn').addEventListener('click', async () => {
    toast('エクスポート準備中…');
    const entries = await DiaryDB.getAllEntries();
    const photos = await DiaryDB.getAllPhotos();
    const photoData = [];
    for (const p of photos) {
      photoData.push({ id: p.id, date: p.date, createdAt: p.createdAt, base64: await blobToBase64(p.blob) });
    }
    const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries, photos: photoData });
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hidamari-diary-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.entries) throw new Error();
      for (const entry of data.entries) await DiaryDB.putEntry(entry);
      for (const p of (data.photos || [])) {
        await DiaryDB.putPhoto({ id: p.id, date: p.date, createdAt: p.createdAt, blob: base64ToBlob(p.base64) });
      }
      toast(`${data.entries.length}件の日記を読み込みました`);
      renderSettings();
    } catch {
      toast('ファイルを読み込めませんでした');
    }
  });

  // ===== 起動 =====
  async function init() {
    // Service Worker 登録
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW登録失敗:', err));
    }
    // パスコードロック
    if (localStorage.getItem(PIN_KEY)) {
      await showLogin('verify', 'パスコードを入力してください');
    } else {
      hideLogin();
    }
    // 通知から「?date=...」で開かれたとき
    const params = new URLSearchParams(location.search);
    if (params.get('write')) {
      openEditor(todayStr());
    } else {
      showView('calendar');
    }
  }

  init();
})();
