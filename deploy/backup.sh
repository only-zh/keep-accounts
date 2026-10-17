#!/usr/bin/env bash
#
# 记账本 · WAL 安全的在线备份
#
#   用法：  APP_DIR=/opt/keep-accounts bash deploy/backup.sh
#   安装：  配合 deploy/keep-accounts-backup.timer 每天 03:30 自动执行
#
# 为什么不能直接 cp：数据库是 WAL 模式，新写入可能还在 -wal 文件里，
# 只复制主库会丢数据。这里用 VACUUM INTO 生成一致性快照，不需要停服务。

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/keep-accounts}"
DB_PATH="${DB_PATH:-$APP_DIR/data/ledger.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

if [ ! -f "$DB_PATH" ]; then
  echo "找不到数据库：$DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/ledger-$STAMP.db"

# VACUUM INTO 需要目标文件不存在
rm -f "$TARGET"

node -e '
  const { DatabaseSync } = require("node:sqlite");
  const [src, dst] = process.argv.slice(1);
  const db = new DatabaseSync(src);
  // VACUUM INTO 会写出一份紧凑、事务一致的副本（含 -wal 中已提交的内容）
  db.exec(`VACUUM INTO ${JSON.stringify(dst).replace(/^"|"$/g, "\x27")}`);
  const check = db.prepare("PRAGMA integrity_check").get();
  const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type=\x27table\x27").get();
  console.log(`校验: ${JSON.stringify(check)} · 表数量 ${tables.n}`);
  db.close();
' "$DB_PATH" "$TARGET" 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings

gzip -f "$TARGET"
SIZE="$(du -h "$TARGET.gz" | cut -f1)"
echo "已备份: $TARGET.gz ($SIZE)"

# 清理过期备份
find "$BACKUP_DIR" -name 'ledger-*.db.gz' -type f -mtime "+$KEEP_DAYS" -print -delete \
  | sed 's/^/已清理过期备份: /' || true

echo "当前备份数量: $(find "$BACKUP_DIR" -name 'ledger-*.db.gz' -type f | wc -l | tr -d ' ')"
