# AUTH REAL VALIDATION — Account / Authentication v1

> 状态基线：`apps/web/src/auth/*` 实现完成，自动测试全部通过（fake provider）。
> 本文件是**真实 Supabase 环境**验收的执行清单与证据表。
> 结果列只允许：`SIMULATED` / `VERIFIED REAL` / `BLOCKED BY EXTERNAL CONFIGURATION`。
>
> **口径对齐（2026-10-09）**：外部配置与主链路真实登录 **已就位**——Email OTP（163 SMTP）、Phone OTP（阿里云 PNVS × Supabase Send SMS Hook，2026-09-28）、Google OAuth（2026-09-27）均 `VERIFIED REAL`。表内仍为 SIMULATED / 待执行 的行表示**该具体步骤未单独留证**，不是环境仍 BLOCKED；现行阶段与门控见根目录 `AGENTS.md`。

## 0. 冻结的账户模型

```
ONE HUMAN
  → ONE COURSE MANAGER ACCOUNT
  → ONE Supabase auth.users.id          ← 业务数据唯一 owner
  → 多个 authentication identities：手机号 / 邮箱 / Google + 凭证（OTP / 密码）
```

- `Course / Item / RawCapture / Reminder / Sync / Conflict` 的 `owner` 永远是 `auth.users.id`。
- **禁止**使用 email、phone、Google provider id 作为 owner。
- 登录方式变化（Phone → Email → Google）只要属于同一个 `auth.users.id`：
  业务数据不迁移、本地绑定（`local_owner_id` / `sync_bound_owner_id`）不重绑。
- 不同 `auth.users.id`：沿用既有安全策略，本地数据不会迁给另一个账户。

## 1. 架构与改动文件

| 层           | 文件                                      | 职责                                                                                    |
| ------------ | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| 手机号规范化 | `apps/web/src/auth/phone.ts`              | E.164 归一化、国家/地区选择（默认 `+86`，不锁死中国大陆）                               |
| 错误映射     | `apps/web/src/auth/errors.ts`             | Supabase 错误码 → 产品文案；`SMS_PROVIDER_NOT_CONFIGURED` 外部状态                      |
| Auth adapter | `apps/web/src/auth/adapter.ts`            | 唯一出入点：OTP / 密码 / OAuth / link / unlink / 密码重置；owner 只暴露 `auth.users.id` |
| 登录界面     | `apps/web/src/auth/SignInPanel.tsx`       | PRIMARY 手机号验证码 → SECONDARY Google → TERTIARY 邮箱（验证码 / 密码）                |
| 身份管理     | `apps/web/src/auth/AccountIdentities.tsx` | 登录方式列表、绑定、验证、设置/修改密码、解除绑定                                       |
| 账户入口     | `apps/web/src/AccountControl.tsx`         | 登录态监听、OAuth/recovery 回跳错误一次性提示                                           |
| 接线         | `apps/web/src/authSync.ts`                | `authAdapter`（原 `sendSignInLink` 魔法链接入口已移除）                                 |
| 样式         | `apps/web/src/styles.css`                 | `.auth-panel` / `.identity-*` 系列                                                      |

**数据库变更：无。** owner 仍是 `auth.users.id`，无新表、无新列，不存密码/哈希/凭据。

**登录方式优先级**：第一屏只有手机号验证码一条主动线 + Google 次要入口；邮箱登录为第三级折叠入口，不平铺五个按钮。

**Email OTP**：走 `signInWithOtp()` + `verifyOtp({type:"email"})`，**不再以 magic link 作为普通登录方式**；recovery / verification 的邮件链接能力保留在 Supabase 侧。

**Phone OTP**：`signInWithOtp({phone})` + `verifyOtp({type:"sms"})`；SMS provider 通过 Supabase Auth 抽象接入，应用内不硬编码任何短信厂商、不发送真实短信。

**Identity linking**：`linkIdentity({provider:"google"})` / `updateUser({email|phone})` + 对应 verification OTP；绑定前必须验证候选 identity 的控制权；候选 identity 已属于其他用户 → 明确报错「该登录方式已经关联其他账号。」，不合并、不删除、不迁移、不产生第三个用户。

**Unlink 保护**：遵循 Supabase 原生约束（至少两个 identity 才能解除），UI 侧同样用 `canUnlink()` 拦截，保证至少保留一条登录路径。

## 2. Supabase Dashboard 配置清单

必须在 Dashboard 完成，缺一项对应流程就保持 `BLOCKED BY EXTERNAL CONFIGURATION`：

1. **Authentication → Providers → Email**
   - Enable Email provider：ON
   - Confirm email（`mailer_autoconfirm`）：按需；关闭时注册后需先验证
   - SMTP：配置真实邮件服务（**已配置**：163 邮箱 `smtp.163.com:465`，Username=完整邮箱地址，密码=客户端授权码，2026-09-27）
2. **Authentication → Providers → Phone**
   - Enable Phone provider：ON
   - SMS Provider：**已配置**（2026-09-28 起）——Supabase **Send SMS Hook** → Edge Function `send-sms` → 阿里云 PNVS；未配置环境才会出现运行时 `SMS_PROVIDER_NOT_CONFIGURED`
   - OTP：默认 60s 重发间隔、1h 过期
3. **Authentication → Providers → Google**
   - Google OAuth Client ID / Secret：**已配置**（2026-09-27 `VERIFIED REAL`）
   - Authorized redirect URI：`https://<PROJECT-REF>.supabase.co/auth/v1/callback`
4. **Authentication → Settings**
   - **Enable Manual Linking：ON**（否则 `linkIdentity()` 返回 422）
   - Site URL：开发环境 `http://127.0.0.1:5173`（或 `http://localhost:5173`）
   - Redirect URLs：加入 `http://127.0.0.1:5173`、`http://localhost:5173`，生产环境另行追加
5. **Authentication → Email Templates**
   - 普通登录邮件改为 **OTP 模板**：正文包含 `{{ .Token }}`（6 位验证码）
   - 保留 recovery / verification 所需邮件流程，不要破坏 `{{ .ConfirmationURL }}` 的其它用途
   - **2026-10-13 追记（邮件文案改哪里 · 常见找不到问题）**：邮件正文**不在仓库代码里**（`apps/api` 零邮件代码，全部邮件由 Supabase Auth + 163 SMTP 发送）。改文案去 **Dashboard → Authentication → Email Templates**（直链 `https://supabase.com/dashboard/project/xaqmzjhvewkrpnqaunwd/auth/templates`）：登录/注册验证码走 **"Magic link or OTP"** 页、重置密码走 **"Reset password"** 页、换绑邮箱走 **"Change email address"** 页。改完**即生效、无需发版**；**红线：正文必须保留 `{{ .Token }}`**（丢了邮件就没有验证码）。当前机制**全部为验证码式**（客户端只实现输码 `verifyOtp`），链接点击式未启用——桌面/安卓壳的 `emailRedirectTo` 是壳内 origin，系统浏览器打不开，链接式对这些端天然不可用。
6. **Rate limits / CAPTCHA**
   - 邮件、短信发送频率限制保持开启（登录 UI 已按 60s 倒计时限制重发）
   - **限额速查（2026-10-13 查证）**：Supabase 侧——自带邮局仅 2 封/时；**自定义 SMTP 启用后默认 30 封/时**（可在 Dashboard → Authentication → Rate Limits 修改，Management API 字段 `rate_limit_email_sent`），单地址重发间隔 60s；短信默认 30 条/时。163 侧（实际发信方）——官方 FAQ：免费邮箱**每日 300～400 封**（会员档 700–800 / 1300–1400），并另受反垃圾政策影响。
   - 如开启 CAPTCHA，需要 `signInWithOtp({ options: { captchaToken } })` 适配
7. **密钥边界**
   - 浏览器只允许：`VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`
   - `service_role` / secret key **绝不允许**进入 `VITE_*` 或前端代码（当前 `.env` 中亦未放置）

## 3. 真实验收表（12 项）

| #   | Initial                           | Operation                                     | Expected                                                                                                                                                                                    | Actual                                                                                                        | Result                                                      | Evidence                                                           |
| --- | --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | 未登录                            | 邮箱验证码登录（send → code → verify）        | 得到 session，`user.id` 为 owner                                                                                                                                                            | 163 SMTP 配置后发送成功，6 位码登录成功；登录后仍是同一 owner `645027f0-…`，`items` 仍 3 条、无第二个 owner   | **VERIFIED REAL** 2026-09-27                                | 用户实操 + 服务端 `items`/`devices`/`change_log` 查询              |
| 2   | 未登录                            | 手机号验证码登录                              | 真实手机号收到 `【恒创联众】您的验证码为021232…5分钟内有效…`，输入后登录成功；`auth.users` 手机号用户 `8138a7f3`、`phone_confirmed_at` 已置、`identities.provider=phone`、活跃 session 1 条 | VERIFIED REAL 2026-09-28                                                                                      | 短信原文（测试者提供）+ `auth.users`/`auth.identities` 查询 | `adapter.test.ts` 1.、30.（SIMULATED）                             |
| 3   | 未登录                            | 邮箱 + 密码登录                               | 同一 `auth.users.id`                                                                                                                                                                        | 注册即返回 session，owner=`645027f0-7b61-480d-9b3d-9c1ad264ee45`，capture→push 落库                           | **VERIFIED REAL** 2026-09-27                                | Dashboard 注册 + 浏览器登录截图 + `change_log` 6 行 + `items` 1 行 |
| 4   | 未登录                            | 手机号 + 密码登录                             | 同一 `auth.users.id`                                                                                                                                                                        | 待执行                                                                                                        | SIMULATED                                                   | `adapter.test.ts` 4.、19.                                          |
| 5   | 未登录                            | Google OAuth 登录                             | 回跳后建立/复用同一 user                                                                                                                                                                    | Google 登录用 gmail 回跳，进入**同一用户**（`auth.identities` 同时有 email+google），3 条数据可见             | **VERIFIED REAL** 2026-09-27                                | 用户实操 + 服务端 identities 查询                                  |
| 6   | 已登录（邮箱）                    | Account → 绑定 Google（`linkIdentity`）       | 新增 google identity，user 不变                                                                                                                                                             | 待执行                                                                                                        | SIMULATED（需 Dashboard 开启 Manual Linking）               | `adapter.test.ts` 7.                                               |
| 7   | 已登录                            | 绑定邮箱 + 验证                               | 出现 verified email identity                                                                                                                                                                | 待执行                                                                                                        | SIMULATED                                                   | `adapter.test.ts` 8.                                               |
| 8   | 已登录                            | 绑定手机号 + 验证                             | 出现 verified phone identity                                                                                                                                                                | SMS 通道已通（登录侧 `VERIFIED REAL`）；**将手机号绑到既有邮箱账号**仍未单独实测                              | SIMULATED（通道可用；该步待留证）                           | `adapter.test.ts` 9.（SIMULATED）                                  |
| 9   | 邮箱登录 → 切换手机号/Google 登录 | 依次用多种方式登录                            | 邮箱+密码、邮箱验证码、Google 三条路径真实通过且 owner 全程 `645027f0-…` 未变；**手机号验证码亦真实通过**（按设计为独立 `auth.users`，不合并、不迁移，owner `8138a7f3`）                    | **VERIFIED REAL**（邮箱两种 + Google + 手机号）                                                               | `adapter.test.ts` 16-19.；服务端 owner 数与 identities 查询 | `adapter.test.ts` 16-19.；服务端仅 1 个 owner                      |
| 10  | 已登录                            | 退出账户 → 重新登录                           | 会话恢复，owner 相同                                                                                                                                                                        | 退出后用验证码重新登录，会话恢复、owner 相同、本机数据继续同步                                                | **VERIFIED REAL** 2026-09-27                                | 用户实操 + 服务端 `change_log` 10:09 的 ITEM UPDATE                |
| 11  | 任意登录方式                      | 检查 `local_owner_id` / `sync_bound_owner_id` | 与 `auth.users.id` 一致且不因 provider 变化                                                                                                                                                 | 换登录方式（密码 → 验证码）后本机 3 条数据仍属同一 owner 且继续同步，未发生重绑或迁移                         | **VERIFIED REAL** 2026-09-27                                | `owner-continuity.test.ts` + 服务端单一 owner                      |
| 12  | 已登录 User A                     | 绑定已属于 User B 的 Google / 邮箱            | 明确失败「该登录方式已经关联其他账号。」；不合并、不新建第三个 user、不动 B                                                                                                                 | 163 账号点「绑定 Google」→ 回跳后面板提示「该登录方式已经关联其他账号。」；服务端 identities 未变、用户数仍 3 | **VERIFIED REAL** 2026-09-27                                | 用户实操截图 + 服务端 `auth.identities` / 用户数                   |

## 4. OTP 与安全矩阵（真实环境需覆盖）

| 场景                                           | 期望                                               | 状态                                                  |
| ---------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| 错误验证码                                     | 「验证码不正确或已过期，请重新获取。」，无 session | SIMULATED（`adapter.test.ts` 26.）                    |
| 过期验证码                                     | 「验证码已过期，请重新获取。」，无 session         | SIMULATED（`adapter.test.ts` 27.）                    |
| 重发                                           | UI 60s 倒计时；provider 侧频率限制生效             | SIMULATED（`adapter.test.ts` 28.）                    |
| 限流                                           | 「…请稍后再试。」，不暴露内部实现                  | SIMULATED（`adapter.test.ts` 29.）                    |
| 短信通道未配置（现通道已配置，此状态不再出现） | `SMS_PROVIDER_NOT_CONFIGURED`，明确外部状态        | SIMULATED（`adapter.test.ts` 30.）；真实通道见第 2 行 |
| 未登录调用 link/unlink                         | 「请先登录账户后再操作。」                         | SIMULATED（`adapter.test.ts` 25.）                    |
| 解除最后一个登录方式                           | 拒绝并提示至少保留一种登录方式                     | SIMULATED（`adapter.test.ts` 11.）                    |

## 5. 已知限制

1. **密码状态**：Supabase Auth 客户端 API 不暴露「是否已设置密码」，`密码 [已设置/未设置]` 是本设备提示（localStorage + 内存兜底），不是服务端权威值。文档与 UI 均标注为本机判断。
2. **Google / 邮件 / 短信** 三项真实登录**均已配置并完成主路径 `VERIFIED REAL`**；仅个别绑定步骤（如手机号绑到既有邮箱账号）仍待单独留证，标记为 SIMULATED/待执行，**不再使用** `BLOCKED BY EXTERNAL CONFIGURATION`（除非将来环境再次回退为未配置）。
3. 自动测试层仍全部为 fake provider；真实短信/邮件/OAuth 请求已在 2026-09-27～28 验收中发生（见 §3 与 §6）。

## 6. 执行记录（2026-09-27，真实环境）

| 步骤                                                    | 结果                                                                                  | 证据                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 迁移 `001`→`004` 应用到真实 Supabase Postgres           | VERIFIED REAL                                                                         | `Applied 001_initial.sql … 004_reminder_delivery.sql`；`pg_tables` 见 20 张表                                                                                                                                 |
| `real-postgres.integration.test.ts`（此前长期 skipped） | **VERIFIED REAL：1 passed**                                                           | vitest 输出 `Test Files 1 passed`                                                                                                                                                                             |
| `verify:live-api` 真实 JWT → 认证 API                   | VERIFIED REAL                                                                         | `Live API verified for owner d54867cf-c632-4597-bd9a-c7a89b5f6ea0; change page size 0`                                                                                                                        |
| 邮箱+密码注册/登录（Confirm email 已关闭）              | VERIFIED REAL                                                                         | `POST /auth/v1/signup` 200 + session；测试账号 `cm-auth-test-20260927@gmail.com`                                                                                                                              |
| 浏览器真实登录 → 记录 → 同步 push                       | VERIFIED REAL                                                                         | 真实账号 owner `645027f0-7b61-480d-9b3d-9c1ad264ee45`；`items` 1 行「明天买东西」(INCOMPLETE, created 2026-09-27T09:16:25Z)；`change_log` 6 行（RAW_CAPTURE CREATE → RAW_CAPTURE_DECISION CREATE → RESOLVED） |
| Phone OTP / Google / Linking                            | `VERIFIED REAL`（Phone OTP 真机 + Google 登录与绑定）；**手机绑定到已有邮箱账号**待验 | SMS = 阿里云 PNVS × Supabase Send SMS Hook（2026-09-28 真实短信+登录成功）；Google Client 已配置并完成绑定验证；Manual Linking 已开启，`linkIdentity(phone)` 未做                                             |
| 两个独立 browser profile 同步收敛（基本双向）           | **VERIFIED REAL** 2026-09-27                                                          | 原窗口与 InPrivate 窗口互见两条待办；`devices` 表 2 个 device、`items` 2 行、`change_log` ITEM 2 行、`sync_conflicts` 0                                                                                       |
| 163 SMTP + OTP 模板配置                                 | **VERIFIED REAL** 2026-09-27                                                          | SMTP `smtp.163.com:465`，Username 必须是完整邮箱地址（填成 Sender name 会 500 `unexpected_failure`）；模板 Subject/Body 含 `{{ .Token }}`                                                                     |
| Email OTP 发送 → 输码 → 登录 → 同步                     | **VERIFIED REAL** 2026-09-27                                                          | 用户实操 + 服务端 `items` 3 行单一 owner、`devices` 2、`sync_conflicts` 0；退出后改用验证码重新登录 owner 不变                                                                                                |
| 跨账号（owner）数据保护                                 | **VERIFIED REAL** 2026-09-27                                                          | 用另一账号登录时提示「本机记录已关联另一账户，请使用原账户」；本机数据不删除不迁移，云端该账号 `items`=0、无 push；界面显示「需要检查」                                                                       |
| Google OAuth 配置 + Case A/C                            | **VERIFIED REAL** 2026-09-27                                                          | `external.google=true`；同邮箱**自动合并**进原用户（Case A）、已占用身份**拒绝**且不产生第三个用户（Case C）；期间修复回跳错误不可见的缺陷（`61595c8`）                                                       |
