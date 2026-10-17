# 记账本 · 商业版架构设计（v2）

> 状态：**已实现并验证**（schema v2 / API 2.0.0）。
> 与 v1 的关键差异：引入账号体系与多租户隔离、按账本的角色权限、配额与邀请码；
> **删除**了 v1 的「设备本地多用户档案 / 纯本地模式 / 离线入账队列」，改为「服务器唯一权威 + 断网只读缓存 + 发送失败标红」。
>
> v1 设计稿保留在 git 历史里；本文以当前代码为准。

---

## 1. 目标与不变量

| 目标 | 落地方式 |
|---|---|
| 可商业化：账号、订阅前提下的多租户 | 邮箱验证注册 + scrypt 密码 + Bearer 会话；所有数据按 `book_id` 隔离 |
| 一个账本 = 一个群 | 成员共享聊天流与记账卡片，互相可见 |
| 谁能改哪张卡片必须明确 | `author_account_id`（谁发的）与 `payer_account_id`（谁花的钱）分离 + 角色矩阵 |
| 资源必须有上限 | 每账号创建 10 个账本 / 每账本 5 人，服务端强校验 |
| 不允许断网使用 | 断网只读缓存；发送失败标红可重试，**不入账** |

三条不变量（改代码时最容易破坏）：

1. **数据接口必须先确定账本作用域**。任何 `/api/*` 除非显式公开，都必须 `requireAuth()` + `assertMember(bookId, accountId)`，否则就是越权。
2. **权限只认服务端**。前端 `store.canEdit()` 只用于显示「编辑 ›」或「详情 ›」，`PATCH/DELETE` 一律由 `Store.assertCanEdit()` 复核。
3. **金额一律整数分**（`amount_cents`），避免浮点误差。

---

## 2. 数据模型（schema v2）

```
accounts          id, email UNIQUE, display_name, emoji, color,
                  password_hash, password_salt, email_verified, status, created_at, last_login_at
sessions          token PK, account_id, created_at, expires_at, last_seen_at, user_agent
email_codes       id, email, code, purpose(register|reset), attempts,
                  expires_at, consumed_at, created_at
books             id, name, emoji, owner_account_id, invite_code UNIQUE,
                  currency, is_archived, created_at
book_members      book_id, account_id, role(owner|admin|member), invited_by, joined_at
records           id, book_id, author_account_id, payer_account_id, type, amount_cents,
                  currency, category, subcategory, merchant, note,
                  occurred_at, occurred_date, occurred_time, occurred_text,
                  source, raw_text, confidence, status, group_id,
                  client_msg_id UNIQUE, version, participants_json,
                  created_at, updated_at, deleted_at
messages          id, book_id, author_account_id, role(user|assistant), kind, content, payload_json, created_at
ai_audit          id, kind, provider, model, account_id, input_text, output_text,
                  latency_ms, ok, error, created_at
settings          key PK, value
```

要点：

- **两个"人"**：`author_account_id` 决定"谁是这张卡片的作者（能否修改）"；`payer_account_id` 决定"这笔钱算谁的"。管理员 `@张三 买菜 30` 时，author 是自己、payer 是张三。
- `participants_json` 存 `[{accountId, name, shareCents}]`（AA 分摊），不进独立表——它只被统计读取，不参与账务冲销。
- `client_msg_id` 唯一索引 = 幂等键：网络重试、重复点击都只入一笔。
- `version` = 乐观锁：多人同时改同一条会 409。
- `email_codes.purpose` 已预留 `reset`（找回密码未做，表结构就绪）。
- v1 → v2 迁移：旧表重命名为 `legacy_*_<时间戳>` 备份（旧结构没有邮箱密码，无法安全映射成账号），业务表重建。

---

## 3. 角色与权限矩阵

| 能力 | owner | admin | member |
|---|---|---|---|
| 查看明细 / 表格 / 统计 | ✅ | ✅ | ✅ |
| 修改/删除**自己发送**的记录 | ✅ | ✅ | ✅ |
| 修改/删除**任何人**的记录 | ✅ | ✅ | ❌ 403 `NOT_AUTHOR` |
| `@某人` 帮别人记账 | ✅ | ✅ | ❌ @ 被忽略 + 提示 |
| 分配 / 撤销管理员 | ✅ | ❌ 403 `NOT_OWNER` | ❌ |
| 移出成员 | ✅ 任何非创建者 | ✅ 仅普通成员（不能移出其他管理员） | ❌ 403 `NOT_OWNER` |
| 重置邀请码 | ✅ | ✅ | ❌ 403 |

实现位置：`server/store.js`
- `assertMember / assertManager / assertOwner` —— 账本作用域的角色断言
- `assertCanEdit(record, actorId, action)` —— 作者或管理员
- `canEditRecord(record, accountId)` —— 给前端返回 `canEdit` 显示用

`@` 的降级处理在 `shared/chat.js`：普通成员输入里的 `@名字` 会被抹掉（保留名字文本），付款人回落到自己，并在 `reply.warnings` 里说明原因。

---

## 4. 配额与账本生命周期

| 资源 | 上限 | 校验点 | 错误 |
|---|---|---|---|
| 每账号可创建的账本 | `MAX_BOOKS_PER_ACCOUNT=10` | `Store.createBook` | 409 `BOOK_QUOTA` |
| 每账本成员 | `MAX_MEMBERS_PER_BOOK=5` | `Store.joinByInviteCode` | 409 `BOOK_FULL` |
| 邀请码 | 8 位，剔除 `0O1I` | `newInviteCode` + 唯一性重试 | — |

- 加入方式：**邀请码**（`POST /api/books/join`，重复加入幂等）或**扫一扫**（客户端解码二维码后仍走同一个接口）。
- 加入别人的账本**不占**创建额度（需求确认过口径）。
- 移出成员只删 `book_members` 行，**历史记录保留**（`author_account_id` 仍指向该账号）；
  `GET /api/bootstrap`、`/api/sync` 额外返回 `authors`（记录里出现过的账号），保证被移出者的卡片仍显示作者名。

---

## 5. 认证与会话

```
POST /api/auth/code      {email}                  → 发 6 位验证码（10 分钟、单码 5 次、60s 重发、每小时 6 次）
POST /api/auth/register  {email,code,displayName,password} → 建账号 + 直接签发会话
POST /api/auth/login     {email,password}         → 会话
POST /api/auth/logout                             → 注销当前会话
GET  /api/auth/me                                 → 账号 + 配额状态 + 账本列表
PATCH/api/auth/profile   {displayName,emoji}      → 改昵称/头像
POST /api/auth/password  {oldPassword,newPassword} → 改密（其它设备下线）
```

- 密码：`scrypt(N=16384,r=8,p=1)` + 16 字节盐，`timingSafeEqual` 比较；要求 ≥8 位且含字母数字。
- 会话：`randomBytes(32).toString('hex')`（64 位），`Authorization: Bearer`，默认 30 天，启动时清理过期。
- 验证码：一次性、与邮箱绑定；注册时**先校验昵称/密码/邮箱唯一性，最后才消费验证码**（密码不合规不浪费验证码）。
- 邮件：`server/mailer.js` 零依赖 SMTP 客户端（`node:net`/`node:tls`，支持 465 隐式 TLS 与 587 STARTTLS、AUTH PLAIN/LOGIN、RFC 2047 中文主题）。
  未配置 SMTP 时进入**开发模式**：验证码随响应返回并打印日志（`DEV_SHOW_CODE`）。

---

## 6. 数据接口（按账本作用域）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap?bookId` | 首屏一次性返回账号、配额、账本、成员、记录、消息、配置 |
| GET | `/api/sync?bookId&since` | 增量同步（打开 App / 回到前台） |
| POST | `/api/messages` | 发一条输入：解析→入账→回执（`clientMsgId` 幂等） |
| GET | `/api/messages?bookId` | 聊天流 |
| GET/PATCH/DELETE | `/api/records[/:id]` | 明细；改与删受 `assertCanEdit` 约束 |
| POST | `/api/records/:id/restore` | 恢复软删除 |
| GET | `/api/stats?bookId&...` | 统计聚合 |
| POST | `/api/asr` | 原始音频转写（需登录） |
| GET | `/api/books`、POST、`/join`、`/:id/members`、`/:id/members/:aid/role`、`/:id/invite-code` | 账本与成员 |
| GET | `/api/config`、`/api/health` | 公开：能力与配额 |

统一响应 `{ok, data}` / `{ok:false, error, code}`；错误 `code` 供前端做针对性提示（`BOOK_QUOTA` / `BOOK_FULL` / `NOT_AUTHOR` / `NOT_OWNER` / `NOT_MEMBER` / `UNAUTHORIZED`）。

---

## 7. 聊天解析链路（与 v1 相同，新增角色上下文）

```
文字或语音
  → 归一化（全角、中文数字、口语金额单位）
  → @提及（保留 @ 语义；普通成员的 @ 先被降级）
  → LLM 结构化抽取（DeepSeek；无 Key 时 mock 产出同构 JSON；失败→规则兜底）
  → 服务端校验与衍生（金额/日期/类别/付款人归一、AA 分摊、重复检测）
  → 落库（author/payer 分离）→ 聊天流回执（卡片）
```

意图分支：`add_record / query / update_record / delete_record / undo / chat`。
普通成员的「撤销」只作用于自己发的记录；管理员可撤销最近任意一笔。

---

## 8. 断网语义

| 场景 | 行为 |
|---|---|
| 启动、能连服务器 | `GET /api/bootstrap` 覆盖本地缓存 |
| 启动、连不上 | 读 IndexedDB 缓存，顶部显示「离线 · 只读」 |
| 离线时发送 | `store.sendMessage` 直接抛 `OFFLINE`（不排队入账）；界面把气泡标红，写入 IndexedDB `queue` 仅用于"提醒 + 重试"，**不生成记录** |
| 点「重试」 | 先 `sync()` 探活，成功后再发；`clientMsgId` 保证不重复 |

**没有本地模式**：不登录/不连服务器无法记账。

---

## 9. 前端结构（会话式界面）

```
账本列表（首页，底部 tab：账本 / 设置）
 ├─ 右上 🔍 搜索 → 搜索页：账本 + 记录（GET /api/search，仅我参与的账本）
 ├─ 右上 ＋    → 创建账本（名称 + 12 个预设图标）/ 加入账本（邀请码 + 扫一扫）
 ├─ 账本行     → 群聊页（群聊页：← 返回 / 明细 / 成员）
 │                ├─ 明细页：按天分组 + 点条目改 → 统计页
 │                └─ 成员面板：成员、邀请码 + 二维码、移出成员、分配/取消管理员
 └─ 设置页：头像（预设）、昵称、修改密码、服务器、连接状态、退出登录
```

页面用「栈 + History API」管理：`navigate()` 入栈 `pushState`，`goBack()` 走 `history.back()`，
所以浏览器返回键与安卓返回键行为一致；扫码浮层打开时会额外压一条历史项，返回键先关浮层。

关键实现：

- **零依赖二维码**：`shared/qr.js` 实现字节模式 + 纠错等级 L + 版本 1~4（单块、无交织），
  8 种掩码按惩罚分择优，输出布尔矩阵与 SVG。往返正确性用浏览器原生 `BarcodeDetector` 验证（`public/qr-selftest.html`）。
- **扫码**：`getUserMedia` 取后置摄像头 + `BarcodeDetector` 逐帧解码，支持裸 8 位码、`keepaccounts://join/CODE`、
  任意含 `join/CODE` 的链接；不支持时提示手动输入。
- **会话预览**：`GET /api/books` 直接带 `lastMessage {content, at, author}` 与 `recordCount`，首页一次渲染完成。
- **权限呈现**：卡片 footer 显示「点击卡片可修改 / 编辑 ›」或「仅可查看（别人发送的）」；
  成员面板按角色决定是否显示「移出」「设为管理员」。

## 10. Android 壳（构建约束）

- 手写 WebView 壳，无 Gradle / AndroidX，`bash build.sh` 用 `aapt2 + javac + d8 + zipalign + apksigner` 出签名包。
- 页面 `file:///android_asset/ui/index.html`，`shared/` 与之同级（`assets/shared`），因此前端用 `../../shared/*.js` 在服务器与 APK 下都成立。
- `NativeHttp`（Java）负责绕过 `file://` 的 CORS，供前端直连自己的服务器。
- **硬约束**：build-tools 34 的 R8/D8 8.2.2 遇到**匿名内部类**与**非静态内部类**会崩（`NPE: String.length()`）。
  Java 侧必须用 **lambda** 或 **static 嵌套类 + 显式持有 Activity**。新增代码请沿用。
- 首次启动未配置服务器时弹出地址设置；麦克风权限由 `WebChromeClient.onPermissionRequest` 自动授予。

---

## 11. 测试与验证

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `tests/parse.test.mjs` | 中文归一化、日期、兜底解析、coerce、统计聚合 | 76 |
| `tests/api.test.mjs` | 注册/登录/改密/登出、验证码、配额、邀请码、满员、权限矩阵、数据隔离、@权限、幂等、搜索、账本预览、管理员移出成员与记录保留 | 112 |
| `tests/smtp.test.mjs` | 本地 mock SMTP：明文、SSL 465、STARTTLS 587、AUTH PLAIN/LOGIN、中文主题 RFC2047、点转义、超时、535 | 73 |
| `tests/qr.test.mjs` | 二维码结构：尺寸/定位图案/定时图案/对齐图案/确定性/SVG/邀请码提取 | 31 |
| `public/selftest.html` | 浏览器端到端：三账号、权限随角色变化、@ 降级、离线标红、统计页渲染、登出 | 49 |
| `public/qr-selftest.html` | 二维码「编码→原生解码」往返（经 `tools/cdp.mjs` 驱动） | 7 |

真实链路已验证：QQ 邮箱 SMTP 发信成功（注册验证码）。

---

## 12. 未做 / 后续

- 导出（按需求暂不做）、找回密码、邮箱变更、账号注销。
- 安全加固建议：`/api/auth/code` 增加 IP 维度限流；登录失败计数与锁定；HTTPS 反代；生产 `DEV_SHOW_CODE=false`。
- 备份：`data/ledger.db` 为 WAL 模式，**必须连 `-wal` 一起备份**，或先 `PRAGMA wal_checkpoint(TRUNCATE)`。
