# 拾序 Daymark · 发布与热更新手册（跨 agent 必读）

> 面向接手本仓库的任何 agent/模型：本文自包含，不依赖任何本地会话记忆。
> 维护阶段的 bug 总账在 [`POST_RELEASE_BUGS.md`](POST_RELEASE_BUGS.md)；本文只讲“怎么发版与热更新”。

## 0. 一句话架构

桌面（Windows）走官方 `tauri-plugin-updater`（ed25519 验签，**验签含版本绑定**：清单版本必须等于产物签名版本，否则拒绝）；**安卓全自研**（插件的移动端安装是空实现），链路：启动查清单 → 弹卡 → 系统 DownloadManager 后台下载 → 前台应用内弹窗/后台通知 → 装前完整性校验 → Kotlin 挑系统安装器 → 系统安装页。清单与产物同时托管：清单在 `api.daymark.top/update/latest.json`，**安卓包下载源 = GitHub Release CDN**（VPS 实测带宽仅约 0.3Mbps，见 PR-002），服务器 `/opt/daymark/update/` 留作镜像。

## 1. 发版流程（一条命令 + 两个前置）

1. **改版本**：`src-tauri/tauri.conf.json` 的 `version` **必须递增**（与线上清单相等不触发更新）。
   **发布策略（当前，2026-10-12 起）**：**系列 Release**——`0.2.x` 每个版本都并入 **`v0.2.0`**（0.1.x 当年同样全部挂在 `v0.1.0` 下），**不为 `0.2.1` / `0.2.2`… 新建 Tag**；系列 Tag 只在首发时创建、**永不移动**（无 `git tag -f`/`git push -f`）。资产名仍带完整版本号（`daymark_0.2.2_x64-setup.exe`），同系列历史包长期保留、不自动清理；Release 标题统一 `Daymark 拾序 v0.2.0`。
   **历史记录**：2026-10-11 曾短暂改为「每版本独立 Release/Tag」（因此产生了 `v0.2.1` 这一个例外），2026-10-12 按用户要求恢复系列策略；`v0.1.0` 的历史 Release/Tag/资产完整保留。
2. **双端构建**（签名环境变量必须带，否则无 `.sig`）：
   - exe：`pnpm exec tauri build` → `src-tauri/target/release/bundle/nsis/拾序_<ver>_x64-setup.exe` + `.sig`
   - apk：补丁版 `E:\devtools\tauri-cli-src\tauri-cli-2.12.1\target\release\cargo-tauri.exe android build --ci --apk`（四坑见 [`ANDROID_APK_BUILD.md`](ANDROID_APK_BUILD.md)）
3. **一键发布**：`uv run --with paramiko python scripts/publish_release.py --notes "<更新卡文案（白话）>" --body "<Release 正文（白话）>"`
   = 验签（缺 `.sig` 自动补签）→ **确保 Tag/Release**（`v<版本>` 不存在则创建且永不移动；已存在但指向别的提交=失败关闭）→ **版本化资产暂存 + 内容校验**（SHA-256 确认一致才复用，线上引用资产绝不覆盖）→ 逐 URL 大小校验（无法确认即停）→ **清单原子翻转放最后**（SFTP posix_rename 单翻转点，失败关闭、旧清单保持可读；翻转异常先回读三分类）→ **更新正文（`merge_body` 按小版本分节合并：新版插最前打「（当前）」、自带该版本 exe/apk 下载链接、历史小节整体保留、重跑同版本原地替换）** → **刷新固定名别名**（上传后校验；失败=报「部分完成」exit 2 + 恢复路径，不报成功）→ **回读核对**（预期资产齐备；未预期资产只报告不自动删除——多 Release 模式永不清理历史版本资产，旧版可用性优先）。**翻转前任何失败 = 线上零变化，直接重跑即可。**
4. **终检**：`curl -s https://api.daymark.top/update/latest.json`（version/URL/notes）+ 下载 `Content-Length` 与本地产物一致 + Release 资产回读 = **每版本两件**（`daymark_<ver>_x64-setup.exe`、`app-universal-release-<ver>.apk`）**+ 固定名别名** `app-universal-release.apk`。**保留策略（真实行为）**：同系列各版本资产在**同一个系列 Release 下长期保留**（`v0.2.0` 下 0.2.0 / 0.2.1 / 0.2.2 并存），历史 Release（含 `v0.1.0`）永不自动清理、永不修改——旧版下载与回退可用性优先。**Release 正文按小版本分节**（`# 拾序 Daymark 系列更新记录`，`---` 分隔），每节带该版本自己的下载链接；GitHub 的资产列表本身是扁平的、平台不支持分组，分节正文即各版本的入口。

## 2. 关键位置

| 东西         | 位置                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 更新签名私钥 | `E:\devtools\tauri-keys\daymark.key`（**绝不入库**；丢失=所有旧装机无法再更新）；公钥在 `tauri.conf → plugins.updater.pubkey`                                                                                      |
| 清单/镜像    | 服务器 `/opt/daymark/update/latest.json`（Caddy `handle_path /update/*` + `ACAO *`）                                                                                                                               |
| GitHub 仓库  | `violetsnowl/Daymark`（旧地址 301；发布脚本内已是规范名）                                                                                                                                                          |
| 发布脚本     | `scripts/publish_release.py`（版本化资产 `daymark_<ver>_x64-setup.exe`/`app-universal-release-<ver>.apk` + 固定名别名 `app-universal-release.apk`；清单最后原子翻转；删除与正文走 `curl -L`、上传 URL 百分号编码） |
| 安卓安装插件 | `src-tauri/gen/android/.../DaymarkSettingsPlugin.kt`（设置页/安装器挑选/DownloadManager 三命令）                                                                                                                   |
| 前端更新逻辑 | `apps/web/src/updateService.ts`（平台分流、后台轮询、完成事件/通知/持久标记）                                                                                                                                      |
| 真机验证方法 | 桌面壳带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` 启动 → WebSocket CDP `Runtime.evaluate`（记得 `awaitPromise`）读 DOM/控制台；安卓无 CDP，靠真机口述                                  |

## 3. 踩坑速查（现象 → 原因 → 解）

| 现象                                                            | 原因                                                                                | 解法                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安卓点更新报 `SecurityException: com.android.shell ≠ uid`       | Android 14+ 禁止 app 进程 `am start`                                                | 一切系统页/安装器调起走 Kotlin 插件真 Intent                                                                                                                                                                                                        |
| 发布报 `WinError 10054` / `curl 56`（翻转前抛栈或「部分完成」） | urllib POST 上传 30MB 在本网络必被重置（实测 2/2）；curl 同端点可用                 | **`upload_asset` 已改用 curl + 3 次退避重试**；仍「部分完成」时先看是否已翻转——清单多半已生效、版本化资产完好，缺的往往只是固定名别名（只服务旧链接，**不影响客户端更新**）→ 重跑脚本（幂等）或 curl 单发 `POST --data-binary` 补传后按 digest 回读 |
| `cargo-tauri android build` 报 `Android SDK not found`          | `ANDROID_HOME` / `NDK_HOME` / `GRADLE_USER_HOME` 未设（本机未进用户级环境变量）     | 按 `scripts/build-apk-0.1.12.ps1` 顶部三行 export（SDK `E:\devtools\android\Sdk`、NDK `26.1.10909125`、gradle-home）                                                                                                                                |
| `No Activity found … pkg=com.android.intentresolver`            | `resolveActivity()` 可能返回选择器本体                                              | 枚举处理器；**只认 FLAG_SYSTEM 应用**（PR-001：MT管理器等第三方曾被点名）                                                                                                                                                                           |
| `Unsupported path /data/data/.../cache`                         | DownloadManager 拒绝应用内部私有目录                                                | `getExternalFilesDir("update")` + `setDestinationInExternalFilesDir`；失败自动回退直接下载安装                                                                                                                                                      |
| 安装报 `(33) packageinfo is null`                               | 损坏/截断包进了安装器                                                               | 装前三重校验（≥5MB + ZIP 魔数 + 字节比对），不完整判 failed 明示                                                                                                                                                                                    |
| Release 资产变 `_0.1.x_...` 中文被剥、清单 404                  | GitHub 不接受非 ASCII 资产名                                                        | 资产/清单 URL 统一 `daymark_*` ASCII 别名（安装包内部显示名仍为拾序）                                                                                                                                                                               |
| Release 正文 PATCH 307 失败                                     | urllib 不重放带 body 的 307（且旧仓库名 301）                                       | `curl -L -X PATCH`（脚本已改）                                                                                                                                                                                                                      |
| 手机更新**永远**只能到“上一版”                                  | 不是——检查永远对齐**最新**清单，天然跳版；但见铁律                                  | 见下                                                                                                                                                                                                                                                |
| 更新卡安装环节用的还是坏代码                                    | **铁律：执行安装的永远是已装版本的代码**                                            | 坏手版本手动装一次破局（已三次：0.1.2/0.1.5/0.1.7）                                                                                                                                                                                                 |
| 图标命令后安卓图标/底色变了                                     | `cargo-tauri icon` 连带重写 gen 安卓资源与 `ic_launcher_background.xml`             | 按验收参数重生成安卓五密度+前景、底色回 `#F8F6F1`                                                                                                                                                                                                   |
| `COLUMN_TOTAL_BYTES_*` 编译不过                                 | 常量名记错                                                                          | 真名 `COLUMN_TOTAL_SIZE_BYTES`（javap android.jar 实证）                                                                                                                                                                                            |
| 桌面双击快捷方式无限开新窗                                      | 无单实例锁                                                                          | `tauri-plugin-single-instance`（桌面 cfg 门控，安卓无此插件）                                                                                                                                                                                       |
| 安卓 rustBuild 报 `Creation symbolic link is not allowed`       | 标准用户无开发者模式；且 `BuildTask` 走 `pnpm tauri` 可能落到**未打补丁**的 npm CLI | ① 补丁版 `cargo-mobile2` 对 `TargetStyle::File` 一律 `fs::copy`；② `gen/android/.../BuildTask.kt` **直连** `cargo-tauri.exe`，勿走 `pnpm tauri`                                                                                                     |

## 4. 空包测试法（临时抬清单验证更新链）

改服务器 `latest.json` 的 `version` 字段抬一位（如 0.1.9→0.1.10）→ 真机点卡实测 → **验完必须改回**。
注意：桌面端会因版本绑定**正确拒绝**（别点）；安卓端不验此绑定，可完整走通。历史空包轮：0.1.10、0.1.11（后均转正）。

## 5. 硬性约定（项目级）

- 本地回归四件套 + Rust：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`（基线 **304+1**）+ `src-tauri` 下 `cargo check` 0 警告，全 0 才可提交。
- 每轮改动 commit + push 中文提交信息；**密钥正则自检**（`sk-…/whsec…/PRIVATE` 出现次数=0）；`.env` 永不入库。
- 永不向真实 Supabase 写演示/种子数据；验收先查真实数据库。
- 不关闭任务栏 "CourseManager API (watchdog)" 窗口。
- 更新卡与 Release 正文一律**白话**（面向用户，不写技术语言）。
