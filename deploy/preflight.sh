#!/usr/bin/env bash
#
# 记账本 · 部署前自检
#   用法：  APP_DIR=/opt/keep-accounts bash deploy/preflight.sh
#   作用：  在启动服务前把最常见的坑一次性查出来（Node 版本、sqlite、.env、数据目录、端口占用）

set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="$APP_DIR/.env"
DB_PATH_FROM_ENV="$( [ -f "$ENV_FILE" ] && grep -E '^DB_PATH=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true )"
DB_PATH="${DB_PATH:-${DB_PATH_FROM_ENV:-$APP_DIR/data/ledger.db}}"
PORT_FROM_ENV="$( [ -f "$ENV_FILE" ] && grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true )"
PORT="${PORT:-${PORT_FROM_ENV:-8787}}"

FAIL=0
ok()   { printf '  ✅ %s\n' "$1"; }
warn() { printf '  ⚠️  %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "目录: $APP_DIR"
echo

echo "1. Node 运行时"
if command -v node >/dev/null 2>&1; then
  V="$(node -v | sed 's/^v//')"
  MAJOR="${V%%.*}"; REST="${V#*.}"; MINOR="${REST%%.*}"
  if [ "$MAJOR" -gt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -ge 17 ]; }; then
    ok "Node v$V"
  else
    bad "Node v$V 太低，需要 >= 22.17（或 24.x），否则 node:sqlite 可能不可用"
  fi
else
  bad "找不到 node，请先安装 Node"
fi

if node -e "require('node:sqlite')" >/dev/null 2>&1; then
  ok "node:sqlite 可用"
else
  bad "node:sqlite 不可用（Node 版本过低？）"
fi

echo
echo "2. 配置文件"
if [ -f "$ENV_FILE" ]; then
  ok ".env 存在"
  PERM="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  if [ "$PERM" = "600" ] || [ "$PERM" = "400" ]; then ok ".env 权限 $PERM"; else warn ".env 权限是 $PERM，建议 chmod 600（里面有 SMTP 授权码和 Key）"; fi
  if grep -qiE '^DEV_SHOW_CODE=(true|1|yes)$' "$ENV_FILE"; then
    bad "DEV_SHOW_CODE=true：验证码会回显到接口，生产环境必须改成 false"
  else
    ok "DEV_SHOW_CODE 未开启"
  fi
  if grep -qE '^SMTP_PASS=.+' "$ENV_FILE"; then ok "SMTP 已配置"; else warn "SMTP 未配置：注册验证码会走开发模式（仅内测可用）"; fi
  if grep -qE '^(DEEPSEEK_API_KEY|LLM_API_KEY)=.+' "$ENV_FILE"; then ok "模型 Key 已配置"; else warn "未配置模型 Key：解析会退化为本地规则"; fi
else
  warn ".env 不存在，可先 cp .env.example .env 再填（服务仍能起，但邮件/模型不可用）"
fi

echo
echo "3. 数据目录"
DB_DIR="$(dirname "$DB_PATH")"
if [ -d "$DB_DIR" ]; then
  if [ -w "$DB_DIR" ]; then ok "可写: $DB_DIR"; else bad "不可写: $DB_DIR（sudo chown -R keep:keep \"$DB_DIR\"）"; fi
else
  bad "数据目录不存在: $DB_DIR（mkdir -p 并 chown 给运行用户）"
fi
if [ -f "$DB_PATH" ]; then
  ok "数据库已存在: $(du -h "$DB_PATH" | cut -f1)"
else
  warn "数据库还没创建（首次启动会自动建表）"
fi

echo
echo "4. 端口"
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then
  warn "端口 $PORT 已被占用（如果就是本服务在跑，属正常）"
elif command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  warn "端口 $PORT 已被占用（如果就是本服务在跑，属正常）"
else
  ok "端口 $PORT 空闲"
fi

echo
echo "5. 依赖"
if [ -d "$APP_DIR/node_modules" ]; then
  warn "存在 node_modules —— 本项目零依赖，通常不需要；确认不是误装的旧版本"
else
  ok "无外部依赖（不需要 npm install）"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  echo "有 $FAIL 项需要处理，先别急着启动服务。"
  exit 1
fi
echo "自检通过，可以启动：sudo systemctl enable --now keep-accounts"
