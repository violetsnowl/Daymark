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
- 域名：`app.daymark.top` 绑定为该 Worker 的自定义域名。**切换前先删除**占位 A 记录（192.0.2.1）与 `app-to-download` 跳转规则——Redirect Rules 在 Worker 之前执行，规则在就永远 302。
- Supabase：Authentication → URL Configuration → Redirect URLs 增加 `https://app.daymark.top` 与 `https://app.daymark.top/**`（登录 / 魔法链接回跳；appOrigin() = `window.location.origin`）。

## 变更记录（2026-10-12）

- `FirstLaunchGuide` 的显示门从 `isAndroid()` 收紧为 `isTauri() && isAndroid()`：安卓手机浏览器 UA 命中 `isAndroid` 但**没有**壳的跳转设置页，会误弹壳专用首启引导（三个设置按钮点了没反应）。纯浏览器（桌面/手机）与桌面壳不再出现；安卓壳行为不变。纯函数门 `shouldShowPermissionGuide` 语义不变，单测保持。
- 新增根级 `wrangler.jsonc`：静态资产部署配置，不参与任何现有构建（wrangler 之外的工具不读取它）。

## 验收清单（部署后逐项标记）

- [ ] 预览 URL（`daymark-app.<account>.workers.dev`）：启动无控制台报错；快速记录（本地）闭环；语言切换；移动端断点无横向溢出。
- [ ] `app.daymark.top`：自定义域名绑定后 200；下载页「进入网页版」直达应用。
- [ ] 登录 → 同步端到端（真实账号，**由用户执行**）：登录成功、云数据出现、与壳端一致。
- [ ] 待定项：同一浏览器多标签页的并发同步行为（双同步器）专项验证；`navigator.storage.persist()` 持久化申请（可选，有云同步兜底）。

## 已知边界（如实记录）

- 浏览器版提醒仅在页面打开时有效——浏览器限制，非缺陷；壳的自动更新 / 托盘 / 后台通知仍为壳专属。
- 网页版定位：免安装体验 + 手机浏览器顺手入口；壳仍是完整体验。
