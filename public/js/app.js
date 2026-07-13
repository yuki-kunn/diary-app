/* ひだまり日記 — メインアプリ(サーバーDB版) */
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
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  // APIエラーの共通処理(セッション切れならログイン画面へ)
  function handleError(e) {
    if (e.unauthorized) {
      showLogin('login', 'セッションが切れました。ログインしてください');
    } else {
      toast(e.message);
    }
  }

  // ===== 状態 =====
  let currentMonth = new Date();
  let editingDate = null;
  let editorPhotos = [];       // [{id?, blob?, url, isNew}]
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

  // ===== ログイン =====
  let loginMode = 'login'; // login | register
  let currentUsername = null;

  function showLogin(mode, message) {
    loginMode = mode;
    $('#login-message').textContent = message ||
      (mode === 'register' ? '新しいアカウントを作成します' : 'ユーザー名とパスワードを入力してください');
    $('#login-message').classList.remove('error');
    $('#login-password').value = '';
    $('#login-password2').value = '';
    $('#login-password2').classList.toggle('hidden', mode !== 'register');
    $('#login-password2').required = mode === 'register';
    $('#login-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('#login-submit').textContent = mode === 'register' ? 'アカウント作成' : 'ログイン';
    $('#login-switch').textContent = mode === 'register' ? 'ログインに戻る' : 'アカウントを新規作成';
    $('#view-login').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
  }
  $('#login-switch').addEventListener('click', () => {
    showLogin(loginMode === 'register' ? 'login' : 'register');
  });
  function hideLogin() {
    $('#view-login').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
  }
  function loginError(msg) {
    const el = $('#login-message');
    el.textContent = msg;
    el.classList.add('error');
    const form = $('#login-form');
    form.classList.add('shake');
    setTimeout(() => form.classList.remove('shake'), 400);
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    const btn = $('#login-submit');
    btn.disabled = true;
    try {
      let result;
      if (loginMode === 'register') {
        if (password !== $('#login-password2').value) {
          loginError('パスワードが一致しません');
          return;
        }
        result = await Api.register(username, password);
        toast(`ようこそ、${result.username}さん 🌿`);
      } else {
        result = await Api.login(username, password);
      }
      currentUsername = result.username;
      hideLogin();
      await afterLogin();
    } catch (err) {
      loginError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ===== カレンダー =====
  async function renderCalendar() {
    const y = currentMonth.getFullYear();
    const m = currentMonth.getMonth();
    $('#cal-title').textContent = `${y}年${m + 1}月`;

    let entries = [];
    try { entries = await Api.getEntries(); } catch (e) { handleError(e); return; }
    const entryMap = {};
    entries.forEach(en => { entryMap[en.date] = en; });

    const first = new Date(y, m, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const grid = $('#cal-grid');
    grid.innerHTML = '';

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
        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = Api.photoUrl(entry.photoIds[0]);
        img.alt = '';
        cell.prepend(img);
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
    let entry = null;
    try { entry = await Api.getEntry(dateStr); } catch (e) { handleError(e); return; }
    $('#editor-title').value = entry ? (entry.title || '') : '';
    $('#editor-text').value = entry ? (entry.text || '') : '';
    $$('#mood-row .mood-options button').forEach(b => {
      b.classList.toggle('selected', !!entry && b.dataset.mood === entry.mood);
    });
    $('#editor-delete').classList.toggle('hidden', !entry);
    if (entry && entry.photoIds) {
      entry.photoIds.forEach(id => {
        editorPhotos.push({ id, url: Api.photoUrl(id), isNew: false });
      });
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
      img.src = p.isNew ? makeUrl(p.blob) : p.url;
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
        editorPhotos.push({ blob, isNew: true });
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
    const btn = $('#editor-save');
    btn.disabled = true;
    try {
      // 新しい写真をアップロード、削除された写真を削除
      for (const p of editorPhotos) {
        if (p.isNew && !p.id) {
          const base64 = await blobToBase64(p.blob);
          const { id } = await Api.uploadPhoto(editingDate, base64, 'image/jpeg');
          p.id = id;
        }
      }
      for (const id of removedPhotoIds) await Api.deletePhoto(id);
      await Api.putEntry({
        date: editingDate, title, text, mood,
        photoIds: editorPhotos.map(p => p.id),
      });
      toast('保存しました 🌿');
      showView('calendar');
    } catch (e) {
      handleError(e);
    } finally {
      btn.disabled = false;
    }
  });

  $('#editor-delete').addEventListener('click', async () => {
    if (!confirm('この日の日記と写真を削除します。よろしいですか?')) return;
    try {
      await Api.deleteEntry(editingDate);
      toast('削除しました');
      showView('calendar');
    } catch (e) { handleError(e); }
  });

  $('#editor-back').addEventListener('click', () => showView('calendar'));

  // ===== ギャラリー =====
  async function renderGallery() {
    let photos = [];
    try { photos = await Api.getPhotosMeta(); } catch (e) { handleError(e); return; }
    const grid = $('#gallery-grid');
    grid.innerHTML = '';
    $('#gallery-count').textContent = photos.length ? `${photos.length}枚の思い出` : '';
    $('#gallery-empty').classList.toggle('hidden', photos.length > 0);

    photos.forEach(p => {
      const item = document.createElement('button');
      item.className = 'gallery-item';
      const img = document.createElement('img');
      img.src = Api.photoUrl(p.id);
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
    $('#lightbox-img').src = Api.photoUrl(photo.id);
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
      const { publicKey } = await Api.vapidKey();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await Api.subscribe(sub.toJSON());
    localStorage.setItem(NOTIFY_KEY, '1');
    return sub;
  }

  async function disableNotifications() {
    const sub = await getSubscription();
    if (sub) {
      await Api.unsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe();
    }
    localStorage.removeItem(NOTIFY_KEY);
  }

  // ===== 設定 =====
  async function renderSettings() {
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

    if (currentUsername) {
      $('#account-info').textContent = `${currentUsername} さんとしてログイン中。日記はアカウントごとに分離して保存されます。`;
    }
    try {
      const entries = await Api.getEntries();
      const photos = await Api.getPhotosMeta();
      $('#storage-info').textContent = `日記 ${entries.length}件 / 写真 ${photos.length}枚`;
    } catch (e) {
      $('#storage-info').textContent = '';
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
    try {
      await Api.testPush(sub.endpoint);
      toast('テスト通知を送信しました');
    } catch (e) { handleError(e); }
  });

  $('#pw-change-btn').addEventListener('click', async () => {
    const current = $('#pw-current').value;
    const next = $('#pw-next').value;
    if (!current || !next) { toast('両方のパスワードを入力してください'); return; }
    try {
      await Api.changePassword(current, next);
      $('#pw-current').value = '';
      $('#pw-next').value = '';
      toast('パスワードを変更しました 🔒');
    } catch (e) { handleError(e); }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await Api.logout().catch(() => {});
    showLogin('login', 'ログアウトしました');
  });

  // ===== エクスポート / インポート =====
  $('#export-btn').addEventListener('click', () => {
    // Cookie認証なので直接ダウンロードできる
    const a = document.createElement('a');
    a.href = '/api/export';
    a.download = '';
    a.click();
  });

  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const result = await Api.import(data);
      toast(`${result.entries}件の日記を読み込みました`);
      renderSettings();
    } catch (err) {
      handleError(err.message ? err : new Error('ファイルを読み込めませんでした'));
    }
  });

  // ===== 旧バージョン(IndexedDB)からの移行 =====
  async function migrateLocalData() {
    if (localStorage.getItem('migrated-to-server')) return;
    try {
      if (typeof DiaryDB === 'undefined') return;
      const localEntries = await DiaryDB.getAllEntries();
      if (!localEntries.length) {
        localStorage.setItem('migrated-to-server', '1');
        return;
      }
      const serverEntries = await Api.getEntries();
      const serverDates = new Set(serverEntries.map(e => e.date));
      let migrated = 0;
      for (const entry of localEntries) {
        if (serverDates.has(entry.date)) continue;
        const newIds = [];
        for (const pid of (entry.photoIds || [])) {
          const photo = await DiaryDB.getPhoto(pid);
          if (!photo) continue;
          const base64 = await blobToBase64(photo.blob);
          const { id } = await Api.uploadPhoto(entry.date, base64, 'image/jpeg');
          newIds.push(id);
        }
        await Api.putEntry({
          date: entry.date, title: entry.title || '', text: entry.text || '',
          mood: entry.mood || null, photoIds: newIds,
        });
        migrated++;
      }
      localStorage.setItem('migrated-to-server', '1');
      if (migrated > 0) {
        toast(`この端末の日記${migrated}件をサーバーに移行しました`);
        renderCalendar();
      }
    } catch (e) {
      console.warn('移行をスキップ:', e.message);
    }
  }

  // ===== 起動 =====
  async function afterLogin() {
    const params = new URLSearchParams(location.search);
    if (params.get('write')) {
      history.replaceState(null, '', '/');
      await openEditor(todayStr());
    } else {
      showView('calendar');
    }
    migrateLocalData();
  }

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW登録失敗:', err));
    }
    try {
      const { hasUsers, authed, username } = await Api.status();
      if (authed) {
        currentUsername = username;
        hideLogin();
        await afterLogin();
      } else if (!hasUsers) {
        showLogin('register', 'ようこそ!最初のアカウントを作成してください');
      } else {
        showLogin('login');
      }
    } catch (e) {
      showLogin('login', 'サーバーに接続できません。通信環境を確認してください');
    }
  }

  init();
})();
