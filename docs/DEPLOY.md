# 部署到火山引擎（一步一步）

> 目标形态：一台云服务器常驻跑 Node 服务 + SQLite，前面用 Caddy 或 Nginx 提供 HTTPS，
> 手机装打好包（指向你的域名）的 APK。

## 本次部署环境

| 项 | 值 |
|---|---|
| 实例 | `ecs.e-c1m2.large` · 2 核 4GiB（对本项目非常充裕，常驻内存约 60–90MB） |
| 地域 | 亚太东南（雅加达） |
| 备案 | **不需要**（境外地域），域名可直接解析过来用 80/443 |
| 仓库 | https://github.com/only-zh/keep-accounts |
| 访问延迟 | 中国大陆访问雅加达约 50–100ms，记账这种交互完全够用 |

### 最快路径（推荐先跑这个）

```bash
# 1. 服务器上（Ubuntu/Debian/CentOS 都行）
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/only-zh/keep-accounts/main/deploy/bootstrap.sh)"
#    或者先把代码拉下来再跑：
#    sudo REPO_URL=https://github.com/only-zh/keep-accounts bash deploy/bootstrap.sh

# 2. 填 SMTP（不填注册收不到验证码）
sudo -u keep nano /opt/keep-accounts/.env
sudo systemctl restart keep-accounts

# 3. 安全组放行 80/443 后，用域名访问；再打 APK
KA_API_BASE=https://你的域名 bash build.sh
```

脚本是幂等的，重复跑只会更新代码；不会覆盖已存在的 `.env`。

---

## 0. 你的选择（已确定，供对照）

| 项 | 你的选择 | 结果 |
|---|---|---|
| 地域 | 亚太东南（雅加达） | 境外地域，**不需要 ICP 备案**，域名可直接用 |
| 规格 | 2 核 4GiB | 远超需要（常驻 60–90MB），可同时跑备份/反代 |
| 访问方式 | 域名 + HTTPS | APK 里写 `https://你的域名`，凭证加密 |

> 如果以后换到**中国大陆地域**：需要 ICP 备案（约 1–4 周），备案完成前只能用 IP+端口内测。
> 其余步骤完全一样。

---

## 1. 放行端口（最容易踩的坑）

火山引擎控制台 → **云服务器 ECS → 安全组 → 入方向规则**，添加：

| 端口 | 来源 | 用途 |
|---|---|---|
| 22 | 你的公网 IP（别用 0.0.0.0/0） | SSH |
| 80 | 0.0.0.0/0 | 申请证书 + 跳转 HTTPS |
| 443 | 0.0.0.0/0 | 正式访问 |

默认安全组通常只放行 22，**不加 80/443 的话，手机永远连不上，而且报错看起来像"服务没起"**。

---

## 2. 系统准备（以 Ubuntu 22.04/24.04 为例）

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw rsync

# 专用低权限用户
sudo useradd -m -s /bin/bash keep
sudo mkdir -p /opt/keep-accounts
sudo chown keep:keep /opt/keep-accounts

# 主机防火墙（和云安全组是两层，都要放行）
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw --force enable
sudo ufw status
```

---

## 3. 安装 Node（要求 ≥ 22.17）

本项目用内置的 `node:sqlite`，**不需要任何 npm 依赖**，但 Node 版本有硬要求。

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v                                   # 应为 v22.17+ 或 v24.x
node -e "require('node:sqlite'); console.log('sqlite ok')"
```

> 会打印一条 `ExperimentalWarning: SQLite is an experimental feature`，**可以忽略**。
> 如果 Node 是 22.5–22.12，需要给启动命令加 `--experimental-sqlite`；22.17 起不需要。

国内网络慢，改用 nvm + 镜像：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
nvm install 22 && nvm alias default 22
```

---

## 4. 上传代码

**方式 A：git（推荐，但需要先建仓库）**

仓库已在本地初始化并提交，远端是 `https://github.com/only-zh/keep-accounts`（目前是空库）。
首次推送在你自己的电脑上执行（需要你的 GitHub 凭据）：

```bash
git push -u origin main          # 本地已配好 origin 与首次提交

# 服务器上
sudo -u keep git clone https://github.com/only-zh/keep-accounts /opt/keep-accounts
```

> 仓库是**公开**的，所以 `.env`、`data/`、`android/keystore/`、`android/assets/` 都已在 `.gitignore` 里排除；
> 文档里的邮箱也已改成 `example.com` 示例。推送前可以自己再 `git status` 确认一遍。

**方式 B：从本机推送**

```bash
rsync -av --delete \
  --exclude '.git' --exclude 'data' --exclude 'node_modules' \
  --exclude 'dist' --exclude '.cache' --exclude 'android-sdk' \
  ~/Desktop/git/keep-accounts/ keep@SERVER_IP:/opt/keep-accounts/
```

> 千万别把本地的 `data/` 覆盖上去（里面有开发期的演示账号和测试账本）。
> 仓库里没有 `node_modules`，因为**零依赖**，不需要 `npm install`。

---

## 5. 写 `.env`

```bash
sudo -u keep nano /opt/keep-accounts/.env
sudo chmod 600 /opt/keep-accounts/.env      # 里面有 SMTP 授权码和模型 Key
sudo mkdir -p /opt/keep-accounts/data
sudo chown -R keep:keep /opt/keep-accounts/data
```

最小可用配置（生产）：

```ini
# --- 监听：只对本机开放，由 Caddy/Nginx 对外 ---
HOST=127.0.0.1
PORT=8787
DB_PATH=/opt/keep-accounts/data/ledger.db

# --- 生产必须关掉验证码回显 ---
DEV_SHOW_CODE=false

# --- 邮件：QQ 邮箱示例（授权码不是登录密码）---
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@qq.com
SMTP_PASS=你的SMTP授权码
SMTP_FROM=you@qq.com
SMTP_FROM_NAME=记账本

# --- 智能解析（DeepSeek）：不填则按规则解析 ---
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-你的key

# --- 配额（按需调整）---
MAX_BOOKS_PER_ACCOUNT=10
MAX_MEMBERS_PER_BOOK=5
```

语音识别（可选，不配置时 App 会提示改用文字输入）：

```ini
ASR_PROVIDER=<服务商标识>
ASR_API_KEY=你的key
```

---

## 6. 让服务常驻（systemd）

启动前先跑一次自检（会检查 Node 版本、`node:sqlite`、`.env` 权限与 `DEV_SHOW_CODE`、数据目录可写性、端口占用）：

```bash
APP_DIR=/opt/keep-accounts bash /opt/keep-accounts/deploy/preflight.sh
```

然后装服务：

```bash
sudo cp /opt/keep-accounts/deploy/keep-accounts.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now keep-accounts

systemctl status keep-accounts --no-pager
journalctl -u keep-accounts -f          # 看实时日志
curl -s localhost:8787/api/health       # 应返回 {"ok":true,...}
```

服务单元已经做了：开机自启、崩溃 3 秒重启、只监听 127.0.0.1、强制 `DEV_SHOW_CODE=false`、
只允许写 `data/` 目录。

> ⚠️ 服务单元里**故意没有** `EnvironmentFile=.env`：程序自己会解析 `.env`，
> 而 systemd 的 `EnvironmentFile` 语法更严格（一行写错服务就起不来，报错还很难懂）。
> 代价是**环境变量优先级高于 `.env`**，所以 `HOST` 请用 `systemctl edit` 改，别改 `.env`。

---

## 7. 上 HTTPS（二选一）

### A. Caddy（最省事，自动申请+续期证书）

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp /opt/keep-accounts/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/ledger.example.com/你的域名/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### B. Nginx + certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp /opt/keep-accounts/deploy/nginx.conf /etc/nginx/conf.d/keep-accounts.conf
sudo sed -i 's/ledger.example.com/你的域名/g' /etc/nginx/conf.d/keep-accounts.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名
```

> 域名解析：在火山引擎「云解析 DNS」里加一条 A 记录指向服务器公网 IP，生效后再申请证书。

---

## 8. 域名（雅加达地域，无需备案）

境外地域不受 ICP 备案限制，域名解析到公网 IP 后即可直接用 80/443。

1. 在域名服务商（或火山「云解析 DNS」）加一条 **A 记录**指向实例公网 IP。
2. 等解析生效：`dig +short 你的域名` 能返回该 IP。
3. 按 §7 用 Caddy 或 Nginx + certbot 申请证书（Let's Encrypt 需要 80 端口可达）。

> 建议同时把域名解析到 IPv4 即可，本项目不依赖 IPv6。

如果暂时没有域名，可以先用 `http://公网IP:8787` 内测，但需要：

```bash
sudo systemctl edit keep-accounts
# [Service]
# Environment=HOST=0.0.0.0
sudo systemctl restart keep-accounts
```

并在安全组临时放行 8787。⚠️ 明文传输，仅限自己内测。

---

## 9. 打包 APK 指向你的域名

APK 里**没有**服务器设置项，地址是打包时写死的：

```bash
# 在开发机上
KA_API_BASE=https://你的域名 bash build.sh
# 产物：dist/keep-accounts.apk
```

把 APK 发给家人安装即可。**以后换域名/换 IP 都要重新打包**（或用 `?server=` 调试入口临时指向，但那只适合你自己排查）。

---

## 10. 备份（SQLite 是 WAL 模式，别直接 cp）

```bash
sudo cp /opt/keep-accounts/deploy/keep-accounts-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now keep-accounts-backup.timer

systemctl list-timers | grep backup          # 确认下次执行时间
sudo systemctl start keep-accounts-backup    # 立刻跑一次
ls -lh /opt/keep-accounts/backups/
```

脚本用 `VACUUM INTO` 生成一致性快照再 gzip，默认保留 14 天，不需要停服务。

**恢复**：

```bash
sudo systemctl stop keep-accounts
cd /opt/keep-accounts/data
sudo gunzip -c ../backups/ledger-YYYYmmdd-HHMMSS.db.gz > ledger.db
sudo rm -f ledger.db-wal ledger.db-shm        # 关键：清掉旧 WAL
sudo chown keep:keep ledger.db
sudo systemctl start keep-accounts
```

**异地备份**（建议）：把 `backups/` 同步到对象存储或另一台机器，例如

```bash
# 加进 backup.sh 末尾或单独 cron
rclone copy /opt/keep-accounts/backups remote:keep-accounts-backup/
```

---

## 11. 升级

```bash
cd /opt/keep-accounts
sudo -u keep git pull
sudo systemctl restart keep-accounts
journalctl -u keep-accounts -n 50 --no-pager
```

数据库结构变更会在启动时自动迁移；从 v1 升到 v2 时，旧表会被重命名成 `legacy_*` 保留，不会直接删。

---

## 11.1 时区

服务端算「今天/昨天」用的是 `.env` 里的 `TZ`（默认 `Asia/Shanghai`），**不是服务器系统时区**，
所以雅加达实例（UTC+7）也不会把日期算错。系统时区只影响日志可读性，建议设成同一个：

```bash
sudo timedatectl set-timezone Asia/Shanghai
timedatectl | head -3
```

但**系统时钟必须准确**（会话有效期按绝对时间判断）：`sudo timedatectl set-ntp true`。

---

## 12. 排错表

| 现象 | 常见原因 | 处理 |
|---|---|---|
| 手机一直"连不上服务器" | 安全组没放行 80/443；或 `HOST=127.0.0.1` 却直接用 IP:8787 访问 | 检查安全组 + ufw；临时内测时按 §8 改 HOST |
| 502 Bad Gateway | Node 进程没起 | `systemctl status keep-accounts` + `journalctl -u keep-accounts -n 100` |
| 注册收不到验证码 | SMTP 授权码错、端口 465 被限制、发件邮箱被拦 | 看日志里的 `[mail]` 行；用 `node tests/smtp.test.mjs` 在本机验证客户端逻辑 |
| 页面能开但接口 401 | 手机时间不准导致会话判定过期 | `timedatectl` 校时；`sudo timedatectl set-ntp true` |
| `SQLITE_BUSY` | 同一个库跑了多个实例 | 只留一个 systemd 实例；确认没有手工再起一个 |
| `node:sqlite` 报错 | Node 版本太低 | 升到 22.17+ 或 24.x |
| 语音按钮提示不支持 | 未配置 `ASR_*` | 属正常降级，改用文字输入 |
| 上传语音 413 | 反向代理体积上限太小 | Nginx `client_max_body_size 30m`（模板已配） |

---

## 13. 部署完的验收清单

```bash
curl -s https://你的域名/api/health
curl -s https://你的域名/api/config | head -c 300     # 确认 devShowCode=false、mail 已配置
```

- [ ] 浏览器打开 `https://你的域名` 能看到登录页
- [ ] 用真实邮箱注册，能收到验证码邮件
- [ ] 创建账本 → 成员面板出现二维码与邀请码
- [ ] 手机装 APK → 注册第二个账号 → 扫二维码加入账本
- [ ] 双方各发一条记账，互相能看到卡片与统计
- [ ] 创建者把对方设为管理员，验证「可修改他人卡片」
- [ ] 关掉手机网络，确认顶部出现「当前离线 · 只能查看已同步的记录」，发送的消息标红
- [ ] `systemctl start keep-accounts-backup` 后 `backups/` 有文件

---

## 14. 日常使用流程

1. **你**：注册 → 创建账本（名称 + 预设图标）→ 进「成员」面板，把二维码或邀请码发给家人。
2. **家人**：安装 APK → 注册 → 「＋ → 加入账本 → 扫一扫」。
3. **分工**：成员面板里可把某人设为管理员（能改任何人卡片、能移出成员）；普通成员只能改自己发的。
4. **记账**：长按底部按钮说话（如「昨天午饭 35」），或切到文字；管理员可用「@老婆 买菜 30」帮别人记。
5. **看账**：群聊页右上「明细」按天看流水，再点「统计」看图表；首页右上 🔍 可搜账本和记录。
6. **换设备**：同一个邮箱登录即可，数据在服务器上。

---

## 15. 成本参考

| 项 | 建议 | 说明 |
|---|---|---|
| 实例 | 2 核 2G | 本项目常驻内存约 60–90MB |
| 系统盘 | 40G | 数据量：1 万条记录约 3–5MB |
| 带宽 | 1–5 Mbps | 无图片；语音只在录音时短时上传 |
| 备份 | 本地 14 天 + 异地一份 | 见 §10 |
