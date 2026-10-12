# Web 版（app.daymark.top）部署与验收 — 记录

> 状态：**部署准备中**（2026-10-12）。可行性结论来自当日的代码走读 + 生产构建浏览器实测。

## 为什么这条路可行（已核实）

- 应用本体就是标准 Web 应用（桌面/安卓外壳只是包壳）：数据层 = IndexedDB（Dexie，浏览器原生）；同步 = 直连 `api.daymark.top`（outbox / cursor）。
- 服务器 CORS 是 `@fastify/cors` 的 `origin: true`（反射任意 Origin；bearer token、无 cookie）→ **新域名零服务器改动**。
- Tauri API 仅存在于少量文件且全部带 `isTauri()` 门控：更新检查与窗口栏整体跳过；提醒走 `BrowserNotificationAdapter` 回退。
- 构建：`VITE_API_BASE_URL=https://api.daymark.top pnpm build` → 纯静态产物 `apps/web/dist`（无 URL 路由，单页状态导航）→ Cloudflare Workers 静态托管（同官网手法）。

## 部署配置

- 仓库根 `wrangler.jsonc`：`name = daymark-app`，assets = `./apps/web/dist/`。
- Cloudflare：Workers 项目 `daymark-app` ← GitHub `violetsnowl/Daymark`（Workers Builds 导入）。
  - Build command：`VITE_API_BASE_URL=https://api.daymark.top pnpm build`
  - Deploy command：`npx wrangler deploy`
  - **Build variables and secrets（Settings → Build）**：`VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`（值取自根 `.env`；缺失则线上账号层降级——仅本机、账户面板无登录口；2026-10-12 首构遗漏后补配）。
- 域名：`app.daymark.top` 绑定为该 Worker 的自定义域名。**切换前先删除**占位 A 记录（192.0.2.1）与 `app-to-download` 跳转规则——Redirect Rules 在 Worker 之前执行，规则在就永远 302。
- Supabase：Authentication → URL Configuration → Redirect URLs 增加 `https://app.daymark.top` 与 `https://app.daymark.top/**`（登录 / 魔法链接回跳；appOrigin() = `window.location.origin`）。

## 变更记录（2026-10-12）

- `FirstLaunchGuide` 的显示门从 `isAndroid()` 收紧为 `isTauri() && isAndroid()`：安卓手机浏览器 UA 命中 `isAndroid` 但**没有**壳的跳转设置页，会误弹壳专用首启引导（三个设置按钮点了没反应）。纯浏览器（桌面/手机）与桌面壳不再出现；安卓壳行为不变。纯函数门 `shouldShowPermissionGuide` 语义不变，单测保持。
- 新增根级 `wrangler.jsonc`：静态资产部署配置，不参与任何现有构建（wrangler 之外的工具不读取它）。
- Cloudflare Workers 项目 `daymark-app` 自本仓库首构并部署成功（2026-10-12，workers.dev 预览 `https://daymark-app.a161858970.workers.dev`）。
- 2026-10-12：`app.daymark.top` 由「→ 下载页 302」改绑为网页版本体（`daymark-app`）；官网下载页「进入网页版」就此接通。
- 2026-10-12（晚）：线上构建缺 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`（首构只给了 `VITE_API_BASE_URL`）→ 线上账号层降级为「仅本机」、账户面板无登录口。修法 = CF 项目 Settings → Build → Build variables and secrets 补两条（值自根 `.env`），保存后由下一次构建生效。
- 2026-10-12（晚）：两条构建变量已由用户在 CF 补配并重建生效。**已验证**：线上 bundle 含 Supabase 配置；账户面板登录口回归（「连接同步」+ 手机号 / Google / 邮箱 / 手机号密码四个入口）。

## 验收清单（部署后逐项标记）

- [x] 预览 URL `https://daymark-app.a161858970.workers.dev`（2026-10-12 首构 `d572ab93`）：启动零控制台报错；快速记录（本地）闭环（raw_captures=1 / items=1 / outbox_mutations=4，自然语言解析正确）；CORS 直连 `api.daymark.top`（health 200）；安卓 UA：首启引导不误弹、无横向溢出。
- [x] `app.daymark.top`：绑定完成并验证（2026-10-12）——200 直出应用；下载页「进入网页版」直达；`api` 三件套不受影响。绑定弹窗有已知抽风：输入子域报 `No zones match app.daymark.top` 并提示 "start by adding the domain to Cloudflare"（**陷阱，勿照做**）；绕法 = 弹窗内先选 zone `daymark.top` + 子域填 `app`，或改用 Route（占位 `A 192.0.2.1` 橙云 + `app.daymark.top/*`）。
- [x] 登录 → 同步端到端：**用户验收成功（2026-10-12）**——登录顺利、数据同步，网页版正式收货。
- [ ] 待定项：同一浏览器多标签页的并发同步行为（双同步器）专项验证；`navigator.storage.persist()` 持久化申请（可选，有云同步兜底）。

## 已知边界（如实记录）

- 浏览器版提醒仅在页面打开时有效——浏览器限制，非缺陷；壳的自动更新 / 托盘 / 后台通知仍为壳专属。
- 网页版定位：免安装体验 + 手机浏览器顺手入口；壳仍是完整体验。
