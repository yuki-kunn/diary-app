# ひだまり日記 Sync — Obsidian プラグイン

「ひだまり日記」の日記・写真を、Obsidian の Vault に読み取り専用で定期同期するコミュニティプラグインです。

- Obsidian 起動中、指定間隔(デフォルト15分)で自動同期
- リボンアイコン/コマンドパレットから手動同期も可能
- アプリ側で削除された日記は、対応する Vault 内ノートを自動でゴミ箱へ移動(オプションでOFF可)
- ノートの対応付けは frontmatter の `hidamari_id`(=日付)で行うため、Vault 内でファイル名を変更しても同期が壊れない
- 写真は添付フォルダにダウンロードし、ノートから `![[ファイル名]]` で埋め込み。既にダウンロード済みの写真は再取得しない

## インストール(開発ビルドを手動配置)

まだコミュニティプラグイン一覧には未申請のため、手動でビルド・配置します。

```bash
cd obsidian-plugin
npm install
npm run build
```

`main.js` と `manifest.json` が生成されるので、これらを Vault の以下のフォルダにコピーします。

```
<あなたのVault>/.obsidian/plugins/hidamari-sync/
├── main.js
└── manifest.json
```

Obsidian を再起動(またはコマンドパレットで「Reload app without saving」)し、設定 → コミュニティプラグイン → 「Hidamari Diary Sync」を有効化してください。

## 設定

設定タブ(設定 → コミュニティプラグイン → Hidamari Diary Sync の歯車アイコン)から以下を入力します。

| 項目 | 説明 |
|---|---|
| バックエンドURL | 例: `https://your-app.up.railway.app` |
| APIトークン | アプリの設定画面「Obsidian連携」で発行した `hdmr_...` トークン |
| 同期先フォルダ | Vault内の日記ノート保存先(デフォルト `ひだまり日記`) |
| 写真の保存先フォルダ | Vault内の写真保存先(デフォルト `ひだまり日記/attachments`) |
| 自動同期間隔 | 分単位。`0` で自動同期を無効化(手動同期のみ) |
| 起動時に同期 | Obsidian起動直後に一度実行するか |
| 削除同期を有効化 | アプリ側で削除された日記のノートをゴミ箱へ移動するか |

設定後、「今すぐ同期」ボタンかリボンの ↻ アイコンで動作確認してください。

## 開発

```bash
npm run dev   # esbuild watch モード(main.js を再ビルドし続ける)
```

`npm run dev` 実行中に Vault の `.obsidian/plugins/hidamari-sync/` へ `main.js`/`manifest.json` をシンボリックリンクしておくと、保存のたびに Obsidian 側で「Reload app without saving」するだけで変更を確認できます。
