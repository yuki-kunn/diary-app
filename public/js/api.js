/* サーバーAPI クライアント */
const Api = (() => {
  async function req(path, options = {}) {
    let res;
    try {
      res = await fetch(path, {
        headers: options.body ? { 'Content-Type': 'application/json' } : {},
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (e) {
      throw new Error('サーバーに接続できません');
    }
    if (!res.ok) {
      let msg = res.status === 401 ? 'ログインが必要です' : 'エラーが発生しました';
      try { msg = (await res.json()).error || msg; } catch {}
      const err = new Error(msg);
      if (res.status === 401) err.unauthorized = true;
      throw err;
    }
    return res.json();
  }

  return {
    // 認証
    status: () => req('/api/auth/status'),
    setup: (password) => req('/api/auth/setup', { method: 'POST', body: { password } }),
    login: (password) => req('/api/auth/login', { method: 'POST', body: { password } }),
    logout: () => req('/api/auth/logout', { method: 'POST' }),
    changePassword: (current, next) => req('/api/auth/change', { method: 'POST', body: { current, next } }),

    // 日記
    getEntries: () => req('/api/entries'),
    getEntry: async (date) => {
      try { return await req(`/api/entries/${date}`); }
      catch (e) { if (e.unauthorized) throw e; return null; }
    },
    putEntry: (entry) => req(`/api/entries/${entry.date}`, { method: 'PUT', body: entry }),
    deleteEntry: (date) => req(`/api/entries/${date}`, { method: 'DELETE' }),

    // 写真
    getPhotosMeta: () => req('/api/photos-meta'),
    uploadPhoto: (date, base64, mime) => req('/api/photos', { method: 'POST', body: { date, base64, mime } }),
    deletePhoto: (id) => req(`/api/photos/${id}`, { method: 'DELETE' }),
    photoUrl: (id) => `/api/photos/${id}`,

    // データ
    import: (data) => req('/api/import', { method: 'POST', body: data }),

    // 通知
    vapidKey: () => req('/api/vapid-public-key'),
    subscribe: (subscription) => req('/api/subscribe', { method: 'POST', body: { subscription } }),
    unsubscribe: (endpoint) => req('/api/unsubscribe', { method: 'POST', body: { endpoint } }),
    testPush: (endpoint) => req('/api/test-push', { method: 'POST', body: { endpoint } }),
  };
})();
