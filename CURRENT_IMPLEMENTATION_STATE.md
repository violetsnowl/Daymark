# Current Implementation State

> **口径说明（2026-10-09 对齐）**：文首「事实基准」是唯一现行口径，**覆盖下文一切历史快照**。§1–§7 保留开发期定稿原文供追溯，其中的「当前」「仍缺」「BLOCKED」只反映当时；§8 起是按日期的史实流水。与本文冲突时，以 **文首事实基准 + [`AGENTS.md`](AGENTS.md) + §25–§26** 为准。待修 bug 见 [`docs/POST_RELEASE_BUGS.md`](docs/POST_RELEASE_BUGS.md)。

## 事实基准（现行，2026-10-13 v0.2.4 发布后）

- **项目**：拾序 Daymark——面向学生的课程事务应用（Windows Tauri 2 + 安卓 APK + 云端 API；本地优先、登录后云同步）。代码/文件侧 `daymark`。
- **当前阶段**：**发布后维护更新阶段**（开发阶段 2026-10-08 结束；**v0.2.0 / v0.2.1 / v0.2.2 / v0.2.3 / v0.2.4 均已发布**，2026-10-11～10-13；**网页版 app.daymark.top 已上线并验收**，2026-10-12）。工作模式 = 发现/修复 bug → 小步发版 → 记档。
- **产品/发布**：GitHub `violetsnowl/Daymark`；**系列 Release 策略**（2026-10-12 恢复 0.1.x 打法：0.2.x 每个版本并入 `v0.2.0`、**不新建 Tag**；Tag 只建不移），当前版本 **0.2.4**（系列 Tag `v0.2.0` → `e3d326dc`）；见 [`docs/HOT_UPDATE_RELEASE.md`](docs/HOT_UPDATE_RELEASE.md)。
- **门控基线**：`pnpm format:check` / `lint` / `typecheck` / `test` + `src-tauri` `cargo check` 全 0；套件 **422 passed + 2 skipped**（2 skip=真实 PG 集成用例，不算通过）。
- **DATE/DATETIME**：Item 增加 `start_date` / `occurrence_start_date` / `occurrence_end_date` / `due_date` / `time_zone`；RawCapture 增加 `captured_tz`。互斥不变量与行为见 `docs/ADR-010-date-datetime-precision.md` 与母稿 `22_NATURAL_LANGUAGE_TIME_SPEC.md`。
- **外部 lane**：A–F 已全部 `VERIFIED REAL`；**007 迁移已于 2026-10-11 应用到生产库**（核验见 §29）。
- **数据安全红线**：Dexie 库名 `"course-manager"` 与 `course_manager_device_id` 是本机/设备持久化键，**改名工程永不得触碰**。
- **证据分层**：PGlite/fake IndexedDB 证据与真实 PostgreSQL/Supabase 证据始终严格分开；「skipped」不算真实 PASS。

**历史节点（仅作时间锚，勿当现行结论）**：功能/验收基线曾记 `1dcdf18`；2026-09-26 换机复验 97+1；RC Hardening 136+1；Final Release Gate Prep 144+1；2026-09-29 结项 217/216+1；收官交接 `3863348`（门控 304+1）；i18n 窗口 316+1；NL 升级合并 `c0d4c21`（399+2）；v0.2.0 = `e3d326dc`；**v0.2.1 = `c3dbf8b`（门控 411+2）**。

## 1. 当前已实现并可运行

- pnpm/TypeScript workspace、React/Vite Web、Fastify API、PostgreSQL migration、Dexie 本地库和 Vitest 基础可 install/build/test/run。
- Quick Capture 先在同一 Dexie 事务保存 RawCapture 与 outbox，再做解析；网络、AI 或解析失败不丢原文。
- Semester、Course、CourseInformation、Item、RawCapture、RawCaptureOutput、RawCaptureDecision、ItemAssociation 的正式本地/同步链路已接通；正式 REST 已补齐 Course PATCH、CourseInformation 写入、unresolved RawCapture 删除、ItemAssociation create/list/delete。
- Overview、Course、Calendar、Search/Reminder 基础数据使用同一 Item identity；Calendar 只投影 Item，不读取 CourseSchedule。
- Item 编辑、完成/恢复、删除确认、限时 Undo；课程删除两种策略；跨学期候选确认；人工 SemesterWeek/CourseSchedule 整组维护均可运行。
- CourseSchedule 与 SemesterWeek 的新写入各产生一条 collection outbox command。服务端使用 owner-scoped parent、collection version、替换前集合 hash、单 PostgreSQL 事务、canonical client IDs、单 change-log envelope 和幂等结果；pull 在一个 Dexie 事务内应用整组与 cursor。
- 两端并发替换形成 collection conflict；Conflict UI 将其显示为完整本机组与完整已同步组，不混合成员，不显示版本号、mutation ID、SQL 或 outbox 内部数据。
- Semester、Course、Item、CourseInformation、RawCapture 的同字段并发形成字段冲突；非重叠字段自动合并。UI 支持选择 LOCAL、REMOTE 或适合字段类型的显式值。已删除对象不能经冲突接口任意恢复。
- ACTION_REQUIRED 有完整用户出口：显示受影响对象和可读原因；允许时用当前本地内容、新 mutation ID 与已知服务器版本重交；或经二次确认采用已同步状态。repair decision 记录旧/新 mutation、被替代 mutation、动作、设备与原错误。
- 过期 Undo 不能重交为 undelete，只能明确采用已同步 tombstone；放弃 collection replacement 时恢复替换前整组并重置 pull cursor；任何路径都不静默删除 RawCapture。
- outbox 顺序、owner binding、pull cursor、idempotency、change log、tombstone、stale guard、冲突恢复和服务端 commit 后响应丢失的重试语义已实现。
- Dexie v6 会将旧版 SemesterWeek/CourseSchedule 逐成员 pending outbox 合并为 parent-scoped collection command。可恢复数据保留完整 previous/desired snapshot；无法证明 parent 的旧删除进入 ACTION_REQUIRED，worker 不会把它作为半组变更上传。
- 确定性/AI 候选解释边界、多事项拆分确认、provenance，以及可配置 Reminder Engine/本地派生计划已实现；仍有各自的真实 provider/platform gate。
- Phase 7A–7H 已完成 tokenized shell、Windows/Mobile navigation、Overview/Course/Item hierarchy、全局 Quick Capture、Windows 单 detail container、Mobile Bottom Sheet、同容器 edit、完成/删除/Undo motion、Calendar month/week/day、全局 Search、attention/account 状态 surface、统一 Motion System 与最终 responsive/accessibility refinement。
- 详情快速对象切换使用 request/ref guard，过期 RawCapture、association 或 refresh 结果不能覆盖当前选择；完成、恢复与删除 Undo 保持同一 Item identity。
- Calendar 使用传统七列月/周投影、连续多日 range 与按时间排序的 Single Day；移动端使用日期 → Single Day → Item Bottom Sheet，且从未读取 CourseSchedule。
- Course Import 已实现 recoverable job → source parse → persisted preview → explicit duplicate decision → atomic commit；同文件/学期重复导入幂等，失败解析不写部分 Course。SAME_COURSE 只继承前一学期 CourseInformation，不复制历史 Item 或旧 CourseSchedule；导入的新 schedule 才写入新 Course。
- Search 在本地规范化关键词后匹配 Item、Course 与 CourseInformation，按类型分组、保持源顺序且不做 AI 排名；结果直接进入现有详情、课程或课程信息位置。
- unresolved、Conflict 与 ACTION_REQUIRED 现在使用统一可展开摘要；AccountControl 明确区分仅本机、离线、同步中、已同步、需检查和错误，同时不暴露 outbox 等内部机制。
- 页面、课程详情、tab、Completed、Quick Capture、Search、Account 与 Detail 使用同一组短 motion token；关闭 surface 会先离场再卸载。reduced-motion 同时关闭显著 CSS 位移和 JavaScript 退出等待。
- Calendar 改期根据同一 Item 的投影位置变化显示短到达提示，不重挂整张日历；Quick Capture 的局部成功提示保持输入焦点，并避免与全局 toast 重复播报。
- `360–1440px` 断点矩阵无水平溢出；Mobile 可见操作目标达到约 44px，Bottom Sheet 具备 modal/Tab loop，分层 Escape 不再误关底层空间，跨断点保持同一 Item identity。完整证据见 `docs/RESPONSIVE_ACCEPTANCE_MATRIX.md`。

## 2. 已有自动测试证据

> **历史快照（Final Release Gate Preparation，2026-09-26）**：当时完整套件为 **144 项通过，1 项真实 PostgreSQL 测试因缺少 URL 跳过**。**现行门控基线见文首事实基准（304+1）**，以 §26 与 `AGENTS.md` 为准，勿把本节数字当当前覆盖。

- domain：11 passed；
- application：17 passed；
- storage：32 passed；
- API：49 passed，1 skipped；
- Web：35 passed。

Phase 6 的自动证据包括：

- collection command 单 outbox、幂等 replay、stale version、替换前快照、owner isolation、单 envelope 和整组 conflict；
- 无效 envelope 的 Dexie 全事务 rollback、cursor 不前进、解决后更晚本机整组替换不被覆盖；
- ACTION_REQUIRED 当前内容重交、新 idempotency identity、过期 Undo 明确放弃和 repair provenance；
- ItemAssociation canonical pair、双向读取、重复阻止、tombstone 与不同步 Item 状态；
- Semester/Course/Item/CourseInformation/RawCapture 的 merge/conflict/version 行为；
- 两个独立 Dexie 数据库经 Fastify + PGlite 完成 A–I 与 K；J 通过受控 pull overlap 测试；
- commit 后丢失响应时使用相同 mutation ID，RawCapture/Item 不重复；
- fake IndexedDB v5 → v6 migration rehearsal：旧 row outbox 折叠为单条整组 command、当前数据不丢失、旧记录保留 superseded provenance、后续只上传 collection command；不可还原旧删除会被隔离且不会上传；
- Web 不显示 mutation、base version 或内部错误，并为字段冲突提供显式值入口、为 collection conflict 只显示组数量。
- Web surface 测试覆盖导航、Course/Item 层级、Quick Capture 单控件 identity、Detail 内容与 mobile modal 语义、删除/恢复 motion state、Calendar 连续 range/Single Day/位置签名、Search 分组、attention/account 状态、共享 motion timing 与 transient notice 语义；`360–1440px` 关键流程已通过浏览器人工验收。
- Phase 8 的逐 ID 状态、自动/人工/模拟/外部证据与 release gate 见 `docs/ACCEPTANCE_TRACEABILITY.md`。

完整逐场景证据见 `docs/MULTI_DEVICE_VERIFICATION.md`，逐实体能力见 `docs/SYNC_ENTITY_MATRIX.md`。

## 3. 代码存在，但尚无真实环境验收

> **历史快照（约 2026-09-26 视角）**：本节标题与首行状态已过时——真实 PostgreSQL / Supabase / 双 profile / 物理设备矩阵 **已于 2026-09-27～29 完成**（见 §11–§16 与 `docs/FINAL_RELEASE_VALIDATION.md`）。保留原文供追溯；下列条目中「仍未执行」的表述以当时为准。现行待办只看 `docs/POST_RELEASE_BUGS.md`。

- 正式 `pg` 连接、迁移器、开发 seed 和隔离 schema 集成测试已准备；2026-09-27 起 `.env` 已提供真实连接：`001`–`004` 四份 migration 已应用到真实 Supabase Postgres，`real-postgres.integration.test.ts` **1 passed（不再是 skipped）**。
- Supabase JWT/JWKS 验证、浏览器 Auth 登录/会话监听、受保护 API 和只读 live smoke script 已准备；`.env` 已有项目 URL 与 publishable key（JWKS 可达、认证业务路由已注册），但 SMTP / SMS Provider / Google OAuth 未配置、无测试账号与 access token，真实登录链路仍未执行。
- 双设备测试使用两个独立 Dexie 数据库与正式 worker/HTTP route，但数据库仍是同进程 PGlite，认证仍是固定测试 owner；不是两个物理设备或真实网络生命周期验收。
- MiMo interpretation 与 PDF/image Course Import provider、strict structured output 校验存在；真实 MiMo（`mimo-v2.6-flash`，OpenAI 兼容 Chat Completions）interpretation 与 scanned-PDF import smoke 已 PASS，生产长期稳定性仍待持续观察。
- Reminder claim/deliver/cancel port、本地计划与数据库表存在；没有真实 Windows/Mobile 通知、后台执行、云端 lease API 或时区切换验收。

## 4. 当前真正未实现或未闭合

> **历史快照（开发期 Phase 8 视角）**：本节「当前」指 2026-09-28 前后。其中外部验收、实机矩阵、`.exe` 通知与打包相关缺口，**此后均已闭合或转入产品决策/发布后观察项**（通知点击不回前台已在桌面壳阶段解决；手机端未做项见 §6 注）。**现行未闭合事项一律以 `docs/POST_RELEASE_BUGS.md` 为准**，本节不再承担待办清单职责。

### Phase 6 / 外部验收

- 在真实 PostgreSQL 运行 migration 与 `real-postgres.integration.test.ts`。
- 在真实 Supabase 完成 login → authenticated API → capture/outbox/push/pull/conflict/resolve/restart/convergence。
- 双独立浏览器 profile 的**基本双向同步已真实通过**（见 §11 VERIFIED REAL）；仍缺：断网、后台恢复与长时间重试验收，以及物理设备矩阵。

### 发布

- 真实设备上的系统通知、后台执行与长周期 lease 实机验收；R-01 已固化为产品 v1 policy，device registration、claim/lease、delivery acknowledgement 与浏览器通知适配器已实现并通过自动测试。
- 真实 AI interpretation/import provider、完整自然语言时间理解。
- 物理手机、Windows 设备、屏幕阅读器、系统缩放与移动软键盘验收。
- **已知缺口（2026-09-28 拍板：推迟）**：点击系统通知只在站内打开对应详情，**不会把浏览器窗口带到前台**（Windows 11 禁止后台抢焦点 + 处理器未调 `window.focus()`）。规格 `产品真相基线 §59` 无明文条目但"无论 App 是否打开…直接进入详情"语义隐含。决定**不在网页端修补**，等打包 `.exe` 时改用系统原生通知 API 与 OS 窗口激活一并解决；同一阶段还会把"通知标题带浏览器名"换成应用名。跟踪位置：`docs/FINAL_RELEASE_VALIDATION.md` D 段备注。
- **已知问题（2026-09-28，观察级）**：标签页被 `chrome://discards` 回收并重载后，页面有时读不到"已授权"状态（地址栏仍显示允许），导致 `BrowserNotificationAdapter.show()` 走本地横幅分支而不弹系统通知；重置站点权限后恢复。服务端侧排程/认领/投递不受影响（`notification_deliveries` 仍记 `DELIVERED`）。判定为浏览器权限状态读取怪癖，用户可自愈；`.exe` 打包改用原生通知后不再依赖网页权限。

## 5. 已刷新或应废弃的旧审计描述

- “Web 缺少账号入口”已过时：已有 AccountControl 和 Supabase 会话适配器，缺的是外部项目验收。
- “尚无冲突读取/解决 UI”已过时：字段与 collection conflict 均有 UI，且支持显式值；缺的是线上双设备验收。
- “CourseSchedule/SemesterWeek 仍逐实体 outbox”已过时：所有新替换均使用单 collection command。
- “ACTION_REQUIRED 只能重跑整轮同步”已过时：现有逐 mutation 检查、重交/明确放弃和 provenance。
- “ItemAssociation 只有类型和表”已过时：本地 use case、REST、sync create/delete/pull 和测试已闭合。
- “Course/CourseInformation 正式写 API 缺失”已过时：当前接口已补齐。
- 26/35/44/48/64/66/72/75/82/87/88/92/96/97/112/136/144/184/194/217 等数字均为历史阶段快照，不能代表当前覆盖。**现行门控基线见文首事实基准（304+1）**；本节曾写过的「2026-09-29 当前 gate 217/216+1」也只是当日快照。

`docs/IMPLEMENTATION_AUDIT.md` 已按 Implemented、Verified locally、Verified simulated、Verified real、Not implemented、Blocked、Release blocker 重新整理。

## 6. Phase 8 状态与剩余 release gate

> **历史快照（Phase 8 / 发布前收官）**：下列 gate 项的「已就位 / 已完成」结论仍有效；**「真实外部基础设施仍未验证 / BLOCKED」横幅已废止**。外部 lane A–F 全绿后项目转入发布后维护（§26）。手机端可选补验（非 runbook gate）与发布后问题见 `docs/POST_RELEASE_BUGS.md`。

1. ~~**EXTERNAL CONFIGURATION REQUIRED**：真实 PostgreSQL 连接与 Supabase 项目/测试用户/token 缺失，无法产出真实基础设施证据。~~ **已就位（2026-09-27 起）**：`.env` 提供真实连接、四份 migration 已应用、`real-postgres.integration.test` 1 passed、`verify:live-api` 通过；A3 所需可丢弃库也已用一次性便携实例满足。
2. ~~**ENVIRONMENT VERIFICATION REQUIRED**~~ **已完成（2026-09-29）**：两个独立 profile 同步 C 段 14/14、物理 Windows D 段 8/8、物理手机 E 段 8/8 均 `VERIFIED REAL`（A–K 生命周期的手机侧长时重试仍未做长时间挂机验收，见 `docs/FINAL_RELEASE_VALIDATION.md`）。
3. **R-01 已解决**：提醒数值固化为产品 policy（`packages/application/src/reminderPolicy.ts`，version `r01-v2`；2026-10-07 拍板补 due lead 0 到点档，r01-v1 历史），安静时段 23:00–08:00，`VITE_REMINDER_POLICY` 仅作覆盖。**实机状态**：Windows 平台通知 + 点击进详情已在 D 段 `VERIFIED REAL`；手机端已验原生权限流程、拒绝后应用内回退、切后台提醒（E6/E7）。**未做（可选补验，非 runbook gate）**：手机端点「允许」后的真系统通知展示、长周期 lease 挂机验收。
4. **真实 AI smoke 已完成**：`pnpm verify:ai` → `PASS interpretation 28240ms`；`pnpm verify:ai --with-import` → `PASS import 37633ms courses=3`（MiMo `mimo-v2.6-flash`，扫描 PDF 走栅格化路径）。剩余：完整自然语言时间理解继续走保守确认路径，生产稳定性需持续观察。
5. ~~**PHYSICAL ACCESSIBILITY VERIFICATION REQUIRED**~~ **已完成（2026-09-29）**：F1/F2 NVDA（09-28）、F3/F4 手机 TalkBack、E8 系统字号放大、E4 软键盘遮挡全部 `VERIFIED REAL`。

旧逐成员 collection outbox 的可重复 fake IndexedDB v5 → v6 演练已经完成；当时没有未闭合的 Phase 6 本地工程 blocker。

> **PHASE 6 ENGINEERING IMPLEMENTATION: COMPLETE**

> **PHASE 7A–7H: PASS LOCALLY**

> **PHASE 8 LOCAL ACCEPTANCE: PASS WITH EXTERNAL RELEASE GATES**

外部 lane 随后全部完成（A–F `VERIFIED REAL`，见 `docs/FINAL_RELEASE_VALIDATION.md`）：

> **RELEASE INFRASTRUCTURE VERIFICATION: COMPLETE（2026-09-29 清零；旧横幅「BLOCKED BY EXTERNAL CONFIGURATION」已废止）**

## 7. 新 agent 接手入口

### 先读什么

1. 根目录 [`AGENTS.md`](AGENTS.md) 与本文**文首事实基准**，确认现行阶段与硬性约定。
2. [`docs/POST_RELEASE_BUGS.md`](docs/POST_RELEASE_BUGS.md)——现行待修 PR-00x / 遗留 L-0x（开发期「下一步」已清零，勿再从本节找待办）。
3. [`docs/HOT_UPDATE_RELEASE.md`](docs/HOT_UPDATE_RELEASE.md)——发版与热更新（跨 agent 必读）。
4. `docs/ACCEPTANCE_TRACEABILITY.md`（71/71 ID 映射）、`docs/IMPLEMENTATION_AUDIT.md`（Phase 1–8 证据等级）。
5. 进入 sync 工作前读 `docs/ADR-003`…`005` 与 `docs/SYNC_ENTITY_MATRIX.md`；真实库操作仍按 `docs/REAL_POSTGRES_VERIFICATION.md`，不用 PGlite 结果替代真实证据。

### 下一步（历史；已清零）

**外部 lane 已完成（A 4/4、B 5/5、C 14/14、D 8/8、E 8/8、F 4/4）**，见 §13/§14/§16 与 `docs/FINAL_RELEASE_VALIDATION.md`。下列清单是 2026-09-29 开工序，**已全部闭合**；现行工作看 `docs/POST_RELEASE_BUGS.md`：

1. ~~**E 段 8 项 + F3/F4（同一块硬骨头，需手机）**~~ **已于 2026-09-29 全部 `VERIFIED REAL`**：E 8/8、F 4/4，证据见 `docs/FINAL_RELEASE_VALIDATION.md`（E/F 表 + E 段备注；观察级 O-1 浏览器回收标签、O-2 返回手势、O-3 时间语义出口均在备注内）。
2. ~~**A3 正向 seed**：需可丢弃 PostgreSQL（本机实例或 docker）；负向守卫已 `VERIFIED REAL`。~~ **已于 2026-09-29 完成**：用便携版 PostgreSQL 16.6（解压即用、无安装/无服务）跑通迁移 + 正向 seed + 幂等复验 + 库内核验，验收后整目录删除、无残留；见 `docs/FINAL_RELEASE_VALIDATION.md` A3 行。
3. ~~（可选）**恢复 Send SMS Hook 签名校验**~~ **已于 2026-09-29 完成**：根因是函数密钥字节 bug（`atob` 二进制字符串被 `TextEncoder` UTF-8 重编码），已修复并轮换新密钥开回校验，端到端证据见 `docs/SMS_HOOK_SETUP.md`。
4. ~~（小）**手机号面板「未验证」显示** 与 DB `phone_confirmed_at` 不一致，纯显示问题。~~ **已于 2026-09-29 修复（`a0b90fc`）**：改读 `auth.users` 确认列 + 联系方式匹配保护。
5. ~~Release optimization~~ 主 bundle warning 已在 RC Hardening 内用零行为变化的 vendor 分包解决（entry 555.89 → 348.28 kB，react-vendor 独立 218.83 kB）；更深度的按路由懒加载记入 §10 技术债。

### 本轮关键决定

- Course Import 采用 recoverable job：源文件只在 parse request 中使用，长期保存 normalized preview、source hash/name/media type、用户 duplicate decisions 和 commit result；不长期保存原始字节。
- 跨学期同名只产生 owner-scoped candidate；SAME_COURSE 必须由用户明确选择，只继承 CourseInformation，不复制历史 Item 或旧 CourseSchedule。
- 导入 commit 使用 transaction + Idempotency-Key + `(owner, semester, source hash)` 去重；失败解析不写部分 Course，重启可从 preview checkpoint 继续。
- Phase 8 的 PASS 只表示本机自动测试、浏览器检查和模拟基础设施成立；外部服务与物理环境继续单独标记，不提升为 production PASS。

### 已知坑与命令边界

- **现象**：普通 `pnpm test` 显示 1 skipped，而 `pnpm test:postgres` 在同一机器直接失败。**原因**：前者允许缺少 `REAL_DATABASE_URL` 时跳过真实 PostgreSQL 文件，后者是显式外部 gate。**解决**：本地回归使用 `pnpm test`；只在提供可丢弃真实数据库后运行 `pnpm test:postgres`，不得把 skipped 写成真实 PASS。
- **现象**：当前环境直接执行 `pnpm exec prettier ...` 报找不到命令。**原因**：本机 pnpm command shim 没有通过该调用解析 root dev binary。**解决**：使用已验证的项目脚本 `pnpm format` 或 `pnpm format:check`。
- **现象**：旧验证文档只列两份 migration。**原因**：Course Import 后新增 `003_course_import.sql`，历史说明未同步。**解决**：文档已修正；真实数据库必须依次应用 `001_initial.sql`、`002_collection_sync.sql`、`003_course_import.sql`、`004_reminder_delivery.sql`、`005_schedule_times_nullable.sql`、`006_course_import_parse_cache.sql`（2026-10-05 新增：005 课表行允许无钟点时间——两值同有或同无由 `course_schedules_time_range_check` 约束；006 解析缓存——按 owner+sha256+提示词代际（prompt/schema/模型的指纹）缓存模型输出，同文件重传秒回、换代自动失效、跨用户不共享）。
- **现象**：无外部配置时 API 只有 health，Course Import 不能上传解析。**原因**：认证业务路由要求同时配置 `DATABASE_URL` 与 `SUPABASE_URL`，provider 另需 `AI_API_KEY`（MiMo）。**解决**：本地继续使用 IndexedDB、确定性解析和手工 Course/CourseSchedule；外部 lane 按 `docs/REAL_POSTGRES_VERIFICATION.md` 配置。
- **现象**：API 前端报「稍后重试」，端口 3100 无监听。**原因**：API 由 Hermes 会话托管，关闭 Hermes 被 SIGTERM 连坐杀掉（累计 4 次）。**解决**：改用独立最小化窗口启动——`%TEMP%\start-cm-api.cmd`（内含 5 秒自动重启循环 + 日志落 `%TEMP%\cm-api.log`），与会话生命周期解耦；排障先 `netstat -ano | grep :3100`，再看日志。
- **现象**：双 profile 验收时"断网改标题 → 重连不上去 / 重开退回旧值"，一度判为数据丢失。**原因**：B 端用了**无痕窗口**，关窗即清空 IndexedDB。**解决**：持久化/同步类验收**必须用普通窗口**；无痕窗口结果无效。
- **现象**：安静时段的提醒永远发不出（`notification_deliveries` 恒 0 行）。**原因**：`deriveReminderSchedule` 用**原始事件时间**判 6 小时窗口，顺延会把提醒推到窗口外，`tick` 随即 CANCELED。**解决**：见 §14，已按顺延后时间判窗并加回归测试（`64cc420`）。
- **现象**：MSYS bash 里 `taskkill //PID 6160` 报「无效参数」。**原因**：Git Bash 路径转换吃掉了 `/PID`。**解决**：用 `powershell -NoProfile -Command "Stop-Process -Id <pid> -Force"`，或加 `MSYS2_ARG_CONV_EXCL='*'`。
- **现象**：`supabase functions deploy` 报 `unexpected character "P" in variable name near "Project URL"`。**原因**：`.env` 里残留了标签行。**解决**：把无等号的标签行注释掉（L11/L13 已处理）。
- **Git remote**：`origin = https://github.com/violetsnowl/Daymark.git`，每轮改动 commit + push；提交前跑密钥正则自检（结果必须 0）。

### 当前风险与需要总控提供的输入

- ~~需要产品拍板：R-01 Numeric Reminder Policy~~ 已于 2026-09-26 固化为产品 v1 policy。
- ~~需要外部配置~~ **已就位**：真实 Supabase（`xaqmzjhvewkrpnqaunwd`）、163 SMTP、MiMo key、阿里云 PNVS 与 `.env` 31 行配置全部在用；可丢弃 PostgreSQL 已于 2026-09-29 用便携版临时实例满足（A3 用后即删）。
- ~~**剩余 release gate 只剩 A3 正向 seed**（需可丢弃 PostgreSQL）~~ **2026-09-29：A3 完成，release gate 全部清零**（A 4/4、B 5/5、C 14/14、D 8/8、E 8/8、F 4/4）。
- 2026-09-29 结项自检：工作树干净、无调试残留、`.env` 未被跟踪、本会话提交密钥扫描 0 命中、未发现 P0 规格冲突。

## 8. 换机后本轮新增（2026-09-26）

- **AI provider 换为 MiMo（不调用 GPT）**：`apps/api/src/ai/chat-provider.ts` 与 `course-import-chat-parser.ts` 改用 OpenAI 兼容的 Chat Completions 接口，默认 `AI_BASE_URL=https://api.xiaomimimo.com/v1`、`AI_MODEL=mimo-v2.6-flash`；旧 `openai-provider.ts` / `course-import-provider.ts`（Responses 接口）已删除。环境变量 `AI_API_KEY`/`AI_MODEL`/`AI_BASE_URL`，并兼容旧名 `MIMO_*` / `OPENAI_*`。解释与导入均使用 strict `response_format: json_schema`，已对真实 endpoint 各跑通一次（解释约 40 s，图片导入约 36 s）。
- **PDF 导入改为服务端提取页文字**：MiMo 只接受 bmp/gif/png/jpeg/webp，`file` 输入返回 400；因此 PDF 用 `pdfjs-dist` 提取页面文本后随 prompt 发送，提取不到文字时明确报错，不再伪装成功。图片仍走 base64 `image_url`。
- **Reminder delivery engineering**：新增 `backend/migrations/004_reminder_delivery.sql`（`devices` 与 `notification_deliveries` 增列：`logical_key`、`state`、lease、ack、cancel 等），`apps/api/src/db/notifications.ts` 提供 device registration、跨设备 claim/lease、delivery acknowledgement 与按 key 取消，服务端 claim 自带 stale guard（完成/删除/静音 → CANCELED）；新增路由 `POST /api/v1/devices`、`POST /api/v1/notifications/claim`、`POST /api/v1/notifications/{id}/delivered`、`POST /api/v1/notifications/cancel`。
- **Web 交付实现**：`apps/web/src/reminders.ts` 提供 `BrowserNotificationAdapter`（平台通知、点击打开当前 Item 并消费该次通知、无权限回退应用内提示、首次手势申请权限）、`WebReminderDeliveryPort`（在线走服务端 lease + ack，离线/未登录本地交付）、`ReminderScheduler`（reconcile + deliverDue，防重入）；`App.tsx` 在注入策略后启动，15 s 轮询、页面可见与每次 `refresh()` 后触发，完成/删除/改期的取消因此立即生效。
- **新增自动测试**：`apps/api/src/db/notifications.test.ts`（4）、`apps/web/src/reminders.test.ts`（8）、`packages/application/src/reminders.test.ts` 的 `createReminderWindow`（2）；该轮总数 97 → 112 passed + 1 skipped（RC Hardening 后 136 + 1，Final Release Gate Preparation 后 144 + 1，见 §9）。
- **提醒策略当时仍由配置注入**：该轮 R-01 未定，引擎默认不启动；RC Hardening 期间已按产品指令固化为 v1，见 §9。

## 9. Release Candidate Hardening（2026-09-26）

本阶段不是功能新增，目标是把“本地 acceptance 通过”推进为“具备真实环境验收条件的 RC”。范围冻结：不新增规格外产品功能、不重开 Phase 7、不重构 App.tsx（见 §10 技术债）。

### IMPLEMENTED

- **扫描版 PDF fallback**：`preparePdfSource()` 按页判断文本层，无可信文本的页栅格化为受控 JPEG（≤1600px / q72，总图 ≤6MB，≤8 页，单请求 ≤4 图分批），结果按课程名合并；超页数/超扫描页/超 payload 给出中文产品文案，job 保持可恢复。详见 `docs/ADR-006-scanned-pdf-import.md`。
- **Provider 边界**：`ProviderError` 分类（AUTH/RATE_LIMITED/TIMEOUT/UNAVAILABLE/INVALID_REQUEST/MALFORMED）+ 仅瞬时错误重试一次；导入 300s、解释 90s 超时；解释与导入共用 strict `json_schema`。
- **失败文案**：`importFailureMessage()` 与 Web `toUserMessage()` 把工程消息映射为产品语言，UI 不再出现 mutation/row_version/outbox/SQL/状态码。
- **R-01 固化**：`REMINDER_POLICY_V1`（version `r01-v2`，2026-10-07 起 due 含 lead 0 到点档；此前 `r01-v1`）——NORMAL due 24h/2h/0、same-day 6h、上限 3/天、逾期 24h、occurrence 前 30min、occurrence 后 24h 且每日一次；HIGH due 24h/4h/1h/15min、same-day 3h、上限 5/天、逾期 6h、occurrence 前 1h/15min、occurrence 后 8h 再每 12h；start 恰好一次；dedup 60min；quiet hours 23:00–08:00。引擎支持 same-day cadence、per-level daily budget、occurrence-after initial offset；“提醒我”默认 HIGH（`reminderLevelForCapture`）。
- **安静时段同时约束交付**：`ReminderScheduler.tick()` 在 `window.nextAllowedTime(now) > now` 时只做 reconcile 不发送，夜间到点的提醒顺延到 08:00 之后，而不是在安静时段打断（浏览器实测 23:21 本地时间 0 条发送）。
- **真实 provider smoke 入口**：`pnpm verify:ai [--with-import]`，无密钥时输出 `REAL_AI_REQUIRED` 并以退出码 2 结束，绝不伪造 PASS。

### VERIFIED LOCALLY

- `pnpm test`：**136 passed + 1 skipped**（historical snapshot：Release Candidate Hardening 阶段数字，domain 11、application 17、storage 32、web 35、API 41 + 1 真实 PostgreSQL skip；当前最终 gate 144 + 1 见 §2 与 §10）。
- `pnpm build`：PASS；主 chunk 由 555.89 kB 降为 **348.28 kB**，react-vendor 218.83 kB 独立分包，Vite >500kB warning 消失（仅配置级 `codeSplitting`，行为不变）。
- `pnpm lint` / `pnpm format:check` / `git diff --check`：PASS。
- 新增覆盖：扫描 PDF fallback、栅格化/页数/payload 限制、不可读文件、超大导入（15MB）、provider 不可用/超时/401/非 JSON、瞬时失败重试、batch 合并去重、R-01 全部 10 项行为、产品错误文案、`reminderLevelForCapture`。

### VERIFIED REAL

- `pnpm verify:ai --with-import`：`PASS interpretation 28240ms`（MiMo mimo-v2.6-flash，strict json_schema）、`PASS import 37633ms courses=3`（2 页扫描 fixture 全程栅格化路径）。

### BLOCKED BY EXTERNAL CONFIGURATION（历史快照）

- 真实 PostgreSQL（`REAL_DATABASE_URL`）与 Supabase 项目/测试账号/token。
- 两个独立 browser profile / 物理设备的同步与通知生命周期。

### NOT RUN PHYSICAL

- 物理手机与 Windows 设备上的系统通知、后台执行、屏幕阅读器、系统缩放、移动软键盘。

### RELEASE BLOCKER

- 无新增 P0；剩余发布阻塞为上述外部配置与实机矩阵。

### 技术债（本阶段明确不做）

- **POST-RELEASE TECHNICAL DEBT**：`apps/web/src/App.tsx` 体量大，暂不重构（未发现 correctness bug 或 state race）。
- **POST-RELEASE PERFORMANCE OPTIMIZATION**：进一步按路由懒加载与依赖裁剪（本轮只做了零行为变化的 vendor 分包）。
- ~~规格 `16_API_CONTRACT.md` §22 要求的 AI 端点 rate limit 尚未实现~~ **已实现并有测试**（`apps/api/src/rateLimit.ts` + `rateLimit.test.ts`，`main.ts` 接线 `aiRateLimiter`，默认 20 calls/owner/min，环境变量 `AI_RATE_LIMIT_PER_OWNER/WINDOW_MS` 可调）——发布前复核闭环（2026-10-07）。
- AI 端点 quiet-hour / 通知权限的系统级设置 UI 尚未提供（当前 quiet hours 为产品默认值，通知权限走浏览器手势申请）。

## 10. Final Release Gate Preparation（2026-09-26）

### IMPLEMENTED

- **AI endpoint rate limit（规格级安全缺口，已关闭）**：`apps/api/src/rateLimit.ts` 固定窗口限流，只在真正调用 provider 前判定；桶键为 authenticated owner；`main.ts` 注入解释服务与导入服务共用同一预算。默认 `AI_RATE_LIMIT_PER_OWNER=20` / `AI_RATE_LIMIT_WINDOW_MS=60000`（**security default，可配置，不是产品行为**；规格 16 §22/14 §2.5/18 要求限流但未给数字）。触发返回 **429 + `RATE_LIMITED` + `Retry-After`**，文案“请求过于频繁，请稍后再试。”，无副作用：解释限流不改 RawCapture、不建 Item；导入限流不写 FAILED、不 commit。确定性解析路径不扣配额，普通 capture/sync 接口完全不受影响。详见 `docs/ADR-007-ai-rate-limit.md`。
- **Notification settings 判定（不新增 UI）**：复核 `06_REMINDER_POLICY` §12、`17_SYNC_NOTIFICATION_ENGINEERING` §17、`产品真相基线` §62、`11/13/19` —— 规格只要求“尊重设备安静时段”“用户无需管理这些延后细节”，**没有**要求用户可设置 quiet hours 或通知偏好 → 结论 B：quiet hours 用 R-01 v1 产品默认（23:00–08:00），通知权限走平台原生流程（浏览器手势申请 + 无权限回退应用内提示），用户级自定义记为未来 enhancement。
- **Provider 响应分类加固**：真实 smoke 曾出现一次 `MALFORMED`（间歇）。响应读取统一为 `readStructuredResponse()`：非 JSON 正文→`UNAVAILABLE`（瞬时，重试）、`finish_reason=length`→`TRUNCATED`（提示拆分，不重试）、空 content→`EMPTY`（瞬时，重试）、content 非 JSON→`MALFORMED`（不重试）；`importFailureMessage()` 为每类给出中文产品文案。
- **`docs/FINAL_RELEASE_VALIDATION.md`**：真实 PostgreSQL / Supabase / 双独立 browser profile（14 步）/ 物理 Windows / 物理移动端 / 屏幕阅读器的可执行跑道，每项含 Initial state·Operation·Expected·Actual·Result·Evidence。

### VERIFIED LOCAL

- `pnpm test`：**144 passed + 1 skipped**（domain 11、application 17、storage 32、web 35、API 49 + 1 真实 PostgreSQL skip）；`pnpm build`、`pnpm lint`、`pnpm format:check`、`git diff --check` 全部 PASS。
- 新增 8 项限流测试：`rateLimit.test.ts`(5)、`ai/interpretation-rate-limit.test.ts`(2)、`db/course-import.test.ts`(1)。

### VERIFIED REAL

- `pnpm verify:ai` → `PASS interpretation`；`pnpm verify:ai --with-import` → `PASS import … courses=3`（MiMo `mimo-v2.6-flash`）。

### 状态结论

> **FINAL RELEASE GATE PREPARATION: COMPLETE**

剩余 release gates 全部属于外部环境（见 `docs/FINAL_RELEASE_VALIDATION.md`）：真实 PostgreSQL、Supabase、双独立 browser profile、物理设备与屏幕阅读器；R-01 与真实 AI provider 均已完成，不再是 gate。

## 11. Account / Authentication v1（2026-09-27）

### 冻结的账户模型

`ONE HUMAN → ONE COURSE MANAGER ACCOUNT → ONE auth.users.id`。`auth.users.id` 是 Course / Item / RawCapture / Reminder / Sync / Conflict 的唯一 owner；一个 user 可挂多个 authentication identities（手机号 / 邮箱 / Google）与凭证（OTP 或密码）。禁止用 email、phone、Google provider id 当 owner；同账户切换登录方式不迁移业务数据、不重绑 `local_owner_id` / `sync_bound_owner_id`。

### IMPLEMENTED

- **Auth adapter** `apps/web/src/auth/adapter.ts`：Email OTP（`signInWithOtp` + `verifyOtp type=email`，**不再是 magic link 主入口**）、Phone OTP（`type=sms`）、Email/Phone + 密码登录与注册、Google OAuth 登录与 `linkIdentity` 绑定、`updateUser` 绑定邮箱/手机号 + 对应 verification OTP、设置/修改密码、`resetPasswordForEmail` + recovery OTP 完成重置、`getUserIdentities` / `unlinkIdentity`（≥2 identity 才允许）、登录态监听。所有出口只暴露 `AuthAccount.userId = auth.users.id`。
- **错误映射** `apps/web/src/auth/errors.ts`：Supabase 错误码 → 产品文案（重复 identity、验证码错误/过期、限流、未登录、密码强度…），不泄漏内部实现；`SMS_PROVIDER_NOT_CONFIGURED` 作为明确的外部环境状态。
- **手机号** `apps/web/src/auth/phone.ts`：E.164 归一化 + 国家/地区选择（默认 +86，模型不锁死中国大陆）。
- **登录 UI** `apps/web/src/auth/SignInPanel.tsx`：PRIMARY 手机号验证码 → SECONDARY Google → TERTIARY 邮箱（验证码 / 密码 / 忘记密码），第一屏不平铺五个按钮。
- **身份管理 UI** `apps/web/src/auth/AccountIdentities.tsx`：登录方式列表（已验证 / 未验证 / 未绑定）、绑定与验证、设置/修改密码、忘记密码、解除绑定（遵循 Supabase ≥2 identity 约束，保住最后一条登录路径）。
- **接线**：`authSync.ts` 导出 `authAdapter` 并移除旧魔法链接入口 `sendSignInLink`；`AccountControl.tsx` 登录态改为 `AuthAccount`，并把 OAuth / recovery 回跳错误（如 `identity_already_exists`）一次性提示后清理 URL。
- **数据库变更**：无；密码、哈希、凭据从不进入 Daymark 数据库。
- **文档**：`docs/AUTH_REAL_VALIDATION.md`（架构、改动文件、Supabase Dashboard 配置清单、12 项真实验收表、OTP 安全矩阵、已知限制）；`README.md` 登录描述已更新。

### VERIFIED LOCAL

- `pnpm test`：**184 passed + 1 skipped**（domain 11、application 17、storage 35、web 72、API 49 + 1 真实 PostgreSQL skip）；shell 中导出 `REAL_DATABASE_URL` 后为 **185 passed + 0 skipped**；`pnpm build`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck` 全部 PASS。
- 新增测试：`apps/web/src/auth/phone.test.ts`(4)、`adapter.test.ts`(30，覆盖规格 §15 的 1-19、22-30)、`SignInPanel.test.tsx`(4)、`packages/storage/src/owner-continuity.test.ts`(3，覆盖 owner 连续性与跨 owner 隔离)。全部使用 fake provider，不发送真实短信/邮件。
- 浏览器实测（真实 Supabase client 注入 `.env` 配置）：打开「账户与同步」即手机号验证码主入口（国家默认 +86），Google 次之、邮箱第三级；切换邮箱分支渲染正常，无控制台报错。

### VERIFIED REAL（2026-09-27）

- 四份 migration 已应用到真实 Supabase Postgres；`real-postgres.integration.test.ts` **1 passed**（原 skipped 项）。
- `verify:live-api` → `Live API verified for owner d54867cf-…`（真实 JWT → 认证 API → 真实 change page）。
- 浏览器真实邮箱+密码注册/登录 → 记录「明天买东西」→ push 落库：`items` 1 行（owner `645027f0-…`）、`change_log` 6 行（capture → decision → resolved）。证据见 `docs/AUTH_REAL_VALIDATION.md §6`。
- **两个独立 browser profile 双向同步 VERIFIED REAL**：原窗口与 InPrivate 窗口互登同一账号、互见两条待办；服务端 `devices` 2 个 device、`items` 2 行、`sync_conflicts` 0。
- **Google OAuth VERIFIED REAL（2026-09-27）**：Dashboard 凭据 + `external.google=true`；同邮箱**自动合并**进原用户（Case A，登录后 3 条数据仍在）、**重复身份拒绝**（Case C，163 账号绑已占用的 Google → 提示「该登录方式已经关联其他账号。」，服务端 identities 未变、用户数不变）。
- **跨 owner 数据保护 VERIFIED REAL**：用另一账号登录时提示「本机记录已关联另一账户，请使用原账户」，本机数据不删不迁、云端该账号 `items`=0、界面进入「需要检查」。期间修复回跳错误不可见缺陷（`61595c8`：query+hash 解析 + 模块加载快照 + 自动弹开账户面板）。
- **离线记录 → 刷新不丢 → 恢复网络自动补传 VERIFIED REAL（C1–C3）**：本地 09:51:35 创建「离线测试不要丢」，服务端 09:52:34 收到 ITEM CREATE，全程未手动触发；`raw_captures` 3/3 RESOLVED、`items` 3 行无重复标题、`sync_conflicts` 0。仍缺：C5–C12 冲突场景、C13 关闭重开、C14 长时间重试。

- **Email OTP VERIFIED REAL（2026-09-27）**：用户在 Dashboard 配置 163 SMTP（`smtp.163.com:465`，Username 必须是完整邮箱地址，否则 `500 unexpected_failure`）并把 `Magic link or OTP` 模板改为 `{{ .Token }}` 后，发送验证码 → 输码 → 登录 → 同步全链路通过；退出后改用验证码重新登录，owner 仍为 `645027f0-…`，本机 3 条数据继续同步、未重绑。

### BLOCKED BY EXTERNAL CONFIGURATION（历史快照）

- Phone OTP：SMS Provider 未配置 → `SMS_PROVIDER_NOT_CONFIGURED`。
- Phone OTP：SMS Provider 未配置 → 运行时 `SMS_PROVIDER_NOT_CONFIGURED`。
- Google OAuth：Client ID / Secret 与 redirect URI 未配置。
- Manual Identity Linking：需在 Supabase Dashboard 开启，否则 `linkIdentity()` 返回 422。

> **AUTH V1 IMPLEMENTED**
> **SMS REAL PROVIDER: EXTERNAL CONFIGURATION REQUIRED**

配置清单与真实验收表见 `docs/AUTH_REAL_VALIDATION.md`。

## 12. 同步验收与节奏调优（2026-09-27）

真实双浏览器验收暴露并修复了 3 个缺陷，随后 C5/C6/C7 全部真实通过：

- **`b41b16e`**：`updateItem` 原本把整条 item 快照作为 `changed_fields` 推送，未改动字段的旧值被服务端当成并发修改 → 非重叠编辑产生假冲突（违反规格 14 §22.3 / 17「互不重叠可自动 merge」）。改为只排队真正变化的字段，无变化则不产生 mutation。
- **`5dce809`**：编辑表单提交的是「打开时的旧值」（行在编辑期间被同步刷新过），且冲突解决只写入冲突字段，把同一次被拒绝推送里**未冲突的字段丢掉**（真实发生过标题丢失）。改为按打开快照算差异 + 按时间点比较（`+00:00` 与 `.Z` 等价），解决时保留被拒绝推送中未冲突的白名单字段。
- **`1b5fb8d`（`docs/ADR-008-sync-cadence.md`）**：本地写后立即推送（仅当 outbox 有待推项）、轮询 30 s → 5 s、补 `visibilitychange`。规格未规定秒数，属工程参数。
- 验收：C5（非重叠自动合并、无提示）、C6（同字段显式冲突、只列该字段）、C7（三种解决策略均真实走过并收敛）→ `docs/FINAL_RELEASE_VALIDATION.md` C 段。
- 测试 **194 passed + 0 skipped**（新增 `itemEditDiff` 4、`multi-device` 冲突保字段 1、cadence 2）。

## 13. 学期周编辑器与真实环境验收（2026-09-28）

- **学期周编辑器智能化（产品拍板）**：一周 = 公历自然周；用户点选日期行即可绑定周次，不再手填起止日期。第一周锚定后按 7 天步长推算后续周次，点选远端行可一次补齐中间全部周（同编号覆盖、其余保留，仍是整组替换语义）。**空状态不推断第一周**：只提示「先确定第一周」，选定后才出现推算。行范围 = 学期起止各外扩 4 周（有些学校第一周早于学期开始日）。新增**一周起始日**全局选项（周日～周六，默认周一）：登录时写 Supabase `user_metadata` 跨设备一致、未登录用本机存储；切换不改已存在周次，锚点与新日历不一致时**暂停推算并提示如何重锚**。记录见 `docs/ADR-009-semester-week-calendar.md`。
- **冲突面板明细（C11 前置）**：整组冲突两侧逐条展示本地/已同步取值，且不泄漏 id/版本/时间戳等内部字段（ADR-004）。
- **真实环境验收**：C12/C13/C14 → `VERIFIED REAL`，**C 段 14/14**；A 段 A1/A2/A4 `VERIFIED REAL`、A3 负向守卫通过（正向 seed 需可丢弃库，仍 BLOCKED）；D 段 D1–D3 `VERIFIED REAL`（通知权限、系统通知、点击进详情）。
- **手机验证码短信（2026-09-28 收官）**：个人主体无法通过腾讯云/阿里云**短信服务**的签名资质（要企业）→ 改用**阿里云号码认证服务 PNVS**（赠送签名 `恒创联众` + 模板 `100001`，免审核、仅支持大陆号码、按回执计费）。链路 = Supabase **Send SMS Hook** → Edge Function `send-sms`（RPC V1 签名调 `dypnsapi`）→ 手机；**Supabase 自己生成并核验 OTP**，`TemplateParam` 直接带出该码。真机验收：真实短信送达 + 应用内登录成功（`auth.users` `8138a7f3`、`phone_confirmed_at` 已置）。**踩坑**：① `.env` 里无 `=` 的残留行会让 Supabase CLI 解析失败；② GoTrue 载荷是 `{metadata,user,sms}` 且 `user.phone` **不带 `+`**；③ GoTrue 的 Hook 签名密钥**无法从 API 回读**（只给哈希）→ 暂关校验，改用大陆号段白名单 + 同号 60s 冷却兜底（恢复方法见 `docs/SMS_HOOK_SETUP.md`）。
- **安静时段顺延缺陷（2026-09-29 D5 验收发现并修复 `64cc420`）**：`deriveReminderSchedule` 原本用**原始事件时间**过滤 `[now-6h, now+14d]` 窗口，而安静时段会把提醒**向后顺延**——凌晨 00:06 的提醒在 06:06 之后即被判"过期"，`tick` 随即把 PENDING 记录 CANCELED，**08:00 时已无记录可发** ⇒ 顺延语义在设计上必然失效（D5 首轮 0 认领即为此）。修复：按**顺延后**的时间判窗 + 48h 下限（对齐 `nextAllowedTime` 硬上限），回归测试 2 条。
- **环境坑（复发会再踩）**：① API 进程曾挂在 Hermes 会话下，会话中断/关闭 Hermes 被 SIGTERM → 前端红色「稍后重试」（连踩 4 次），**先查 3100**；
  **2026-09-29 已根治**：改用独立窗口启动（`%TEMP%\start-cm-api.cmd`，PowerShell `Start-Process -WindowStyle Minimized`），
  关闭 Hermes 不再影响；**唯一禁忌是别关任务栏那个 `Daymark API` 小窗口**（关了才停），且 D5 这类隔夜验收依赖它常驻；② `scripts/test-real-postgres.mjs` 在 `npm_execpath=pnpm.exe` 时被 Node 当 JS 执行而崩溃，已修复；③ **持久化类验收必须用普通窗口**——无痕窗口关窗即清空（浏览器行为，非产品缺陷）。

## 14. 本会话结项与 Handoff（2026-09-29）

> 本节是**新窗口接手的第一落点**：先看下面的交接状态表与未决项，再按需下钻 §13/§12/§11。

### 本窗口产出（按提交）

| 提交                                              | 内容                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `ed85bea`/`15e1dfa`/`9362792`                     | Send SMS edge function + Hook 部署 + 首条真实短信            |
| `c347aff`                                         | 手机号登录国内化：去掉国家选择与 `+86` 显示                  |
| `349cfe9`                                         | **B 段 5/5 收官**：真机手机号 OTP `VERIFIED REAL`            |
| `984bd47`                                         | F1/F2 NVDA 朗读 `VERIFIED REAL` + 短信错误路径脱敏           |
| `2872c36`/`e3f979c`/`b512097`/`731a3ee`/`c78775d` | D1–D4、D6、D7/D8 `VERIFIED REAL`；通知回前台缺口按拍板记档   |
| `6f0a286`                                         | NEEDS_ATTENTION 新增「查看并处理 →」出口（状态块原本无入口） |
| `e504fa2`                                         | API 独立窗口启动 + 自动重启 + 日志（根治关 Hermes 连坐杀）   |
| **`64cc420`**                                     | **修复安静时段顺延缺陷**（详见下）                           |
| `3fee495`                                         | **D5 `VERIFIED REAL` → D 段 8/8**                            |

### 关键 bug：安静时段顺延必失效（已修复 `64cc420`）

- **现象**：D5 首轮验收 `notification_deliveries` 恒 0 行，客户端也不弹。
- **原因**：`deriveReminderSchedule` 的 `emit` 用**原始事件时间**过滤 `[now-6h, now+14d]`，而 `nextAllowedTime` 会把提醒**向后顺延**；凌晨 00:06 的提醒在 06:06 之后即离开窗口，`tick` 把 PENDING 记录 CANCELED ⇒ 08:00 时已无记录可发。**顺延语义在设计上必然失效**，不是环境问题。
- **解决**：改用**顺延后**的时间判窗 + 48 小时下限（对齐 `nextAllowedTime` 的 hardStop，仍丢弃真正久远的事件）；2 条回归测试（保留可顺延事件 / 丢弃不可顺延事件）。

### 交接状态（2026-09-29 11:20）

| 段                | 结果                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| A 真实 PostgreSQL | **4/4 `VERIFIED REAL`**（A1/A2/A4 09-27~28；A3 正向 seed 于 09-29 用一次性 PostgreSQL 16.6 完成并卸载干净） |
| B 认证 + API      | 5/5 `VERIFIED REAL`（邮箱验证/密码、Google、手机号短信）                                                    |
| C 双 profile 同步 | 14/14 `VERIFIED REAL`                                                                                       |
| D Windows 物理    | **8/8 `VERIFIED REAL`**                                                                                     |
| E 手机真机        | **8/8 `VERIFIED REAL`**（2026-09-29；含观察级 O-1）                                                         |
| F 屏幕阅读器      | **4/4 `VERIFIED REAL`**（F1/F2 NVDA 2026-09-28；F3/F4 TalkBack 2026-09-29）                                 |

Gate 实测（2026-09-29 11:18）：`pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` 全绿 —— 带 `REAL_DATABASE_URL` **217 passed（0 skip）**、不带 216 + 1 外部门控 skip；工作树干净；本会话提交密钥扫描 0 命中；`.env` 未被跟踪。

### 未决事项 / 风险（下窗口开工清单）

1. **E 段 8 项 + F3/F4**：需手机，`adb reverse` 或临时放开监听（前置见 `docs/FINAL_RELEASE_VALIDATION.md` E 段）。
2. **A3 正向 seed**：需可丢弃 PostgreSQL，不得往真实库写演示数据。
3. ~~**Send SMS Hook 签名校验暂关**~~ **已恢复（2026-09-29）**：真因是函数密钥字节 bug 而非"拿不到明文密钥"；已修复 `keyBytes()`、轮换新密钥、开回校验并通过真实 `/auth/v1/otp` 端到端验收，大陆号段白名单 + 同号 60 秒冷却兜底保留。细节与轮换步骤见 `docs/SMS_HOOK_SETUP.md`。
4. ~~**手机号面板显示「未验证」** 与 DB `phone_confirmed_at` 已置不一致~~ **已修复（2026-09-29，`a0b90fc`）**：面板改读 `auth.users` 的 `*_confirmed_at`（`identity_data` 里 GoTrue 建号时就冻结、永不回写），并加联系方式匹配保护，避免别的邮箱/号码借用账户级确认。
5. **通知点击不回前台**：2026-09-28 拍板推迟到 `.exe` 打包阶段（§4 已记）。

## 15. 第二窗口收尾（2026-09-29 下午）：§14 未决第 3、4 项清零

> 接续 §14 的未决清单，只处理两个小项；**E 段手机大项未动**。

| 小项                          | 结果                           | 证据                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ④ 手机号面板「未验证」        | **已修复并 push（`a0b90fc`）** | 真实库实锤：`8138a7f3` 的 `phone_confirmed_at` 已置但 `identities.identity_data.phone_verified=false`（三个邮箱 identity 同样冻结为 false）；`AuthAccount` 新增 `phoneVerified`，`identityVerified()` 回落到 `auth.users` 确认列并加联系方式匹配保护；gate `217 passed + 1` 门控 skip（原 216+1）、lint/typecheck/format/build 全绿 |
| ③ 恢复 Send SMS Hook 签名校验 | **已恢复开启并端到端验收**     | 真因＝函数密钥字节 bug（`atob` 二进制字符串被 `TextEncoder` UTF-8 重编码 ⇒ 正确密钥也 401），已改 `keyBytes()`；轮换新密钥，Dashboard `hook_send_sms_secrets` / Edge secret / `.env` 三处同值；错误密钥 401、正确密钥 400、真实 `/auth/v1/otp` → `verified key=1 msg=1` + `delivered` + HTTP 200（2.6 s）                           |

### 本窗口新发现（不阻断）

- **阿里云下发偶发超过 GoTrue 5 秒 Hook 上限** → 客户端 `422 hook_timeout`，函数侧无 `delivered`/`aliyun rejected` 日志。**验签关闭的基线同样复现**（已做对照实验），与验签无关，重试即通过；反复出现需查阿里云（余额/频控）。记为观察级。
- ~~"GoTrue 密钥只回读哈希所以永远验不过"~~ 是**误判**：回读的 64 位十六进制只是展示哈希，跟能否验签无关。

### 本窗口踩到的环境坑（复发会再踩）

- **读 Edge Function 日志**：CLI 没有 `functions logs` 子命令，改用
  `GET /v1/projects/{ref}/analytics/endpoints/logs?sql=…&iso_timestamp_start=…&iso_timestamp_end=…`（`source='function_logs'` 是函数 `console.*`，`function_edge_logs` 是调用记录；窗口 ≤24 h）。列名是 `source` 不是 `source_name`。
- **改 Edge secret 用 CLI 而非 Management API**：`PATCH /v1/projects/{ref}/secrets` 不存在（404）；`pnpm dlx supabase secrets set "NAME=值" --project-ref …` 可用，值可经环境变量传入避免进聊天记录。
- **Windows 下经 `shell=True` 调 CLI 必须用 cmd 语法 `%VAR%`**：写 `$VAR` 不会展开，会把字面量当密钥写进去（本轮真实踩过，日志 `key_lens=16` 暴露）。
- **自写 Standard Webhooks 探针要保证"签名里的 timestamp"与 header 里的完全一致**：在函数内部重新生成时间戳会导致自己 401（本轮误判过一次）。

## 16. E/F 段真机验收（2026-09-29）

> 手机（安卓 Chrome + TalkBack）经同网段 `http://10.11.152.182:5173` 接入；证据形式为测试者口述记录（同 F1/F2 先例），逐行实录见 `docs/FINAL_RELEASE_VALIDATION.md` 的 E/F 表与「E 段执行记录与备注」。

| 段           | 结果                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E 手机真机   | **8/8 `VERIFIED REAL`**：E1 竖屏布局 / E2 Bottom Sheet / E3 同容器编辑 / E4 软键盘 + 连续记录 / E5 日历钻取 / E6 原生权限 + 拒绝回退 / E7 切后台提醒 / E8 字号放大 |
| F 屏幕阅读器 | **4/4**：F1/F2 NVDA（09-28）、F3/F4 TalkBack（09-29）                                                                                                              |

### 本段观察级发现（不阻断发布，证据与判定见 runbook E 段备注）

- **O-1**：手机 Chrome 后台约 10–30 s 回收并**重载**标签页 → 回前台视图回首页（数据与提醒计划不受影响）。已排除应用行为（代码无 reload/popstate 路径）与热更新（关 `hmr` 对照实验仍复现）。
- **O-2**：安卓**普通**返回手势 = 浏览器返回，页内无历史条目 → 直接关标签页；TalkBack 返回手势不受影响（F4 通过）。建议随打包阶段与「通知点击不回前台」同批解决。
- **O-3**：带时间语义的记录缺「无时间」出口（`PendingCapture` 在 `需要确认时间语义` 时强制至少一项时间）；绕行＝填任意时间后进详情清空。是否加出口待产品拍板。

### 前置改动与还原（均已还原并复核）

- `apps/api/src/main.ts` `listen host`：`127.0.0.1` → `0.0.0.0`（仅 E 段期间）→ **已还原 `127.0.0.1`**；复核 `127.0.0.1:3100/5173` 200、`10.11.152.182:3100/5173` 不可达。
- Web 启动参数 `vite --host 0.0.0.0` → **已恢复默认 `vite --host 127.0.0.1`**（全程无代码改动）。
- `apps/web/vite.config.ts` 临时加 `hmr: false`（O-1 判别实验）→ **已还原**，`git diff` 无残留。
- 手机侧：需把该来源加入 Chrome `unsafely-treat-insecure-origin-as-secure` 白名单才能测通知权限（`http://局域网IP` 非安全上下文）。

### 剩余 release gate

- **无** —— 2026-09-29 起 A 4/4、B 5/5、C 14/14、D 8/8、E 8/8、F 4/4 全部 `VERIFIED REAL`，本地 gate（format/lint/typecheck/build/test）全绿。
- 已拍板推迟（非 gate）：通知点击不回前台（等 `.exe` 打包）；O-1/O-2 建议随打包阶段一并处理。
- **打包形态已拍板（2026-10-05，用户两次确认）**：`.exe` 与 APK **统一采用 Tauri 2**（单一代码库双端；2.12 版查证官方稳定支持 Windows + Android，min SDK 24），两条线都做；若安卓端真机验证卡死，退路是仅安卓换 Capacitor（壳薄、业务代码零损失）。随打包同批处理：通知点击不回前台、O-1、O-2、原生通知与应用名（D 段备注已列清单）。
- 待定（非 gate）：**O-4** 安卓 Chrome 通知权限"允许"仍无任何通知（有界排查已记，APK 阶段复测）。
- ~~大课表解析 213 s 耗时（观察）~~ **已解决（2026-10-05）**：整册单批 + 模型分路后实测 33–70 s（依据见 `docs/AI_USAGE_MAP.md`）。

## 17. AI 板块事实核查与课表导入缺陷（2026-09-30）

> 全项目 AI 使用面见 `docs/AI_USAGE_MAP.md`（只有两个调用点，全部在 `apps/api`，同一 MiMo Chat Completions 端点）。

### 修复：中文课表 PDF 导入必然失败

- **现象**：用户多次导入课表均失败，`course_import_jobs` 只有一条 `FAILED`，错误为「无法可靠识别该课程表，请重新上传清晰文件。」
- **根因链**（本地用用户的真实 PDF 复现）：`pdfjs.getDocument()` 未传 `cMapUrl`/`standardFontDataUrl` → 中文 CID 字体（`/Encoding/UniGB-UCS2-H`）解不出 → **文字层 0 字** → 全页栅格化出**只有网格线的空白图** → 模型如实返回 `{"courses":[]}` → `courseImportParseResultSchema` 的 `courses.min(1)` 抛 Zod 错 → `importFailureMessage()` 兜底 → 那句误导文案。
- **修复**：`apps/api/src/ai/pdf-source.ts` 新增 `pdfAssetDirs()`，把 pdfjs 自带 `cmaps/`（含 `UniGB-UCS2-H.bcmap`）与 `standard_fonts/` 传给 `getDocument`（**尾部必须是 `/`**，Windows 反斜杠会被 pdfjs 拒绝）。
- **证据**：同一份真实课表 文字 **0 → 5207 字**、栅格化 0 → 模型返回 **8+ 门课**（商业银行经营学/夏聪、计量经济学/张彩萍、财政学概论/卢真… 含周次节次教室），`parse OK in 213 s`。
- **回归测试**：新增 `__fixtures__/uni-gb-cjk-timetable.pdf`（手工构造的 `UniGB-UCS2-H` 单页，2.2 KB，无个人信息）+ `pdf-source.test.ts` 用例「decodes CJK CID fonts through the shipped CMaps」；该 fixture 实测**无 cMap 提取 0 字、有 cMap 274 字**，可稳定区分修复前后。
- **顺带实测**：MiMo **不支持 PDF 输入**（`file` content part → 400 `file type is not supported`，三档模型一致；`/v1/files` → 404），`image_url` 正常 —— 文档与现有"文字+栅格化"方案是对的。

### 观察级遗留（1、2 已修；3 待定）

1. ~~**文案误导**~~ **已修（`b763063`）**：模型返回 0 门课时给「未从该文件中识别出课程。请确认这是本学期的课程表且内容清晰，也可以改用清晰截图重新导入。」（新 `NO_COURSES`），与"文件读不出"的 `NO_CONTENT` 文案分流；
2. ~~**可诊断性**~~ **已修（本轮）**：`ProviderError`/`CloudError` 都带 `cause`，`interpretation.ts` 原本的裸 `catch {` 改为 `catch (error)` 并挂 cause，`server.setErrorHandler` 把工程原因写 stderr（进 `%TEMP%\cm-api.log`）、意外 500 也记一行；**响应体仍只含产品文案**，`interpretation.test.ts` 与 `provider-errors.test.ts` 双向断言（日志含原始原因 / 响应不含）。仍见一次偶发 `UNAVAILABLE`（fetch 层，可重试），归因留观；
3. ~~**耗时（待定）**：大课表结构化解析 213 s~~ **已解决（2026-10-05）**：整册单批 + 模型分路后实测 33–70 s（同 §16 条目，依据 `docs/AI_USAGE_MAP.md`）。

### 本窗口服务状态

- 手机通知复测（O-4，2026-09-30）结束后**已还原**：`main.ts` 的 `listen host` 回到 `127.0.0.1`（本轮改动随 O-4 一并提交）、Web 按默认 `vite --host 127.0.0.1` 启动。
- 还原后核验：`127.0.0.1:3100/api/v1/health` → 200、`127.0.0.1:5173` → 200；`10.11.152.182:3100/5173` **均拒绝连接**（局域网暴露已关闭）。
- API 由原自动重启窗口（`%TEMP%\start-cm-api.cmd`，标题 Daymark API）承载；Web 当前由本次会话的后台进程承载，若其退出用 `pnpm --filter @daymark/web dev` 拉起。

## 18. Tauri 桌面壳与账户换绑修复（2026-10-06）

### 生产环境（阶段 1，已交付，此前只在会话记录里）

- API 生产地址 `https://api.daymark.top`（香港 VPS `206.187.209.142`：Ubuntu 24.04 + systemd `cm-api` + Caddy 反代 127.0.0.1:3100 + Let's Encrypt 自动续期 + ufw 22/80/443）；健康检查 `/api/v1/health`。部署方式：服务器 `/opt/daymark/daymark` 里 `git pull` + `pnpm --filter @daymark/api build` + `systemctl restart cm-api`。SSH 免密密钥 `~/.ssh/id_ed25519_daymark2`（先用密码登录开启 `sshd_config.d/99-daymark.conf` 的公钥开关）。
- 域名 `daymark.top` 托管在 NameSilo 自带 DNS（`api.` 子域 A 记录指服务器）；根域/`www` 仍停放页，留作官网。Caddy 已开访问日志：`/var/log/caddy/access.log`。
- 用户命名：中文「拾序」/ 英文「Daymark」（exe/安装器/窗口标题统一）。

### 阶段 2：Tauri 2 桌面壳（本窗口）

- 工具链按要求全在 E 盘：Rust 1.99（`E:\devtools\cargo`、`E:\devtools\rustup`，已 setx 持久化）、VS Build Tools（`E:\devtools\vsbuildtools`，MSVC 14.44）；cargo 走 rsproxy.cn 镜像。
- 打包命令：`export PATH="/e/devtools/cargo/bin:$PATH" CARGO_HOME='E:\devtools\cargo' RUSTUP_HOME='E:\devtools\rustup' && pnpm exec tauri build` → 产物 `src-tauri/target/release/bundle/nsis/Daymark_0.1.0_x64-setup.exe`（约 1.53 MiB，全量 ~5 分钟）。
- `apps/web/src/apiBase.ts` 的 `isTauri()`（探测 `window.__TAURI_INTERNALS__`）是唯一壳探测器；打包版 API 走 `https://api.daymark.top`，开发版同源相对路径（vite 代理不变）。
- API 注册 `@fastify/cors`（反射 origin；bearer 认证无 cookie，安全），生产已部署并用 OPTIONS 预检验证（204 + `access-control-allow-origin`）。
- **坑 1（已在 `768af7f` 修复）：壳的 CSP `connect-src` 必须含 Supabase 域**。第一版只放行 api.daymark.top，壳内手机/邮箱验证码全部失败，报的却是兜底文案「暂时无法发送…请稍后再试」——那是 CSP 拦截产生的未知错误，不指向服务端。
- **坑 2（已在 `768af7f` 修复）：eslint 必须忽略 `src-tauri/**`**，否则 cargo target 里的生成 .js/.ts 被当源码扫出 binary/parse 错、lint 转红。
- Google 登录在壳内暂禁（按钮灰显「桌面版暂不可用」，浏览器版照常）：Supabase 后台 Site URL 仍是开发期 `http://127.0.0.1:5173`，OAuth 回跳撞 127.0.0.1（用户截图证实）；`.env` 的 `SUPABASE_ACCESS_TOKEN` 已 401，改后台需有效 token。**阶段 4 接回**：改 Site URL/Redirect 白名单 + 壳内回跳处理。
- 本机壳数据目录（排查/兜底清库用）：`C:\Users\LIU\AppData\Local\com.daymark.desktop\EBWebView\Default\`（IndexedDB、Local Storage 都在这里；清掉=本机恢复出厂）。

### 关键 bug：新装壳先登错账号，真账号被「已关联另一账户」锁死（本窗口修复）

- 现象：手机验证码账号（0 门课）先登录 → 本地写死 `sync_bound_owner_id` → 退出改登 Gmail 密码账号（22 门课在云端）→ `OwnerBindingError` → 「本机记录已关联另一账户，请使用原账户」，同步不跑、数据拉不下来。
- 根因：`bindOwner`（`packages/storage/src/index.ts`）对「绑定过别的 owner」无条件拒绝，**没区分本机是否真有值得保护的数据**。
- 修复：12 张绑定表**全空 → 允许改绑**（空库换绑无数据可迁移）；任一表有行 → 照旧拒绝（「真实数据永不跨账号迁移」的原验收条款不变，`owner-continuity.test.ts` 原两条保护测试继续通过）。
- 真实库证据：22 门课全部在 Gmail 账号 owner `645027f0-7b61-480d-9b3d-9c1ad264ee45`（同一 auth.users 下 email + google 两个 identity，所以密码登录/Google 登录/原测试是同一账号）；手机号账号 `8138a7f3-410c-4740-8d54-33f9f8c13ef1` 课程 0。
- 测试：storage 新增 1 条空库换绑用例 → 41 通过；全量 **279 passed + 1 skip**，format/lint/typecheck/build 全 0。

## 19. 彻底账号解耦：每账号独立本地库（2026-10-06 晚）

> 用户原话要求：登录 A 正常用 A、退出换 B 正常用 B，A 的数据不锁设备、不干扰 B，"彻底的账号登录使用解耦，互不干扰，不再锁机器锁设备"。本方案**取代 §18 的"空库换绑"补丁思路**（那个只在空库时放行，仍是锁）。

### 设计（结构级，不是补丁）

- **一个账号一个 IndexedDB**：`<bootstrap名>::owner::<uuid>`（真实应用即 `daymark::owner::<auth.users.id>`）。换账号 = 换指针（`activateOwner()`），上一个账号的行、发件箱、冲突、**同步游标**原封不动留在自己的库里——看不见、不动、也不需要解锁。
- **共享 bootstrap 库只装"登录前"的行**，由第一个到访的账号**一次性认领**（先写 `bootstrap_claimed_by` 标记再拷贝，崩溃也绝不会把行漏给第二个账号）；替代旧的"谁先登录就盖章给谁"。
- **当前账号持久化在 localStorage `daymark.active_owner`**，构造函数同步恢复 → 启动即开对库，无空窗。
- `bindOwner` 的抛错保留，但语义降级为**库内部不变量守卫**（同一库绑定过别人+有数据=程序 bug 才可能触发），正常换账号流程永远走不到 → 界面上的锁**彻底消失**。
- 接线点只有两处：`authSync.run()`（getSession 后 `activateOwner`，切换了就先 `onApplied()` 刷新 UI）和 `synchronizeAuthenticatedData()`（导入路径同理）。`services.ts`/`App.tsx` 零改动（`readonly db` 参数属性换成 getter，142 处 `this.db` 全部自动指向当前库）。

### 证据

- 新测试 `owner-continuity.test.ts`「lets accounts switch freely」= 用户原话场景：登录前数据归 A、A 建课、切 B 全空、切回 A 数据原封不动、重复激活 no-op、B 库始终无 A 行。
- 门控：storage **42 通过**；全量 **280 passed + 1 skipped**；format/lint/typecheck/build 全 0。
- 用户旧卡死状态的清除路径：bootstrap 里 `sync_bound_owner_id=手机号` 的旧键在认领时被跳过不迁移，Gmail owner 首次激活进全新自有库 → `bindOwner` 正常盖章 → 拉 22 门课。

### 同日晚间补钉：共享库游标中毒（本窗口第二根因，已修）

- **诊断路径**（值得复用）：无法 SSH 取服务器日志 → 给壳的 WebView2 注入 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` → CDP 连进去读 console/Network/IndexedDB/页面内 fetch 探测——**不碰账号密码拿到真实登录态下的请求现场**。脚本 `%TEMP%\cdp_probe2~4.py`（uv run --with websockets）。
- **现象**：账号库建好、bindOwner 正常、identity 200，但 `changes?cursor=…` 每次 400 `SYNC_CURSOR_INVALID`，课程永远 0。
- **根因**：游标解码 = `{"owner":"8138a7f3…"(手机号账号),"after":"0"}`——手机号时代的共享库游标，在 `copyStore` 迁移时**不在排除名单**，跟着搬进了 Gmail 账号的库；服务器校验 `payload.owner !== ownerId` 必拒。
- **修复两刀**：① `copyStore` 排除名单补 `sync_pull_cursor`、`local_device_id`；② `syncCursor()` 自愈——解码出明确属于别的账号的游标即删除返回 null（解析不出的合成串放行，兼容旧单测）。**已被污染的库存装新包后自动痊愈，无需清库。**
- **另见（观察级）**：壳到 `api.daymark.top` 的网络路径不稳——探针实测单次 41.8s、`identity` 多次 `ERR_TIMED_OUT`（疑 Clash 分流走了代理节点）；建议给 `206.187.209.142` 加 DIRECT 规则，否则同步能成但慢、偶发超时重试。

### 同步 ERROR（「稍后重试 本机记录安全保留」）排查现状

- 该文案 = `AuthenticatedSyncState.ERROR`（run() 抛了非 OwnerBindingError 的异常），**不是**绑定锁。
- 已排除（外网实测）：CORS 预检经 Caddy 204+正确头 ✓、`/api/v1/sync/changes` 无 token 干净 401 ✓、health 12/12×200 稳定 ✓、CSP 已含两域 ✓、apiBase 探测经 Tauri 2.12.1 源码证实无条件注入 ✓。
- 未排除：需服务器 Caddy 访问日志/`cm-api.log` 看它当时到底请求了什么、返回几号——**SSH 22 端口自今晚起被远端反复关闭**（banner 阶段断开，80/443 正常），待恢复或走椰子云控制台重启 sshd 后补查。
- 已知边界（观察级，未实现防护）：导入进行中退出登录换账号，提交可能写进新账号的库——发生概率低（导入要求登录态且时长 3-4 分钟），列为待定。

## 20. 桌面壳视觉接管与用户 Logo（2026-10-07）

### 换图标

- 用户自制 logo `D:\Chrome download\daymark logo.png`（1254² 圆角方、米白底、墨绿曲线+橙日+绿丘）→ 复制为 `src-tauri/app-icon.png` → `pnpm exec tauri icon` 重生全套（Windows `icon.ico`、各尺寸 PNG、**安卓 mipmap 启动图**——阶段 3 直接复用）。
- 同一枚图复制 `apps/web/public/daymark-icon.png`：标题栏左上角 + `index.html` favicon（标题同步改「拾序 Daymark」）。

### 自绘标题栏（接管系统顶栏）

- `tauri.conf.json` 窗口加 `"decorations": false`（白色系统顶栏消失）。
- 新组件 `apps/web/src/WindowTitleBar.tsx`（仅壳内渲染，浏览器版不出现）：左侧 图标+「拾序 Daymark」，右侧 最小化/最大化/关闭 三个自绘 SVG 按钮；条带拖动（`startDragging`，`event.detail > 1` 时让位给双击最大化）、双击最大化。挂 `body.tauri-shell` 驱动布局下移 36px（`.main-nav` top、`.detail-panel` top、`.app-shell/.main-content` min-height 改 `calc(100dvh - 36px)` 防永久滚动条）。
- capabilities 新增 5 条：`core:window:allow-{minimize,toggle-maximize,close,start-dragging,is-maximized}`。
- 样式用主题变量（canvas 底+line 描边、hover 用 surface-muted、关闭键 hover danger 红）。

### 全局滚动条

- `styles.css` 末尾全局接管：Chromium `::-webkit-scrollbar` 12px、圆角 thumb、透明轨道、hover 加深；Firefox `scrollbar-width: thin` + `scrollbar-color`。原有元素级规则（datetime 轮等）特异性更高不受影响。

### 验证（真实执行）

- CDP 截图 + 视觉核对 4 项：标题栏在最顶、配色融洽、滚动条已是细圆角样式、logo 图案正确、无布局破损。
- CDP 实测按钮链：点最大化 `is_maximized` False→True→False ✓；最小化生效 ✓（测试脚本恢复窗口时撞 ACL `allow-unminimize` 未配——仅测试需要，正式应用不会自minimize，重启即恢复）。
- 门控 **282 passed + 1 skipped**、format/format:check/lint/typecheck/build 全 0。

### 遗留清单（当前全部，按此跟踪）

1. ~~**Google 登录**（壳内灰显禁用）~~ **已闭环（2026-10-07）**：回跳键名修正（`emailRedirectTo`→`redirectTo`）+ 解除 `isTauri()` 禁用闸 + Supabase 回跳白名单加 `http://tauri.localhost`（用户后台操作）+ Android 明文拦截 NSC 域名级放行；**双端真实登录通过**（桌面完整流程+手机全链路）。提交 `e7f7fe7`/`9411e9c`。
2. **Clash 分流**（可选）：`IP-CIDR,206.187.209.142,DIRECT,no-resolve`，改善壳→API 的间歇性慢/超时。
3. **服务器 SSH 22 不稳**：API 80/443 正常；要上服务器而 SSH 不通时从椰子云控制台重启。
4. **导入中途退出换账号**：提交可能写进新账号库（观察级待定，发生条件苛刻）。
5. ~~**O-4 手机通知**~~ **已被 C3 取代并实施（2026-10-07）**：根因方向=WebView 无 Notification 构造器路径（Windows 实测有、插件通道 notify-ok 实证），壳内改走 `ShellNotificationAdapter`（plugin-notification）；明早静默窗外复测（§23 附）。
6. **窗口拖拽/四边缩放**：无边框窗口的系统 hit-test 需用户真手实测（按钮链已程序验证）。**仍待用户 30 秒实测**。
7. ~~**阶段 3 APK**~~ **已完成并真机验收（2026-10-07）**：v0.1.0 双产物已发布。
8. ~~**系统托盘**~~ **已拍板并完成（2026-10-07，commit 5ef6110）**：托盘常驻 + 关窗入托盘（CloseRequested→hide）+ 菜单「打开主界面/退出」，`#[cfg(not(mobile))]` 安卓不受影响；**用户实测通过**。
9. ~~**安卓系统返回手势**~~ **已完成并真机通过（2026-10-07，commit d654fa4）**：`backButton.ts` 7 类浮层可见性判定 + 合成 Escape 逐层关，根页面 `moveTaskToBack(true)`；MainActivity 走 `onWebViewCreate` 钩子。
10. ~~**全局裸按钮审计**~~ **已删除（2026-10-07 用户拍板）**：用户在真实使用中自行发现漏网再报；个例「添加关联」已修（quiet-button）。

### 视觉修正第二轮（用户实测反馈，2026-10-07）

- **竖线错位 1px 根治**：像素实测标题栏段 x=230、导航段 x=229（两层各自合成取整）。改为结构级方案：`.main-nav` 恢复 `top:0` 通顶（`padding-top:74px` 补偿 36px 条带），标题栏左半**透明**直接露出导航——竖线由导航一个元素从窗口顶画到底，复测 x=231 同色连续（y=5…200 全一致），横线本体起点 x=231、左半无横线像素。
- **开始菜单直角图标根治**：原 logo 是**不透明白底方图**，Windows 直接画成方块。用户进一步明确诉求："要 logo 卡片本身当图层，不要白方底"。最终方案：检测卡片 bbox(112,100,1142,1140)、圆角≈218 → **卡片外全部透明**的 alpha 蒙版（卡片外 alpha=0、卡片内 255、32px 缩放后角仍 0 实测），`tauri icon` 重生全套 + web 图标同步；已清 iconcache + 重启 explorer 与 StartMenuExperienceHost 硬刷开始菜单。注意 `ExtractAssociatedIcon` 读 exe 图标会丢 alpha（假阴性），验透明度以 `icons/icon.ico` 为准。
- 过程笔误自查两处：标题栏 `inset` 写成 36px（应为0）、`pointer-events` 会废掉拖动——均已当场修正。
- 观察级（未动）：左下角导航页脚文案与「正在同步」胶囊本就存在轻微重叠（用户首张截图即有，非本轮引入）。

## 21. 阶段 3：APK 打包完成（2026-10-07 凌晨，无人值守）

- **产物**：`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
  （2.74MB，release，**CN=Daymark V2 签名**，四 ABI，minSdk 24 / targetSdk 37 / versionName 0.1.0）。
- 全过程与全部踩坑（SDK 包名 android-37.0 带小数、许可证喂 y、rust 三元组 -androideabi、
  **符号链接权限墙与 cargo-mobile2 补丁**、pnpm 垫片、build.gradle.kts 被截断恢复）**见
  `docs/ANDROID_APK_BUILD.md`**（唯一详录，此处不重复）。
- 关键环境事实：**本机账号 violet 是标准用户（无管理员组、EnableLUA=1）——一切需要提权的路径都不可行**，
  打包方案已按此约束设计为零提权。
- 私有工具链：打过补丁的 `cargo-tauri.exe`（E:\devtools\tauri-cli-src\...\target\release\）、
  `E:\devtools\bin\pnpm.cmd` 垫片、补丁库 `E:\devtools\cargo-mobile2-0.22.5`。
- 遗留清单沿用 §20 第 1-8 项；APK 真机安装测试待用户醒后执行（adb 或直接传包）。

## 22. 正式发布 v0.1.0（2026-10-07，A→B→C 收工计划的 A 步）

- **GitHub Release**：https://github.com/violetsnowl/Daymark/releases/tag/v0.1.0（tag `v0.1.0` 已推；资产 exe 1.67MB + universal APK 19.78MB，服务端回读字节数与本地一致，SHA-256 前 16 位记录在 docs/FINAL_RELEASE_VALIDATION.md §H）。
- **发版门控**：format:check/lint/typecheck/build 全 0 + 全量 282 passed + 1 skipped。
- **`.prettierignore`**：加 `src-tauri/gen/android/app/build/`——安卓构建产物每次都会把 `format:check` 打成 1（发版时发现，已根治）。
- **收工计划（用户拍板顺序）**：A 发版 ✅ → **B 阶段 4 Google 登录接回**（需 Supabase 后台 Site URL/回跳白名单 + 壳内回调机制）→ **C 遗留清单清尾**（#9 返回手势、#10 裸按钮审计、托盘拍板、Clash DIRECT、O-4 通知待定等）→ 全部收工。

## 23. C 遗留清尾计划（2026-10-07，用户拍板后定稿）

- **拍板结果**：C1 系统托盘 **做**（常驻+关窗最小化+托盘菜单）；C2 时间"无时间"出口 **维持现状**（记为已知行为）；C3 O-4 安卓通知 **做**（查根因并实现）；B2 裸按钮审计 **删除**（用户在真实使用中发现后再说）；C4 Clash 规则待用户理解后再定；C5 无边框窗口拖拽/四边缩放手感 = 用户 30 秒实测项。
- **执行序**：A1 文档对账 → A2 服务器模型钉查（**进行中**：SSH 22 持续 banner 失败 3/3，服务器 .env 疑似从模板抄了 `AI_MODEL=mimo-v2.6-flash`（文本路 724s 超时）——仓库侧 `.env.example` 已钉正为 pro；服务器侧待 SSH 恢复自修，或用户走椰子云 web 控制台粘贴幂等命令 `sed -i 's/^AI_MODEL=.*/AI_MODEL=mimo-v2.6-pro/' /opt/daymark/daymark/.env && systemctl restart cm-api` → A3 SSH 探测 → C1 托盘（桌面）→ B1 安卓返回手势（浮层逐层关，根页面回后台）→ B3+C3 通知（点击回前台+根因）→ 门控+双端重打 → 用户集中验收 → A4 Release 最终刷新 → 收工。

### §23 附：通知"无事发生"诊断（2026-10-07 23:15，代码实读定案）

- **非链路故障**：插件通道实测 `notify-ok`（CDP 直发桌面 toast）；tick 循环在壳内照常（App.tsx interval+visibilitychange）；桌面托盘、手机返回手势同批用户验收通过。
- **闸 1（事件未生成）**：R-01 无"到点"档——普通=到期前 24h/2h、高=24h/4h/1h/15min；用户"临近时间建事项等开始时刻"→ 全部提前量已过点，`deriveReminderSchedule` 的 `adjusted < from → return` 直接丢弃（过期提前量不补发）。
- **闸 2（静默时段）**：`REMINDER_QUIET_HOURS_V1` 23:00–08:00（当时 23:15 实测在窗内）；tick 层 `nextAllowedTime(now) > now → return 0`。
- **验收纠正**：提醒靠应用内调度（无 FCM/OS 定时闹钟）——**应用被杀则无提醒**，上轮清单"杀掉应用"作废，正确姿势=切后台保活。
- **待拍板**：R-01 是否加"到点档"（lead=0，推荐加，仍受每日 3 条+静默约束）。有效复测=白天高优先级事项 +16 分钟（15min 档）。

## 24. DeepSeek 切换与终版发布（2026-10-07 深夜）

- **内测事故取证（数据库）**：朋友账号 `523280e1-7a53-4231-9933-fc1473c86e18`（QQ 邮箱+手机号，21:36 创建）21:56:33 提交 `张嘉玮(2026-2027-1)课表.pdf`，22:08:37 FAILED，error=「识别服务响应超时，文件已保留，请稍后再试。」耗时 12:04 = `240s×3 重试+2s` 精确匹配 → 三次模型调用全被供应商挂起，非用户/文件/解析问题。
- **切换实施**：`deepseek-flash`（V4.1-Flash）双路（文本+图片），`thinking disabled` 非思考档；`providerCompat.ts` 按 base URL 分流（DeepSeek=json_object+Schema 内嵌提示词+关思考；MiMo 默认逐字节原样）。全量 **295 passed + 1 skipped**。
- ~~**待用户动作**~~ **全部完成（2026-10-08 01:1x）**：本地 key 用户填好并冒烟（0.9s 合法 JSON）；SSH 22 通道经排障打通——**真凶=代理节点杀 22 端口**（GitHub:22 同死、80/443 同路全活、服务器日志里机器人畅通证明商家未封），Clash 的 `prepend-rules` 通道在本版本被原样透传给 mihomo 被无视（`payloadRule error` 还要求 CIDR 形式），改走**全局扩展脚本 Script.js `rules.unshift`（`IP-CIDR,206.187.209.142/32,DIRECT`）**生效（即 C4，以脚本方案闭环）。随后远程部署：pull+install+build ✓、env 换 deepseek 三行+key（stdin 管道直送、`/tmp/.dskey` 用后 shred，值全程不进对话）✓、cm-api active+health 200 ✓、dist 含 providerCompat ✓。**顺带**：服务器装 fail2ban 并启用（30 分钟 92 次爆破、即时封首个 IP）。
- **v0.1.0 终版**：资产已重传（exe 1,703,854 B / apk 19,799,191 B，哈希见 `docs/FINAL_RELEASE_VALIDATION.md` §H）；C 组进度：B1/C1/C3(代码)/A1 完成，通知复测与 C4/C5 待用户，A2 并入服务器 DeepSeek 环境块。

## 25. 热更新（2026-10-08 立项并实施）

- **发布策略（用户拍板）**：0.1.0 期间**单 release 覆盖更新**——资产替换 + `git tag -f v0.1.0` 强推（GitHub 自动生成的 Source code 包随 tag 刷新）；**应用内 semver 必须爬升**（0.1.1→0.1.2…，updater 按版本比较，相等不触发）；0.1.0 敲定后改为新增 release。
- **架构**：
  - 桌面 = 官方 `tauri-plugin-updater`（Builder::new().build()，pubkey/endpoints 在 tauri.conf `plugins.updater`）：签名校验 + NSIS 静默装 + 自动重启。
  - **安卓 = 自研**（插件源码 2.13.2 `#[cfg(mobile)] install_inner` 是空函数，装 APK 为 no-op）：JS 拉同一份 `latest.json`（Caddy `handle_path /update/*` + ACAO `*`）+ 本地 semver 比较 → `android_install_apk` Rust 命令（reqwest 下载到 `cacheDir()` 交给 JS 的路径 → `am start -VIEW` + FileProvider `my_cache_images` content URI 调系统安装器；Manifest 补 `REQUEST_INSTALL_PACKAGES`）。
  - UI：`updateService.ts`（平台分流）+ `UpdateDialog`（确认卡片）；启动时 `getVersion()+checkForUpdate()`，best-effort 不打扰。
- **签名**：私钥 `E:\devtools\tauri-keys\daymark.key`（**永不入库、丢失=旧装机无法再更新**），构建需 `TAURI_SIGNING_PRIVATE_KEY` 环境变量；公钥已入 tauri.conf。
- **一键发布**：`uv run --with paramiko python scripts/publish_release.py --notes "..."`（验签→清单→SFTP 服务器→挪 tag→替换 Release 资产→回读）。
- **引导装机（bootstrap）**：0.1.0 旧装机没有 updater 代码，**首次升级需手动装一次**（此后热更新生效）。
- **首启权限引导（已实施 2026-10-08）**：`FirstLaunchGuide` 仅安卓、一次性（localStorage 标记）；打开即自动弹通知授权，卡片四行（通知状态/电池豁免/精确闹钟/自启动+MIUI 指引）每行一键开系统页（`android_open_settings`：battery/exact_alarm/app_details）；Manifest + `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`/`SCHEDULE_EXACT_ALARM`；系统一次只能开一个设置页 → 其余项用按钮而非连环自动弹（连环全屏 intent 会互相掩埋）；桌面零渲染（gate 纯函数+4 测试）。
- **E2E 实测（2026-10-08，CDP 直连真机壳）**：卡片渲染 ✓ → 下载启动 ✓ → 验签执行 ✓ → **版本绑定防篡改**生效（清单谎报 0.1.2/产物签 0.1.1 被正确拒绝：`signed for version 0.1.1 but announced 0.1.2`）→ 同版本负控不弹卡 ✓。
- **两个实战坑**：① 嵌套 effect——App.tsx 补丁锚点落进别的 effect 内部 → `Invalid hook call` → 卡片永不出现；补丁后必须确认 effect 在组件顶层。② 裸 invoke 探针必须用 **snake_case**（`plugin:app|version`），camelCase 会报 `Command not found` 误判成 ACL 坏。

## 26. 品牌重塑 + 热更新终局 + 阶段转换（2026-10-08）

- **品牌重塑（全局）**：新 logo（深绿文档+对勾、米白底、透明外缘）全端落位——Windows/ico/Web/favicon 走 `cargo-tauri icon`，安卓五密度 legacy+round+adaptive 前景手生成、底色 `#F8F6F1`（**坑：icon 命令会连带重写安卓资源与 `values/ic_launcher_background.xml`（白），须回正**；桌面显小根因=新图仅占画布 64% → 裁边放大 90.6%）。项目改名 course-manager→daymark（97 文件：包名 `@daymark/*`、类名 Daymark、仓库 URL；**保护不动：Dexie 库名 `"course-manager"`（本机数据）、`course_manager_device_id`**）。产品名「拾序」：productName/安卓标签/窗口/品牌区；**文件侧 daymark**（GitHub 会剥非 ASCII 资产名 → 发布资产统一 `daymark_<ver>_x64-setup.exe` 别名）。
- **仓库转移**：已转主 **`violetsnowl/Daymark`**（API 对旧路径 301；git remote 已改直连；仓内 9 处旧地址已统一）。
- **发布策略执行**：0.1.0 期间**单 release 覆盖**（tag v0.1.0 强推刷 source code）+ **内部 semver 爬升**（0.1.1→0.1.11，清单相等不触发）；`scripts/publish_release.py` 一键：验签→清单→SFTP→挪 tag→GitHub 资产（curl -L 删/正文 PATCH/URL 编码均实测踩坑后修正）。
- **热更新终局形态**（0.1.11 现役）：桌面官方插件（验签含版本绑定）；安卓全自研——启动查清单（GitHub CDN 源）→ 弹卡 → **系统 DownloadManager 后台下载（通知栏进度，外部专属目录）→ 完成：前台=应用内弹窗 / 后台=通知（持久标记兜底）→ 装前三重完整性校验 → Kotlin 挑系统安装器（FLAG_SYSTEM 限定）→ 系统安装页**；DM 失败自动回退直接下载安装。详见 `docs/HOT_UPDATE_RELEASE.md`。
- **铁律**：**执行安装/下载的永远是“当前已装版本”的代码**——修复无法自我安装（鸡生蛋），坏手版本只能手动装一次破局（已连踩三次：0.1.2/0.1.5/0.1.7 各手动一次）。
- **本窗口其他落地**：单实例（`tauri-plugin-single-instance`，桌面 cfg 门控，防快捷方式无限开窗）；首启权限引导（小米已验收，他厂未验=PR-003）；账户页绑定状态闪跳修复（按 userId 缓存+读取中占位）；`[UPDATE_CHECK]` 诊断桩保留。
- **阶段转换**：**开发阶段结束 → 发布后维护阶段**。bug 总账 = `docs/POST_RELEASE_BUGS.md`（现存待修 PR-001~006 / 遗留事项 L-02~08 / 已修复存档）；入口索引 = `AGENTS.md`。
- **门控基线**（收官时）：FMT/LINT/TSC/TEST 全 0（**304+1**：web150、api80+1、storage44、domain11、application19）、cargo check 0 警告；0.1.11 双产物回读通过。

## 27. 中英文切换 + 三次热更（2026-10-09，i18n 窗口）

- **应用级 i18n（zh-CN / en-US）**：`apps/web/src/i18n/` 自研轻量层——`locale.ts`（`cm.app_locale`，默认 zh-CN，**不进云同步**）、分域 `messages/*`（common/nav/app/item/course/calendar/search/capture/account/auth/conflict/sync/errors，zh/en 键对齐测试）、`context.tsx`（`I18nProvider`/`useT`/`useI18n`）、`format.ts`（Intl 日期）。官网（`E:\CUFE\vibecoding\Daymark website`）语言独立（`daymark-language` + 路径 `/en/`），互不联动。约定见 **`docs/I18N.md`**。
- **语言入口**：桌面＝侧栏搜索下方「文/A」；手机＝右上角 compact（与账户/同步同 `.top-tools` 弹性簇，gap 8px）。**桌面勿再渲染 compact 入口**（0.1.14 已去重）。品牌区随语言主次切换：中文「拾序/DAYMARK」，英文「Daymark/拾序」。
- **用户数据永不翻译**；`unresolved_reason` 中文持久键仅在 UI 边界映射；错误经 `errors.ts`/`auth/errors.ts` 映射消息键，`AuthUiError.message` 为 prototype getter 随 locale 解析。
- **发版**：**0.1.12**（i18n 全量）→ **0.1.14**（去桌面重复语言钮 + 品牌主次 + 安卓下载镜像回退）→ **0.1.15**（冲突「保留所选内容」主按钮样式、语言图标改文/A）。用户已验收 0.1.13/0.1.14 语义（13 未单独发版，内容并入 14）。
- **安卓下载失败根因**：清单安卓源＝GitHub Release CDN，国内移动网 DownloadManager 常连不上（「连接中」→失败）；**镜像** `api.daymark.top/update/app-universal-release.apk` 可达。已实现 GitHub 优先、失败自动改镜像再试；DM 补 UA/蜂窝允许并回传 reason 码。**鸡生蛋**：下载修复须装上后才生效，必要时手动装一次 APK。
- **本轮踩坑**：① `BuildTask.kt` 走 `pnpm tauri` 可能落到**未打补丁** npm CLI → 并行 rustBuild 部分任务仍符号链接失败——已改为直连补丁版 `cargo-tauri.exe`；② `cargo-mobile2` `force_symlink` 对 `TargetStyle::File` **一律 `fs::copy`**（标准用户无 SeCreateSymbolicLinkPrivilege）；③ `publish_release.py` 的 `github_token` 原走 bash+grep，Windows 无 bash 直接挂——改 `git credential fill` / `GITHUB_TOKEN`。
- **门控基线（本窗口收官）**：**316+1**（web162、api80+1、storage44、domain11、application19；+9 为 i18n 用例）、cargo check 0；0.1.15 双产物回读通过。
- **未决**：PR-001 安装选择器仍被第三方接住（用户实测 0.1.13/0.1.14 后**搁置**，记在 `POST_RELEASE_BUGS.md` 勿关单）；PR-002 带宽；L-02/03/06 等。

## 28. 自然语言记录与时间语义升级（2026-10-09 立项实施；2026-10-11 已合并 main；验收未清零，未发版）

- **状态**：实施完成并经四轮独立复审、真实 PostgreSQL 集成验证与 Release Candidate Gate（PASS）；feature 分支 `feat/nl-capture-time-semantics` 已合并 `main`（合并提交 `c0d4c2140f131daa84f4449025e617a6fb4f76a6`）。门控（该提交实跑）：format:check / lint / typecheck PASS，测试 399 passed + 2 skipped（2 skip = 真实 PG 集成用例，已在一次性 PostgreSQL 单独实测 2/2），cargo check 0 警告。
- **产品母稿**：`course_manager_spec_v0_1/22_NATURAL_LANGUAGE_TIME_SPEC.md`（唯一时间语义来源，同步覆盖 00/02/05/06/07/15/19/README）。
- **核心 ADR**：`docs/ADR-010-date-datetime-precision.md`：DATE xor DATETIME、不伪造时刻；全套影响与迁移（契约/存储/同步/API/UI）。
- **解析实现**：`packages/application/src/timeParsing.ts`（确定性解析：星期/下周/下下周/学期上下文补全/相对日期/时间跨度最长匹配去重）+ `captureParsing.ts`（分类规则与标题净化）；`processClearCapture` 写入时间字段并记录 `captured_tz`；AI 解释服务端硬校验（`apps/api/src/ai/interpretation.ts` 的 `timeSuggestionsAnchored`）。
- **数据模型**：Item `start_date`/`occurrence_*_date`/`due_date`/`time_zone`；RawCapture `captured_tz`；Postgres `007_date_precision.sql`（**尚未应用到生产库**）；Dexie v7 仅本地扩展。
- **行为**：纯日期事项不造时间；解析不出不臆造；DATE due=当日日终；DATE occurrence 预警锚 09:00；DATE start 只起 start reminder；AI 整理由用户点击触发、不自动执行。
- **发布前人工实机项（NOT RUN，未清零）**：双端录入/编辑/重启读取、DATE 提醒实机、双端差异、线上同步（待新后端部署后验）——见第三阶段报告「未完成实机验收清单」。
- **禁止事项（执行人）**：**未迁移生产库、未打包正式 APK/EXE、未推热更新**；永不改 `course-manager`/`course_manager_device_id`、永不改写 RawCapture 原文。

## 29. 生产升级 + v0.2.0 正式发布收尾（2026-10-11，跨 agent 交接点）

- **进度（全部完成）**：时间语义升级合并 `main`（`c0d4c21`）→ 发布流程加固合并（`ba37ec8`，PR-006 系列 37 用例）→ **生产库应用 007**（隔离 worktree `ba37ec8`，迁移后核验 7 迁移/5 新列/5 约束/索引/行数 53/67 不变/5 样本逐字段一致）→ **API 部署 `d5311a66`**（闭包构建+重启，冒烟 200/401/日志零异常/测试账号实测 identity+sync）→ **v0.2.0 正式发布**（Tag `v0.2.0`→`e3d326dc`，独立 Release 三资产，清单原子翻转 0.2.0，QA 包逐字节一致，`v0.1.0` 历史零触碰）。
- **关键决策**：①多 Release 策略（每版本独立 Release/Tag、Tag 只建不移、历史永久保留）；②发布脚本安全模型=清单最后原子翻转+内容不可变+失败关闭+部分完成报告（见 HOT_UPDATE_RELEASE.md）；③测试包→人工验收→正式包流水（QA 目录 `E:\Daymark-QA\`，0.1.15/0.2.0 并存）；④生产备份先行（`E:\Daymark-Backups\daymark_pre007_20261011T082205Z.dump`，SHA-256 `26c87e88…`，恢复验证通过，ACL 单用户）。
- **新坑（现象→原因→解决）**：
  1. 大版本升级后 `pnpm --filter @daymark/api build` TS2305 缺导出 → 依赖包 dist 是升级前旧产物（api-only build 不重建依赖闭包）→ **部署/发布构建一律用 `pnpm --filter @daymark/api... build`（闭包）**；
  2. tsc 失败仍落盘 dist（未设 noEmitOnError）+ systemd `Restart=always` → 磁盘新旧混合 dist 有崩溃循环风险 → 构建失败后必须核对 dist 状态，重启只在构建成功后；
  3. GitHub API 匿名 403（限流）→ 用 `git credential fill` 取 token 做只读查询（不回显）；
  4. SSH 多层引号绞坏 SQL（`'007…'` 变语法错误）→ 一律参数化查询 `$1`；
  5. 本机 ACL 误授权 `violet`（实为机器名，账号是 `LIU`）把自己锁出门 → icacls 前先 `whoami`；
  6. 发布时 GitHub HEAD 探测瞬断（HTTP 0）→ 脚本按设计失败关闭于翻转前（线上零变化）→ 幂等重跑一次成功；
  7. brief/转录哈希抄错（.sig 沿用旧版值）→ 一律重算+密码学验签（minisign/ed25519，key id `4DEDF7A24E2687B1`）。
- **环境/命令变化**：生产部署目录实为 `/opt/daymark/course-manager`（runbook 已修）；生产 PG=**17.6**（pg_dump 客户端须 ≥17，便携 PG 17.6 即用即删）；服务器 `SUPABASE_ACCESS_TOKEN`（44 字符）为无效遗留值、代码零引用（卫生项，建议清掉）。
- **未决/风险**：PR-001（安装器被第三方接住）仍观察；PR-002（VPS 带宽）保留；真实发布路径已实跑闭环一次（v0.2.0），脚本模拟测试 30 用例≠替代真实终检；0.2.x/0.3.0 发版时注意 versionCode 递增复核（0.2.0→2000）。

## 30. v0.2.1 发布：PR-007 分类 + PR-008 时间双框（2026-10-11 深夜，跨 agent 交接点）

- **进度（全部完成）**：两处修复 + 回归测试 → 门控全绿（**411 passed + 2 skipped**、`cargo check` 0 警告）→ 双端构建（exe `拾序_0.2.1_x64-setup.exe` 2,597,552 B + `.sig` 436 B；APK 29,746,959 B，`versionName 0.2.1` / **`versionCode 2001`**）→ **v0.2.1 正式发布**（Tag `v0.2.1` → `c3dbf8b`，独立 Release 三资产，清单原子翻转 0.2.1，Release 正文白话版，VPS 与 GitHub 固定名别名均上传后校验）→ 终检 6 项全过 → 产物归档 `E:\Daymark-QA\0.2.1\`。
- **PR-007 根因与修法**：`packages/application/src/captureParsing.ts` 的动作识别是**句首锚定**（`ACTION_PATTERNS[0]` 带 `^`），动词不在句首就没有正信号 → 落到「需要确认记录类型」兜底；母稿 `22_NATURAL_LANGUAGE_TIME_SPEC` §2.4 明确允许无课程、无时间的事项，§9 要求分类 _expands beyond leading verbs_。修法 = 新增**任意位置的多字动作短语**通道（`ACTION_PHRASE_PATTERNS`：办事证件 / 钱款 / 就医 / 生活杂务 / 通用行动短语），**只作 ITEM 正信号**：`clearInformation` 仍只数核心通道（课程事实语言优先）、第三方陈述（`老师`/`学校`…开头）不触发、不编造课程与时间、完全无信号仍进 UNRESOLVED；单字动词仍只认句首（`学`/`修` 也出现在 `金融学`/`选修课`）。
- **PR-008 机制与修法**：两个框对应 ADR-010 的两个互斥精度列（`*_date` / `*_at`，Postgres `007` 有 CHECK、API/Zod 同样拒绝双写）。原实现把它们做成**两个互斥入口**、`onChange` 互相清空对方，且两框 label/placeholder 一字不差 → 读起来像「日期半 / 时间半」双联框，先选日期再选时间被重置回今天。修法（用户拍板方案 A）= **两框协作成一个值**：框1 仅选日期、框2 仅选时间（`mode="time"` 面板去掉日历只留时间轮）且**选填**；有钟点写 `*_at`、无钟点写 `*_date`，永远只写一列（数据库/同步零改动）；日期与时间**双向继承**（完全没选日期就选钟点时钉当天，且该日期显示在框1）；文案 `仅选日期` / `仅选时间（可不填）`，aria 按 开始/发生/截止 × 日期/时间 分开；附带把一行两个 `<label>` 改成 `<div>`（原结构非法，一次点击会开出两个面板）。
- **验证**：应用层新增 6 例（分类 + 8 个时间字段 + `raw_text` 不改写 + 有/无时间两条路径 + 歧义课程信息仍要确认 + 无动作线索仍 UNRESOLVED）；web 新增 `TimeBlock.collaboration.test.tsx` 交互回归 3 例（先日期后时间 / 先时间后日期 / 未填时间=仅日期且只写一列）+ `composeTime`/`dayOf`/`clockOf` 纯函数 + `showsDateGrid`/`showsClock`；真实界面（vite 开发版）实测 Quick Capture 三条（「招商银行办卡」「办理业务」直进事项、「期末考试范围」仍弹「请确认它属于哪门课程」）与时间双框两个方向，保存回读「开始 2026年10月21日 23:14」。
- **新坑**：
  1. **30MB 资产上传经代理易被重置**：固定名别名上传连续 3 次 `WinError 10054` / `curl 56 Recv failure`，脚本报「部分完成」（清单已翻转、版本化资产完好不受影响）；第 4 次 curl 单发 `POST --data-binary` 一次成功（201，digest MATCH）。恢复 = 重跑脚本（幂等）或 curl 单发补别名；**客户端更新只依赖清单 + 版本化资产，别名只服务旧链接，失败不影响更新**。
  2. **安卓构建缺环境变量直接报「Android SDK not found」**：`ANDROID_HOME` / `NDK_HOME` / `GRADLE_USER_HOME` 本机未设到用户级，配方在 `scripts/build-apk-0.1.12.ps1`（SDK `E:\devtools\android\Sdk`、NDK `26.1.10909125`、JDK 17、`GRADLE_USER_HOME=E:\devtools\gradle-home`），带上即通。
  3. **发布脚本硬要求工作区干净**：双端产物全在 gitignore 内（`gen/android` 亦然），构建后 `git status` 应仍为空——非空先查清再发。
- **未决**：PR-001/002/003/004/005 与 L-02/03/06 照旧；别名上传 10054 若在下次发布复发，再考虑给 `upload_asset` 加重试（本轮未改脚本，避免与本次发布混线）。（→ 已在 §31 落地：curl + 重试 + 服务器中转）

## 31. v0.2.2 发布：排版修正 + 发布改回系列模式（2026-10-12，跨 agent 交接点）

- **进度（全部完成）**：界面四处修正 + 发布脚本系列模式改造 → 门控全绿（**411 passed + 2 skipped**、`cargo check` 0 警告、发布脚本用例 **34/34**）→ 双端构建（exe `拾序_0.2.2_x64-setup.exe` 2,598,444 B + `.sig`；APK 29,746,955 B，`versionName 0.2.2` / **`versionCode 2002`**）→ **v0.2.2 正式发布**（并入系列 Release `v0.2.0`，**未新建 Tag**；Release 标题规范化为「Daymark 拾序 v0.2.0」；清单原子翻转 0.2.2；GitHub/VPS 固定名别名经服务器中转刷新并校验）→ 终检全过 → 0.2.1 两件资产搬入 `v0.2.0`（digest 与原件逐字一致）后 **`v0.2.1` 的 Release 与 Tag 已删除**（远端现仅 `v0.1.0`、`v0.2.0`）→ 产物归档 `E:\Daymark-QA\`。
- **Release 正文按小版本分节（2026-10-12 用户要求）**：`Daymark 拾序 v0.2.0` 的正文改为 `# 拾序 Daymark 系列更新记录` + 每版一节（`## 0.2.2（当前）` / `## 0.2.1` / `## 0.2.0`，`---` 分隔），**每节自带该版本的 exe/apk 下载链接**；`merge_body()` 新版插最前、历史小节保留、「（当前）」随版本移动、重跑幂等（脚本用例 34→**37**）。**GitHub 资产列表本身无法分组**（扁平列表是平台限制），分节正文即等效入口；0.2.0 一节取自 `E:\Daymark-QA\0.2.0\release_notes_0.2.0.md` 原稿、0.2.2 为发布原文、**0.2.1 原正文未存档、按 §30 实际修复内容重写**。
- **策略变更（用户拍板，恢复 0.1.x 打法）**：`0.2.x` 每版并入 **`v0.2.0`**、**不新建 Tag**。`tag_for()` → `series_tag()`（`v<major>.<minor>.0`）；系列锚点指向旧提交属正常，只有「首发版本自身被改写」才失败关闭；读回把同系列历史资产视为预期、只报真·外来资产（绝不自动删除）；Release 标题统一 `Daymark 拾序 v<系列>`。
- **界面修复（PR-009 / PR-010）**：时间块整块 **13px**（行改 `<div>` 后不再吃到 `.detail-panel label` 的 13px，提示/时间未定/调整时间/完成/清除 会一起漂到 16px）、文案改 **「日期」/「时间（选填）」**、每行字段收进 `.time-block-fields` 网格且**第三框（发生结束）独占一行**、补充内容 textarea 定高 44px（根因：默认 `rows=2` 固有高度 56px）；排课表单改**等宽栅格**（桌面 3 列分组、手机 2 列）+ 控件统一 44px（原桌面 40 / 手机 44 两端不一致）。实测：桌面 1280 / 平板 900 / 手机 390 × 中英双语各一轮，等宽、无横向溢出、无截字（英文 `Time (optional)` 在 133px 会截断 → 列宽下限 150px）。
- **选项取舍（用户委托判断）**：排课表单七项 **全部保留、一项不删** —— `stage_label`（阶段）是 AI 导入课表时承接节次的字段（`course-import-chat-parser`：无钟点时保留「12-13节」进 stage_label），并在行展示里充当无时间时的前缀；`week_start/week_end`=第 X–Y 周、`classroom`=教室，均参与行摘要。删任何一项都会丢功能。
- **新机制（PR-011）**：本机上行传 ~6MB 必被重置（`WinError 10054`，6/6 复现；限速、关 `Expect`、绕过代理均无效，同一端点偶发能过）→ `upload_asset` 改 **curl + 3 次退避重试**，仍失败自动 `upload_via_server`（SFTP 上行 → VPS 上 curl → `finally` 删除临时文件与鉴权头）；**信任边界不变**：中转后的 GitHub digest 仍由调用方比对，翻转前必须通过。
- **史实（用户问询已核实）**：0.1.x 只剩 0.1.15 是**旧脚本的清理步骤**所致（`KEEP_VERSIONS = 2`：删除超出最近两版的版本化资产，不动线上引用与固定名别名），不是「被覆盖丢失」；源码提交全部仍在 main 历史里，但 ≤0.1.14 的安装包在 GitHub 与本机均已无存、不可恢复。**0.2.x 起不再清理同系列资产**（本轮 0.2.0/0.2.1/0.2.2 三版并存于 `v0.2.0`）。
- **未决**：`AGENTS.md` 的过期口径已于 2026-10-12 经用户授权更新为系列模式（提交 `5aed0aa`）；PR-001/002/003/004/005 与 L-02/03/06 照旧。

## 32. 课表导入后端热修（PR-012，2026-10-12，纯后端）

- **触发**：新用户 `85e15ea5…ca3e6` 三连败（2 PDF + 1 截图，报「识别结果未能通过校验，请重试一次…」）。DB `course_import_jobs` 三条 `FAILED`（10-12 12:55:40 / 12:56:15 / 12:56:43 UTC，`committed_at` 全 null）；`/var/log/cm-api.log` 三处 `ZodError: Imported course names must be unique after normalization`——两次 PDF 都卡 `courses[6].name`（重试无效、与清晰度无关），图片卡 `courses[1].name`。
- **根因**：模型单次返回把同一门课拆成两条，而 `mergeCoursePreviews()` 此前只在 `results.length > 1`（多批并行）时执行，单批原样放行 → `packages/contracts/src/course-import.ts:61` 的唯一性校验炸掉整单。**反证**：若合并跑过则同名必被并掉，不可能撞名。
- **修复**：`course-import-chat-parser.ts` 改为单批同样走 `mergeCoursePreviews(results)`（同名并一门、课时段并集去重、老师取首个非空）+ 回归测试（单批同名两门 → 1 门 2 课时段且过 schema）。**纯后端**（`apps/web` 不含该 schema、客户端不跑这道校验）→ **不发 App 版本**。
- **部署与验证**：`eca6b02` 推送 → 服务器 `git pull --ff-only`（HEAD=eca6b02，worktree 干净）→ `pnpm --filter @daymark/api build`（RC=0；lockfile 未变故未重装依赖）→ dist 已含新逻辑、旧条件消失 → `systemctl restart cm-api`（active、NRestarts=0）→ 本机与公网 `/api/v1/health` 均 200 → **在部署产物上实跑**：喂「单批返回同名两门」→ 合成 1 门 2 课时段、`courseImportParseResultSchema.parse` 通过 ✓。
- **待用户验证**：让该用户重试同一份 `荣彦淞(2026-2027-1)课表.pdf`。撞名的具体课程名**无法回看**（服务器不存文件内容、失败也不进 `course_import_parse_cache`），要看需拿到该 PDF 本地复现。
- **旁支（已记档）**：PR-013 课表识别偶发 `ProviderError: TIMEOUT`；PR-014 `notification_deliveries` 外键 23503（事项已删仍投递）。

## 33. 网页版（app.daymark.top）上线与验收（2026-10-12，跨 agent 交接点）

- **进度（全部完成）**：本仓库静态产物上云——CF Workers 项目 `daymark-app` 自本仓库自动构建（根级 `wrangler.jsonc`）→ `app.daymark.top` 从「→ 下载页 302」改绑为网页版本体 → 构建变量三件套补配 → **用户登录 + 同步验收通过，网页版正式收货**。详见 `docs/WEB_VERSION_DEPLOY.md`；官网下载页「进入网页版」直达。
- **前置代码改动**：`FirstLaunchGuide` 显示门由 `isAndroid()` 收紧为 `isTauri() && isAndroid()`（安卓手机浏览器会误弹壳专用首启引导，三个设置按钮点了没反应）；纯函数门语义不变、单测保持。
- **构建变量三件套**：Build command 内 `VITE_API_BASE_URL=https://api.daymark.top` + CF 项目 Settings → Build 的 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`（值取自根 `.env`）。缺 Supabase 两条 = 线上账号层降级「仅本机」、账户面板无登录口（首构曾遗漏，已补配并验证）。
- **验收证据**：预览站首构全绿（零控制台报错、本地记录闭环 raw_captures=1 / items=1 / outbox_mutations=4、CORS 直连 health 200、安卓 UA 不误弹）；`app.daymark.top` 200 直出；用户登录成功、数据同步。
- **已知边界与待定**：浏览器版提醒仅页面打开时有效（浏览器限制，非缺陷）；多标签页并发同步（双同步器）专项未验；`navigator.storage.persist()` 持久化申请（可选）。壳仍是完整体验。
- **CF 陷阱**：子域绑 Custom Domain 弹窗报 `No zones match <host>` 属抽风——勿照提示添加域名；绕法 = 弹窗内先选 zone + 子域填 `app`，或 Route（占位 A `192.0.2.1` 橙云）。

## 34. 安卓安装器根因修复：PackageInstaller 会话（PR-001，2026-10-13）

- **背景**：小米/HyperOS 上应用内更新的"安装页"被 MT管理器/WPS 接住（PR-001；0.1.x 起多轮 Intent 筛选修补均无效）。
- **方案（整体弃用旧链路，非增量调参）**：`ACTION_VIEW + APK MIME + resolveActivity/queryIntentActivities 处理器枚举` 全删；`DaymarkSettingsPlugin` 改为**系统 PackageInstaller 会话**——`createSession(MODE_FULL_INSTALL)` → `openWrite` 写入 + `fsync` → `commit(PendingIntent)`；新增 manifest 接收器 `DaymarkInstallReceiver`（exported=false）接 `STATUS_PENDING_USER_ACTION` 并直接 `startActivity(EXTRA_INTENT)`（系统自带确认界面、显式组件、无 Intent 解析）；`STATUS_SUCCESS`/失败状态记 logcat（tag `DaymarkInstall`）。旧 `<queries>`（APK VIEW 可见性）一并移除；FileProvider 本体保留（生成代码的相机/文件选择仍在用）。
- **配套**：装前校验 = 体积下限 + ZIP 魔数 + **包名 + 签名 SHA-256 与当前应用一致**；`canRequestPackageInstalls()` 未授权 → 打开 `ACTION_MANAGE_UNKNOWN_APP_SOURCES`，`Plugin.onResume` 检测到授权后**自动续装**（不丢包、不误报）；web `updateService`：安装标记由**启动时版本核对统一治理**（`android_update_ready_state`）——授权、取消、失败都不丢包（取消后重试免重下），安装成功或文件失效后清除，不误报成功、不留死标记。
- **行为边界（如实）**：新机制下 MIUI 若弹自己的安装器 UI，那是系统安装器（角色持有者），不是第三方中介；会话失败**不静默回退**旧挑选逻辑（已删除），错误明确上报且保留安装包。**鸡生蛋**：0.2.2 → 下一版的首跳仍由 0.2.2 旧代码执行安装环节；从再下一版起走新机制，被接住则手动装一次破局。
- **验证**：门控全 0（format:check/lint/typecheck/build；测试 **422 passed + 2 skipped**，含新增 `updateService.test.ts` 10 例；`cargo check` 0 警告）；Android release 构建 `BUILD_EXIT=0`；**合并后 Manifest 与最终 APK 均核验**（receiver/权限/无 queries；APK sha256 `c6c418e4…`，29,766,511 B，versionCode 2002，CN=Daymark 签名）。**未触发正式发布。**
- **真机进展（2026-10-13）**：**两轮实测通过**——未授权 → 自动跳「安装未知应用」设置页 → 授权返回自动续装 → 系统安装器（MIUI）拉起、无第三方 → 重复安装正常、更新后数据完整；MT管理器/WPS 中介问题确认解除；**取消路径已补测通过（用户回执）**；**第三轮：正式 0.2.3 版自行执行全链复测通过**（模拟清单抬至 0.2.4、实体=官方 0.2.3 包：发现更新 → 下载 → 系统安装器安装 → 数据完整、无第三方，人工确认「完全符合预期」）。**平台行为**：MIUI/HyperOS 在每次安装前弹系统自带「本次允许」确认（系统安全层，非第三方介入，非缺陷）。**待续测**：失败态专项未做；真实的版本号 +1 升级随下个正式版自然覆盖。Kotlin 侧无测试基建，以构建 + 真机为准。
- **测试布置注意**：抬清单测试时下载的产物 = 线上正式资产（旧代码）——装完会把"测试包（新代码）"换回正式包，第二轮又走旧逻辑（首轮实测踩到）；要连续验证新机制，需让清单的下载地址指向新代码包。

## 35. v0.2.3 发布：安卓安装器根因修复上线（2026-10-13，跨 agent 交接点）

- **进度（全部完成）**：PR-001 根因修复（PackageInstaller 会话安装，详见 §34）真机两轮实测通过 + 取消补测通过后正式发布——版本 0.2.2 → 0.2.3；双端构建（exe `拾序_0.2.3_x64-setup.exe` 2,599,708 B + `.sig`；APK 29,766,511 B，`versionName 0.2.3` / **`versionCode 2003`**）→ **并入系列 Release `v0.2.0`（未新建 Tag）**；清单原子翻转 0.2.3；GitHub/VPS 固定名别名刷新并校验；Release 正文新增 `## 0.2.3（当前）` 一节 → 终检全过（清单 200；双端 Content-Length 与本地产物逐字一致；回读资产 0.2.0～0.2.3 四版 + 固定名别名齐备）。
- **更新卡文案（白话）**：「更新安装更可靠了：修复了部分手机上安装更新时被其它应用接管的毛病，现在统一由系统安装器完成安装。」正文含首跳提示（旧版本装这一版时可能仍是旧方式；装上后每次更新都走新机制）。
- **发布前门控**：format:check / lint / typecheck / build 全 0；测试 **422 passed + 2 skipped**；`cargo check` 0 警告；发布脚本用例 **37/37**；工作区干净。
- **鸡生蛋现状**：0.2.2 及更旧版本的用户，装 0.2.3 时安装环节仍由旧代码执行（可能被第三方接住/出现选择框，手动完成即可）；从装上 0.2.3 起，之后的每次更新走新机制。桌面端照旧走官方插件（验签含版本绑定）。
- **发布后待办**：无强制项；PR-001 已移档（见 POST_RELEASE_BUGS 已修复存档）。

## 36. 结项收尾与跨 agent 交接点（2026-10-13，v0.2.3 窗口收尾）

- **本窗口完成**：文档口径更正（`3d41d2f`）→ **PR-001 根因修复**（安装环节整体改系统 PackageInstaller 会话，详见 §34）→ 真机两轮 + 取消补测 → **正式发布 v0.2.3**（§35；`b2d3ae9` 版本、`553be9f` 记档）→ **空包演练第三轮**（模拟清单抬 0.2.4、实体=官方 0.2.3 包：正式版自行执行全链通过，人工确认「完全符合预期」；`6610757` 记档）→ 清单逐字还原（sha256 `f89a7e51…`，备份已清）。
- **当前精确状态**：HEAD `6610757` 已推 `origin/main`、工作区干净（无未提交改动、无调试残留、无密钥误跟踪）；线上清单 = **0.2.3**（四平台完整）；PR-001 已移档；门控全绿：format / lint / typecheck 0，测试 **422 passed + 2 skipped**（domain 16 + application 66 + storage 50 + web 199 + api 91），`cargo check` 0 警告，发布脚本用例 **37/37**；0.2.3 产物归档 `E:\Daymark-QA\0.2.3\`（exe sha256 `f4615881…` 2,599,708 B + `.sig`；apk `c3698e8b…` 29,766,511 B）。
- **未决 / 风险**：① 真实"版本号 +1"升级随下个正式版自然覆盖（鸡生蛋首跳仍存：≤0.2.2 装机装 0.2.3 时安装环节由旧代码执行）；② 失败态专项未做（不阻断）；③ 在册观察：PR-002（VPS 带宽）、PR-013（识别偶发超时）、PR-014（通知投递外键）；④ 演练用法与红线（勿发 versionCode 更高测试包）见 HOT_UPDATE_RELEASE.md §4。
- **跨 agent 移交路径**：`AGENTS.md` → 本文（§34/35/36 = 本窗口三件）→ `docs/HOT_UPDATE_RELEASE.md`（发版 + 演练 SOP）→ `docs/POST_RELEASE_BUGS.md`（总账）。生产副作用（发版 / 改清单 / 部署）**仍需逐项授权**。

## 37. v0.2.4 发布 + 第二窗口结项收尾（2026-10-13，跨 agent 交接点）

- **本窗口完成**：邮件模板定位与品牌名更正（用户已在 Dashboard 改完）→ **PR-015 修复**（验证码输错提示误导：线上探针实证 Supabase 对错码/过期码/无码一律返回 `otp_expired`、**服务端不可区分** → 文案统一为「验证码不正确或已过期」，顺带补齐 `over_*` 速率限制错误码映射；`aac050e`）→ 用户网页版验收通过 → **正式发布 v0.2.4**（`b98e04f` 版本；exe `拾序_0.2.4_x64-setup.exe` 2,598,774 B + `.sig`、APK 29,766,511 B / `versionCode 2004`；并入系列 Release `v0.2.0`，未新建 Tag）→ 终检全过（清单 0.2.4；双端 Content-Length 与本地产物逐字一致；资产回读 0.2.0～0.2.4 **五版并存** + 双别名）。
- **当前精确状态**：本提交已推 `origin/main`、工作区干净；线上清单 = **0.2.4**；门控（干净 env）：format / lint / typecheck 0、测试 **422 passed + 2 skipped**、`cargo check` 0 警告；0.2.4 产物归档 `E:\Daymark-QA\0.2.4\`（sha256：exe `c964f84f…`、apk `2bb7ed68…`）。
- **本窗口新增防复发约定**：`HOT_UPDATE_RELEASE.md` §5「跑门控前保持 shell 干净」——root `.env` 的 `REAL_DATABASE_URL`（=生产库）一旦泄漏进环境，2 个真实 PG 集成用例会从 skip 转跑（设计自隔离 + auto-drop，本窗口实测一次、零残留已核实；常规门控必须保持 skip）；需要 `.env` 变量请用子 shell。
- **首次真实"版本号 +1"升级路径就绪**：0.2.3 装机（新安装器）收到 0.2.4 提示 → 安装由新机制执行、`versionCode 2003→2004` 实变——真机可自然完成"鸡生蛋首跳的真实收尾"验证。
- **未决 / 风险**：① 失败态专项仍未做（不阻断）；② 在册观察：PR-002（VPS 带宽）、PR-013（识别偶发超时）、PR-014（通知投递外键）。
- **跨 agent 移交路径**：`AGENTS.md` → 本文（§34–§37 = 安装器修复、v0.2.3 发布收尾、v0.2.4 发布）→ `docs/HOT_UPDATE_RELEASE.md`（发版 + 演练 SOP + 踩坑速查）→ `docs/POST_RELEASE_BUGS.md`（总账）。生产副作用（发版 / 改清单 / 部署）**仍需逐项授权**。
