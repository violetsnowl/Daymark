# AGENTS.md — 拾序 Daymark 仓库导览（给接手的 AI agent / 新模型）

**这是什么**：拾序（Daymark）——面向学生的课程事务应用，Windows 桌面（Tauri 2 统一 exe）+ 安卓 APK + 云端 API，数据本地优先、登录后云同步。产品中文名「拾序」、文件/代码侧一律 `daymark`。

**当前阶段**：**发布后维护更新阶段**（2026-10-08 开发阶段收官；**2026-10-11 v0.2.0 / v0.2.1、2026-10-12 v0.2.2 已正式发布**——0.2.0=时间语义升级+DATE/DATETIME 精度、生产已迁 007、API d5311a66；0.2.1=Quick Capture 分类修复 + 时间双框协作；0.2.2=排版修正 + 发布改回系列模式；**网页版 app.daymark.top 已上线并用户验收**）。工作模式 = 发现/修复 bug → 小步发版 → 记档。

## 按需读（职责边界清晰，别把信息塞回这里）

| 你想知道                                | 去哪读                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产品是什么、面向用户怎么介绍            | [`README.md`](README.md)（产品向，含实机截图）                                                                                                                                    |
| 当前代码事实、历史决策、阶段记录        | [`CURRENT_IMPLEMENTATION_STATE.md`](CURRENT_IMPLEMENTATION_STATE.md)（§27 中英文切换、§28 时间语义升级、§29 生产升级+v0.2.0 发布、§30 v0.2.1 发布、**§31 v0.2.2 发布+系列模式**） |
| **待修 bug 与遗留事项总账**             | [`docs/POST_RELEASE_BUGS.md`](docs/POST_RELEASE_BUGS.md)（现存待修 PR-00x / 遗留 L-0x / 已修复存档；修复验证后移档）                                                              |
| **怎么发版、热更新架构、踩坑速查**      | [`docs/HOT_UPDATE_RELEASE.md`](docs/HOT_UPDATE_RELEASE.md)（跨 agent 必读，自包含）                                                                                               |
| **网页版（app.daymark.top）部署与验收** | [`docs/WEB_VERSION_DEPLOY.md`](docs/WEB_VERSION_DEPLOY.md)（CF Workers `daymark-app`；构建变量三件套；已知边界与待定）                                                            |
| 生产升级 runbook（007 迁移/部署/回退）  | [`docs/PRODUCTION_UPGRADE_RUNBOOK.md`](docs/PRODUCTION_UPGRADE_RUNBOOK.md)（含 11 项设备验收场景）                                                                                |
| **中英文切换架构与术语**                | [`docs/I18N.md`](docs/I18N.md)（locale/messages/入口/用户数据不翻译）                                                                                                             |
| 安卓打包四坑（符号链接/NDK/工具链）     | [`docs/ANDROID_APK_BUILD.md`](docs/ANDROID_APK_BUILD.md)                                                                                                                          |
| 发布验收证据（阶段 A–H）                | [`docs/FINAL_RELEASE_VALIDATION.md`](docs/FINAL_RELEASE_VALIDATION.md)                                                                                                            |
| AI 调用点/限流/供应商状态               | [`docs/AI_USAGE_MAP.md`](docs/AI_USAGE_MAP.md)                                                                                                                                    |
| 架构决策记录                            | `docs/ADR-001…009`；规格映射 `IMPLEMENTATION_CONTEXT.md`                                                                                                                          |

## 硬性约定（违反=事故）

1. **门控全 0 才提交**：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`（基线 **411 passed + 2 skipped**；2 skip=真实 PostgreSQL 集成用例，**skip 不算通过**，需便携 PG17.6 一次性库单独验证）+ `src-tauri` 下 `cargo check` 0 警告。
2. **每轮改动 commit + push**，中文提交信息；提交前密钥正则自检为 0，`.env` 永不入库；更新签名私钥（`E:\devtools\tauri-keys\daymark.key`）绝不入库。
3. **永不向真实 Supabase（`xaqmzjhvewkrpnqaunwd`）写演示/种子数据**；验收先查真实数据库，"skipped" 不算通过。
4. **不关闭**任务栏 "CourseManager API (watchdog)" 窗口。
5. 范围纪律：不做规格外功能；**Deterministic Code > LLM**；用户要求保守修改、不伤害现有功能。
6. 更新卡文案与 Release 正文一律白话（用户明确要求）。
7. 数据安全红线：Dexie 库名 `"course-manager"` 与 `course_manager_device_id` 是本机/设备持久化键，**改名工程永不得触碰**。

## 环境速查

- Windows 11、pnpm monorepo（`apps/web` React+Vite、`apps/api` Fastify、`packages/*` 分层域模型）；安卓全家与 cargo/rustup 在 E 盘（细节见 ANDROID_APK_BUILD.md）。
- 服务器：椰子云香港 `206.187.209.142`（`/opt/daymark`，systemd `cm-api` + Caddy 反代 3100）；SSH 密钥 `~/.ssh/id_ed25519_daymark2`；**VPS 带宽仅约 0.3Mbps（PR-002）**。
- GitHub：`violetsnowl/Daymark`——**系列 Release 策略**（`0.2.x` 每版并入 `v0.2.0`、**不新建 Tag**；Tag 只建不移；`v0.1.0` 历史永久保留；同系列资产不清理），当前版本 **0.2.2**（系列 Tag `v0.2.0` → `e3d326dc`，Release 标题 `Daymark 拾序 v0.2.0` 下 0.2.0/0.2.1/0.2.2 三版并存）。发布脚本 `scripts/publish_release.py`（安全模型与中转上传见 HOT_UPDATE_RELEASE.md）。
- 官网 daymark.top 已上线（独立仓库；含下载页 /download/）；网页版 app.daymark.top 已上线并用户验收（2026-10-12，见 [`docs/WEB_VERSION_DEPLOY.md`](docs/WEB_VERSION_DEPLOY.md)）。
