#!/usr/bin/env bash
#
# 记账本 · 一键部署（Ubuntu / Debian / CentOS / RHEL / veLinux）
#
#   sudo bash deploy/bootstrap.sh              # 完整执行
#   sudo bash deploy/bootstrap.sh --adopt      # 接管已有目录（手动上传的代码，无 .git）
#   sudo bash deploy/bootstrap.sh --dry-run    # 只打印将要做什么，不动系统
#   bash deploy/bootstrap.sh --self-test       # 只验证目录处理逻辑（不需要 root）
#
# 可覆盖的变量：REPO_URL / APP_DIR / APP_USER / NODE_MAJOR
# 脚本幂等：重复执行只更新代码；不会覆盖已存在的 .env；不会动 data/。

set -euo pipefail

SCRIPT_VERSION="2026-10-17.4"
REPO_URL="${REPO_URL:-https://github.com/only-zh/keep-accounts}"
APP_DIR="${APP_DIR:-/opt/keep-accounts}"
APP_USER="${APP_USER:-keep}"
NODE_MAJOR="${NODE_MAJOR:-22}"

DRY_RUN=0
SELFTEST=0
ADOPT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --self-test) SELFTEST=1 ;;
    --adopt) ADOPT=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run()  {
  if [ "${DRY_RUN}" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi
}

# ============================================================
# 目录处理：三种情形
#   A. 已是 git 仓库            → pull
#   B. 只有 data/（或空目录）    → clone，data/ 挪开再放回
#   C. 有其它文件但没有 .git     → 报错说明；加 --adopt 则接管
# ============================================================
ensure_code() {
  local dir="$1" url="$2"
  local others

  if [ -d "${dir}/.git" ]; then
    info "已存在 git 仓库，执行更新"
    run "git -C ${dir} pull --ff-only"
    return 0
  fi

  others="$(ls -A "${dir}" 2>/dev/null | grep -vx 'data' || true)"

  if [ -n "${others}" ]; then
    if [ "${ADOPT}" = "1" ]; then
      info "接管已有目录（视为手动上传的代码）：git init → 对齐到 ${url} 的 main"
      info "保留：.env、data/；未提交的改动会被远端覆盖"
      run "git -C ${dir} init -q"
      run "git -C ${dir} remote remove origin 2>/dev/null || true"
      run "git -C ${dir} remote add origin ${url}"
      run "git -C ${dir} fetch --depth 1 origin main"
      run "git -C ${dir} checkout -f -B main origin/main"
      return 0
    fi
    printf '\n  目录里现有：%s\n\n' "$(echo "${others}" | tr '\n' ' ')"
    die "${dir} 不是 git 仓库，但里面有其它文件。请二选一：
   · 接管它（保留 .env 和 data/，未提交改动会丢）：
       sudo bash $0 --adopt
   · 从零部署（会删除该目录，里面的数据库也会没）：
       sudo rm -rf ${dir} && 重新执行本脚本
   也可以换目录：sudo APP_DIR=/srv/keep-accounts bash $0"
  fi

  if [ -d "${dir}/data" ]; then
    info "检测到已有 data/：clone 时先挪开，结束时原样放回"
    run "mv ${dir}/data ${dir}.data.bak"
    run "rmdir ${dir} 2>/dev/null || true"
    run "git clone --depth 1 ${url} ${dir}"
    run "mv ${dir}.data.bak ${dir}/data"
  else
    info "空目录或无目录，直接 clone"
    run "git clone --depth 1 ${url} ${dir}"
  fi
}

# ============================================================
# 自测（不碰系统，不需要 root）
# ============================================================
if [ "${SELFTEST}" = "1" ]; then
  SRC="$(cd "$(dirname "$0")/.." && pwd)"
  REPO_URL="file://${SRC}"
  FAIL=0
  eval "$(sed -n '/^ensure_code() {/,/^}/p' "$0")"
  say "自测 1：目录里只有 data/"
  T1="$(mktemp -d)/app"
  mkdir -p "${T1}/data"
  echo "existing-db" > "${T1}/data/ledger.db"
  ensure_code "${T1}" "${REPO_URL}" >/dev/null 2>&1 || FAIL=1
  [ -d "${T1}/.git" ] || { echo "  ❌ 没有 clone 成功"; FAIL=1; }
  [ "$(cat "${T1}/data/ledger.db" 2>/dev/null)" = "existing-db" ] || { echo "  ❌ 原有 data/ 丢了"; FAIL=1; }
  [ -f "${T1}/package.json" ] || { echo "  ❌ 代码文件缺失"; FAIL=1; }
  rm -rf "$(dirname "${T1}")"

  say "自测 2：有代码但没有 .git（手动上传的情形）"
  T2="$(mktemp -d)/app"
  mkdir -p "${T2}/server"
  echo '{}' > "${T2}/package.json"
  echo 'x' > "${T2}/server/index.js"
  echo 'PORT=1' > "${T2}/.env"
  set +e
  # 用子 shell 隔离：这一支会调用 die（内含 exit），不能让它退出整个脚本
  ( ADOPT=0; ensure_code "${T2}" "${REPO_URL}" ) >/dev/null 2>&1
  NO_ADOPT=$?
  set -e
  [ "${NO_ADOPT}" -ne 0 ] || { echo "  ❌ 未加 --adopt 时不该直接通过"; FAIL=1; }
  ADOPT=1
  ensure_code "${T2}" "${REPO_URL}" >/dev/null 2>&1 || { echo "  ❌ --adopt 执行失败"; FAIL=1; }
  [ -d "${T2}/.git" ] || { echo "  ❌ 接管后没有 .git"; FAIL=1; }
  [ -f "${T2}/deploy/bootstrap.sh" ] || { echo "  ❌ 接管后没拉到远端文件"; FAIL=1; }
  [ "$(cat "${T2}/.env" 2>/dev/null)" = "PORT=1" ] || { echo "  ❌ 接管时丢了本地 .env"; FAIL=1; }
  rm -rf "$(dirname "${T2}")"

  if [ "${FAIL}" = "0" ]; then
    echo "  ✅ 两种情形都符合预期"
    exit 0
  fi
  exit 1
fi

# ============================================================
# 正式部署
# ============================================================
say "0. 环境检查（bootstrap v${SCRIPT_VERSION}）"
if [ "$(uname -s)" != "Linux" ]; then
  [ "${DRY_RUN}" = "1" ] || die "这个脚本要在 Linux 上跑（当前是 $(uname -s)）"
fi
if [ "${DRY_RUN}" = "1" ]; then
  info "dry-run 模式：不会修改系统"
else
  [ "$(id -u)" -eq 0 ] || { info "需要 root，正在用 sudo 重新执行…"; exec sudo -E bash "$0" "$@"; }
fi

OS_ID="unknown"; OS_LIKE=""
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_LIKE="${ID_LIKE:-}"
fi
case "${OS_ID} ${OS_LIKE}" in
  *debian*|*ubuntu*) PKG="apt" ;;
  *) PKG="dnf" ;;
esac
[ -f /etc/debian_version ] && PKG="apt"
[ "${OS_ID}" = "unknown" ] && [ "${DRY_RUN}" = "1" ] && PKG="apt"
info "发行版: ${OS_ID}（包管理器: ${PKG}）"
info "安装目录: ${APP_DIR}　运行用户: ${APP_USER}　仓库: ${REPO_URL}"

say "1. 安装基础依赖"
if [ "${PKG}" = "apt" ]; then
  run "apt-get update -qq"
  run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates tar xz-utils"
else
  run "dnf install -y -q git curl ca-certificates tar xz"
fi

say "2. Node 运行时（需要 >= 22.17）"
need_node=1
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v | sed 's/^v//')"
  MAJOR="${NODE_V%%.*}"; MINOR="$(echo "${NODE_V}" | cut -d. -f2)"
  if [ "${MAJOR}" -gt 22 ] || { [ "${MAJOR}" -eq 22 ] && [ "${MINOR}" -ge 17 ]; }; then
    need_node=0
    info "已有 Node v${NODE_V}，跳过安装"
  else
    warn "已有 Node v${NODE_V} 偏低，将升级"
  fi
fi
if [ "${need_node}" = "1" ]; then
  info "通过 NodeSource 安装 Node ${NODE_MAJOR}.x"
  if [ "${PKG}" = "apt" ]; then
    run "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
    run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs"
  else
    run "curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
    run "dnf install -y -q nodejs"
  fi
  if [ "${DRY_RUN}" = "0" ] && ! command -v node >/dev/null 2>&1; then
    warn "NodeSource 安装失败，改用官方二进制包"
    ARCH="$(uname -m)"
    case "${ARCH}" in x86_64) A=linux-x64 ;; aarch64) A=linux-arm64 ;; *) die "不支持的架构 ${ARCH}" ;; esac
    TMPD="$(mktemp -d)"
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" -o "${TMPD}/index.html"
    FILE="$(grep -o "node-v[0-9.]*-${A}\.tar\.xz" "${TMPD}/index.html" | head -1)"
    [ -n "${FILE}" ] || die "拿不到 Node 二进制包名"
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${FILE}" -o "${TMPD}/node.tar.xz"
    tar -xJf "${TMPD}/node.tar.xz" -C /usr/local --strip-components=1
    rm -rf "${TMPD}"
  fi
  if [ "${DRY_RUN}" = "0" ]; then
    node -v | grep -qE '^v(2[2-9]|[3-9][0-9])\.' || die "Node 版本仍不满足要求"
    info "Node $(node -v) 就绪"
  fi
fi

say "3. 创建运行用户与目录"
run "id -u ${APP_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${APP_USER}"
run "mkdir -p ${APP_DIR}"

say "4. 拉取代码"
ensure_code "${APP_DIR}" "${REPO_URL}"
run "mkdir -p ${APP_DIR}/data"
run "chown -R ${APP_USER}:${APP_USER} ${APP_DIR}"

say "5. 配置文件"
SMTP_READY=0
if [ -f "${APP_DIR}/.env" ]; then
  info ".env 已存在，保留不动"
  grep -qE '^SMTP_PASS=.+' "${APP_DIR}/.env" && SMTP_READY=1
else
  run "cp ${APP_DIR}/.env.example ${APP_DIR}/.env"
  run "chmod 600 ${APP_DIR}/.env"
  run "chown ${APP_USER}:${APP_USER} ${APP_DIR}/.env"
  info "已从 .env.example 生成 .env（需要填写 SMTP / 模型 Key）"
fi

say "6. 安装 systemd 服务"
run "sed -e 's#/opt/keep-accounts#${APP_DIR}#g' -e 's/^User=keep/User=${APP_USER}/' -e 's/^Group=keep/Group=${APP_USER}/' ${APP_DIR}/deploy/keep-accounts.service > /etc/systemd/system/keep-accounts.service"
run "systemctl daemon-reload"
run "systemctl enable keep-accounts >/dev/null 2>&1 || true"

say "7. 部署前自检"
if [ "${DRY_RUN}" = "0" ]; then
  APP_DIR="${APP_DIR}" bash "${APP_DIR}/deploy/preflight.sh" || true
fi

say "8. 启动"
if [ "${SMTP_READY}" = "1" ] || [ "${DRY_RUN}" = "1" ]; then
  run "systemctl restart keep-accounts"
  run "sleep 1"
  if [ "${DRY_RUN}" = "0" ]; then
    systemctl is-active --quiet keep-accounts && info "服务已启动" || warn "服务未启动，查看：journalctl -u keep-accounts -n 50"
    curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 && info "健康检查通过" || warn "健康检查失败"
  fi
else
  warn "还没有配置 SMTP，先不启动（否则注册收不到验证码）"
  warn "填好 ${APP_DIR}/.env 里的 SMTP_* 后执行：sudo systemctl restart keep-accounts"
fi

say "完成。接下来："
cat <<TIPS

  1) 防火墙：云控制台安全组放行 80/443（火山默认只开 22）
     系统内：ufw allow 80,443/tcp   或   firewall-cmd --add-service={http,https} --permanent

  2) 域名 + HTTPS（雅加达地域无需备案）
     域名 A 记录指向公网 IP 后：
       sudo apt install -y caddy && sudo cp ${APP_DIR}/deploy/Caddyfile /etc/caddy/Caddyfile
       sudo sed -i 's/ledger.example.com/你的域名/' /etc/caddy/Caddyfile && sudo systemctl reload caddy

  3) 打 APK（在你自己的电脑上）
       KA_API_BASE=https://你的域名 bash build.sh

  4) 常用命令
       日志   journalctl -u keep-accounts -f
       重启   sudo systemctl restart keep-accounts
       更新   cd ${APP_DIR} && sudo -u ${APP_USER} git pull && sudo systemctl restart keep-accounts
       备份   sudo APP_DIR=${APP_DIR} bash ${APP_DIR}/deploy/backup.sh

TIPS
