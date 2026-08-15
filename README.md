# 🌿 ひだまり日記

毎日の出来事や写真を保存して、あとからアーカイブとして見返せる日記帳PWAアプリ。

## 機能

- **ログイン** — ユーザー名+パスワードのアカウント制。複数ユーザー・複数デバイスに対応し、日記はアカウントごとに分離(セッションCookieで180日間有効、総当たり対策のレート制限つき)
  - 最初に登録したアカウントには、旧バージョン(シングルユーザー時代)のデータが自動で引き継がれます
- **カレンダービュー** — 月表示。日記のある日はドット、写真のある日はサムネイル表示。日付タップで日記作成/編集
- **日記作成** — タイトル・本文・気分(絵文字)・写真(複数枚、端末側で最大1600pxに圧縮してからアップロード)
- **ギャラリー** — すべての写真を新しい順に一覧。タップで拡大 → 日記へジャンプ
- **設定** — 通知のオン/オフ、パスワード変更、データのエクスポート/インポート
- **PWA** — ホーム画面に追加可能。アプリシェルはオフラインキャッシュ
- **リマインド通知** — 毎日22時(JST)にその日の日記が未登録なら、登録済みの全端末へプッシュ通知
- **Obsidian連携** — 専用のObsidianプラグイン(`obsidian-plugin/`)がVaultへ日記・写真を定期自動同期

## 技術構成

| 層 | 技術 |
|---|---|
| フロントエンド | Vanilla JS SPA + Service Worker |
| バックエンド | Node.js + Express |
| データベース | SQLite (better-sqlite3) — 日記・写真・購読情報・セッションをすべて保存 |
| 認証 | scryptハッシュ + セッションCookie (HttpOnly) |
| 通知 | Web Push (VAPID) + node-cron(22:00 JST) |

データはすべて `data/diary.db` の1ファイルに入るため、このファイルをコピーするだけでバックアップできます。

## ローカルでの起動

```bash
cd ~/diary-app
npm install
npm start
# → http://localhost:3000 (初回アクセス時にパスワードを設定)
```

VAPID鍵は初回起動時に自動生成されDBに保存されます。

## デプロイ

`Dockerfile` 同梱。要件は「**Node.jsが常駐でき、`data/` ディレクトリが永続化できて、HTTPSが付くこと**」の3つです。
22時のリマインドはサーバー内のcronが送るため、**リクエストがない時間帯にスリープする無料プランは不可**です。

| デプロイ先 | 目安費用 | 手順の概要 |
|---|---|---|
| **Fly.io(推奨)** | 月数百円程度 | `fly launch` → `fly volumes create data` → `[mounts]` で `/app/data` にマウント |
| **Railway** | 月$5〜 | GitHubリポジトリを接続 → Volume を `/app/data` に追加 |
| **VPS(さくら/Lightsail等)** | 月数百円〜 | `docker run -d -p 3000:3000 -v diary-data:/app/data <image>` + Caddy等でHTTPS化 |
| **自宅サーバー + Cloudflare Tunnel** | 無料 | `cloudflared tunnel` でHTTPS公開(マシン常時起動が必要) |

### Fly.io の例

```bash
fly launch --no-deploy        # アプリ作成(fly.tomlが生成される)
fly volumes create data --size 1
# fly.toml に追記:
# [mounts]
#   source = "data"
#   destination = "/app/data"
fly deploy
```

## スマホでの通知

1. デプロイしたHTTPSのURLをスマホで開く
2. **iPhone (iOS 16.4+)**: 共有メニュー →「ホーム画面に追加」→ 追加したアイコンから起動 → 設定画面で通知をオン
   ※ iOSではホーム画面に追加したPWAからのみ通知が使えます
3. **Android**: Chromeで開いて「アプリをインストール」→ 設定画面で通知をオン

設定画面の「テスト通知を送る」で疎通確認できます。

## バックアップ

- 設定 → エクスポート で全日記+写真をJSONでダウンロード(インポートで復元)
- またはサーバーの `data/diary.db` をそのままコピー

## Obsidian連携

専用のObsidianプラグイン(`obsidian-plugin/`)で、日記をVaultに自動同期できます。日記1件 = 1ノート(`YYYY-MM-DD.md`)、フロントマターに`hidamari_id`/`date`/`title`/`mood`/`tags`/`photos`を含むので、Dataviewでの一覧・検索や、Vault全体をAI(Claude Projects等)の資料として渡す用途に使えます。写真も添付フォルダに自動ダウンロードされます。

### セットアップ

1. **アプリ側**: 設定 → Obsidian連携 →「トークンを発行」→ 表示された `hdmr_...` をコピー(**この画面を閉じると二度と表示されません**)
2. **プラグインをビルド**:
   ```bash
   cd obsidian-plugin
   npm install
   npm run build
   ```
3. 生成された `main.js` と `manifest.json` を Vault の `.obsidian/plugins/hidamari-sync/` にコピー
4. Obsidianを再起動 → 設定 → コミュニティプラグイン →「Hidamari Diary Sync」を有効化
5. プラグインの設定タブに **バックエンドURL**(このアプリのURL)と **APIトークン**(手順1で発行したもの)を入力

これで、Obsidian起動中は指定間隔(デフォルト15分)で自動的に日記が同期されます。詳しい設定項目は [obsidian-plugin/README.md](obsidian-plugin/README.md) を参照してください。

トークンはアプリの設定画面からいつでも「失効」できます。第三者に渡すと日記を読み取られるため取り扱いに注意してください。
