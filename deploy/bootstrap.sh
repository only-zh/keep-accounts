#!/usr/bin/env bash
#
# 记账本 · 一键部署（Ubuntu / Debian / CentOS / RHEL / veLinux）
#
#   sudo bash deploy/bootstrap.sh              # 完整执行
#   sudo bash deploy/bootstrap.sh --dry-run    # 只打印将要做什么，不动系统
#
# 可覆盖的变量（写在命令前）：
#   REPO_URL   仓库地址（默认 https://github.com/only-zh/keep-accounts）
#   APP_DIR    安装目录（默认 /opt/keep-accounts）
#   APP_USER   运行用户（默认 keep）
#   NODE_MAJOR Node 主版本（默认 22）
#
# 脚本是幂等的：重复执行只会更新代码、重装服务单元，不会覆盖已存在的 .env。

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/only-zh/keep-accounts}"
APP_DIR="${APP_DIR:-/opt/keep-accounts}"
APP_USER="${APP_USER:-keep}"
NODE_MAJOR="${NODE_MAJOR:-22}"
DRY_RUN=0
SELFTEST=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  --self-test) SELFTEST=1 ;;
esac

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run() {
  if [ "${DRY_RUN}" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi
}

# ---- 自测：--self-test 只验证「已有 data/ 的目录能否正确拉取代码」 ----
if [ "${SELFTEST}" = "1" ]; then
  SRC="$(cd "$(dirname "$0")/.." && pwd)"
  TMP="$(mktemp -d)"
  APP_DIR="${TMP}/app"
  REPO_URL="file://${SRC}"
  mkdir -p "${APP_DIR}/data"
  echo "existing-db" > "${APP_DIR}/data/ledger.db"
  info() { printf '  %s\n' "$*"; }
  say()  { printf '\n▸ %s\n' "$*"; }
  die()  { printf '✗ %s\n' "$*" >&2; exit 1; }
  run()  { eval "$@"; }
  say "自测：目录里已有 data/ 时拉取代码"
  ensure_code_placeholder=1
  # 复用正式流程里的 ensure_code 定义
  eval "$(sed -n '/^ensure_code() {/,/^}/p' "$0")"
  ensure_code "${APP_DIR}" "${REPO_URL}"
  FAIL=0
  [ -d "${APP_DIR}/.git" ] || { echo "  ❌ 没有 clone 成功"; FAIL=1; }
  [ "$(cat "${APP_DIR}/data/ledger.db" 2>/dev/null)" = "existing-db" ] || { echo "  ❌ 原有 data/ 丢失"; FAIL=1; }
  [ -f "${APP_DIR}/package.json" ] || { echo "  ❌ 代码文件缺失"; FAIL=1; }
  rm -rf "${TMP}"
  [ "${FAIL}" = "0" ] && echo "  ✅ 自测通过：代码已拉取，原有 data/ 完整保留" || exit 1
  exit 0
fi

say "0. 环境检查"
[ "$(uname -s)" = "Linux" ] || { [ "${DRY_RUN}" = "1" ] || die "这个脚本要在 Linux 上跑（当前是 $(uname -s)）"; }
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
  *rhel*|*centos*|*fedora*|*fedora*) PKG="dnf" ;;
  *ve*|*alinux*) PKG="dnf" ;;
  *) PKG="apt" ;;
esac
[ "${DRY_RUN}" = "1" ] && [ "${OS_ID}" = "unknown" ] && PKG="apt"
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
if [ "$need_node" = "1" ]; then
  info "通过 NodeSource 安装 Node ${NODE_MAJOR}.x"
  if [ "${PKG}" = "apt" ]; then
    run "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
    run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs"
  else
    run "curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
    run "dnf install -y -q nodejs"
  fi
  # 兜底：NodeSource 不可用时用官方二进制包
  if [ "${DRY_RUN}" = "0" ]; then
    if ! command -v node >/dev/null 2>&1; then
      warn "NodeSource 安装失败，改用官方二进制包"
      ARCH="$(uname -m)"; case "${ARCH}" in x86_64) A=linux-x64 ;; aarch64) A=linux-arm64 ;; *) die "不支持的架构 ${ARCH}" ;; esac
      TMP="$(mktemp -d)"
      curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" -o "${TMP}/index.html"
      FILE="$(grep -o "node-v[0-9.]*-${A}\.tar\.xz" "${TMP}/index.html" | head -1)"
      [ -n "${FILE}" ] || die "拿不到 Node 二进制包名"
      curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${FILE}" -o "${TMP}/node.tar.xz"
      tar -xJf "${TMP}/node.tar.xz" -C /usr/local --strip-components=1
      rm -rf "${TMP}"
    fi
    node -v | grep -qE '^v(2[2-9]|[3-9][0-9])\.' || die "Node 版本仍不满足要求"
    info "Node $(node -v) 就绪"
  fi
fi

say "3. 创建运行用户与目录"
run "id -u ${APP_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${APP_USER}"
run "mkdir -p ${APP_DIR}"

say "4. 拉取代码"
# 允许目录里只有 data/（脚本自己或上次部署留下的），clone 时把数据挪开再放回，绝不删除
ensure_code() {
  local dir="$1" url="$2"
  if [ -d "${dir}/.git" ]; then
    info "已存在仓库，执行更新"
    run "git -C ${dir} pull --ff-only"
    return 0
  fi
  local others
  others="$(ls -A "${dir}" 2>/dev/null | grep -vx 'data' || true)"
  if [ -n "${others}" ]; then
    die "${dir} 里有其它内容（$(echo "${others}" | tr '\n' ' ')），请先清理或换 APP_DIR"
  fi
  if [ -d "${dir}/data" ]; then
    info "检测到已有 data/ 目录：clone 时会原样保留"
    run "mv ${dir}/data ${dir}.data.bak"
    run "rmdir ${dir} 2>/dev/null || true"
    run "git clone --depth 1 ${url} ${dir}"
    run "mv ${dir}.data.bak ${dir}/data"
  else
    run "git clone --depth 1 ${url} ${dir}"
  fi
}

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
  info "已从 .env.example 生成 .env（需要你填写 SMTP / 模型 Key）"
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
  warn "还没有配置 SMTP，先不启动（否则注册会收不到验证码）"
  warn "填好 ${APP_DIR}/.env 里的 SMTP_* 后执行：sudo systemctl restart keep-accounts"
fi

say "完成。接下来："
cat <<EOF

  1) 防火墙
     云控制台安全组放行 80/443（火山引擎默认只开 22）
     系统内：ufw allow 80,443/tcp   （或 firewall-cmd --add-service={http,https} --permanent）

  2) 域名 + HTTPS（雅加达地域无需 ICP 备案）
     把域名 A 记录指向本机公网 IP，然后：
       sudo apt install -y caddy && sudo cp ${APP_DIR}/deploy/Caddyfile /etc/caddy/Caddyfile
       sudo sed -i 's/ledger.example.com/你的域名/' /etc/caddy/Caddyfile && sudo systemctl reload caddy

  3) 打 APK（在你自己的电脑上）
       KA_API_BASE=https://你的域名 bash build.sh

  4) 常用命令
       查看日志   journalctl -u keep-accounts -f
       重启       sudo systemctl restart keep-accounts
       更新代码   cd ${APP_DIR} && sudo -u ${APP_USER} git pull && sudo systemctl restart keep-accounts
       手动备份   sudo APP_DIR=${APP_DIR} bash ${APP_DIR}/deploy/backup.sh

EOF
