/**
 * パスワードリセット用ワンショットスクリプト
 * 使い方: node scripts/reset-password.js <ユーザー名> <新しいパスワード>
 *
 * Railway上で1回だけ実行することを想定。DATA_DIR環境変数(本番のSQLiteパス)を
 * server.jsと同じロジックで解決するため、実行環境の設定をそのまま使う。
 */
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const [, , username, newPassword] = process.argv;
if (!username || !newPassword) {
  console.error('使い方: node scripts/reset-password.js <ユーザー名> <新しいパスワード>');
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error('パスワードは6文字以上にしてください');
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = new Database(path.join(DATA_DIR, 'diary.db'));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`ユーザー「${username}」が見つかりません。登録済みのユーザー名一覧:`);
  db.prepare('SELECT username FROM users').all().forEach(u => console.error(' - ' + u.username));
  process.exit(1);
}

db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
// 念のため全端末のセッションを失効させ、新パスワードで再ログインしてもらう
const deleted = db.prepare('DELETE FROM tokens WHERE user_id = ?').run(user.id);

console.log(`✅ ユーザー「${user.username}」のパスワードをリセットしました。`);
console.log(`   既存セッション ${deleted.changes} 件を失効させました(全端末で再ログインが必要です)。`);
