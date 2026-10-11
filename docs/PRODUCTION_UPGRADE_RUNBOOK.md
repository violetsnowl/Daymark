# 生产升级执行手册 — migration 007 + API 部署 + 客户端发版（时间语义升级）

> **状态：全部步骤均为「待授权操作」。** 本手册只做准备；任何生产写操作
> （007 迁移、部署/重启 cm-api、发版、改线上清单）必须逐项获得明文授权后才执行。
>
> 编写基线：`main` @ `c0d4c2140f131daa84f4449025e617a6fb4f76a6`（2026-10-11）。
> 配套文档：`docs/ADR-010-date-datetime-precision.md`（语义规格）、
> `docs/HOT_UPDATE_RELEASE.md`（热更新链路）、`scripts/publish_release.py`（发布脚本）。

## 0. 硬顺序（不可调换）

```
① 生产库应用 migration 007  →  ② 部署新 API  →  ③ 真实 API 冒烟验证  →  ④ 正式客户端发版
```

- **007 必须先于 API 部署**：新 API 的 sync INSERT/SELECT 引用 `due_date` 等新列，
  库里没列会直接 SQL 报错。007 对**旧 API 完全安全**（纯增列+约束+索引，旧代码不引用），
  所以「先迁移、旧 API 继续跑」没有窗口风险。
- **API 必须先于客户端发版**：新客户端的同步载荷带新字段，旧 API 的 zod 校验会 400
  （已知断链 bug）；新 API 向后兼容旧载荷（缺键→null，real-PG 实测 2/2 佐证）。
- **人工实机验收（附录 A）应在①②③完成后、④之前进行**（尤其线上同步项依赖新 API）。

## 1. 前置条件与工具

| 项           | 值                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------- |
| 服务器       | 椰子云香港 `206.187.209.142`（Ubuntu 24.04），SSH `root` + 密钥 `~/.ssh/id_ed25519_daymark2` |
| API 部署目录 | `/opt/daymark/daymark`（git 仓库）                                                           |
| API 服务     | systemd `cm-api`，Caddy 反代 `127.0.0.1:3100`，对外 `https://api.daymark.top`                |
| 健康检查     | `https://api.daymark.top/api/v1/health`                                                      |
| 更新目录     | `/opt/daymark/update/`（Caddy `handle_path /update/*` + `ACAO *`）                           |
| 数据库       | Supabase 生产库（连接串只从服务器 `.env` 读取，不抄写、不入库）                              |
| 迁移器       | `pnpm db:migrate`（按文件名顺序执行 `backend/migrations/*.sql`，记录进 `schema_migrations`） |

## 2. 升级前状态确认（只读，可先做）

SSH 到服务器后，用服务器上的连接串执行只读查询（示例以 `psql "$DATABASE_URL"` 形式给出）：

| 检查               | 命令                                                                                                                                                                                  | 期望                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 迁移基线           | `SELECT count(*) FROM schema_migrations;`                                                                                                                                             | **6**（001–006；007 未应用） |
| 新列尚不存在       | `SELECT column_name FROM information_schema.columns WHERE table_name='items' AND column_name IN ('due_date','start_date','occurrence_start_date','occurrence_end_date','time_zone');` | **0 行**                     |
| 数据规模           | `SELECT count(*) FROM items; SELECT count(*) FROM raw_captures;`                                                                                                                      | 记录数字，升级后比对         |
| 既有 DATETIME 样本 | `SELECT id, due_at, occurrence_start_at FROM items WHERE due_at IS NOT NULL OR occurrence_start_at IS NOT NULL LIMIT 5;`                                                              | 记录，升级后比对不变         |

任何一项不符 → **停止**，先查清再继续。

## 3. 备份与备份可恢复性验证（007 之前的必做步）

1. **备份**（只读导出）：
   `pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc -f /root/daymark_pre007_$(date +%Y%m%d_%H%M).dump`
2. **异地留一份**（下载到本机或第二处存储）。
3. **可恢复性验证**（关键——没有验证过的备份不算备份）：在**一次性本地 PostgreSQL**
   （便携 16.6，即用即删；工具链已在 RC gate 实证）里：
   `createdb restore_check && pg_restore --no-owner -d restore_check <dump文件>`
   然后比对 `items`/`raw_captures` 行数与第 2 步记录一致。
4. 验证通过前 **禁止** 执行 007。

## 4. 应用 migration 007

在服务器部署目录（连接串取自 `.env`）：

```
cd /opt/daymark/daymark && git fetch && git checkout <本次授权的 main SHA>
pnpm install --frozen-lockfile
DATABASE_URL="<服务器 .env 中的生产连接串>" pnpm db:migrate
```

预期输出：`Applied 007_date_precision.sql`（若 001–006 重跑则幂等跳过）。

**迁移后检查（只读）：**

| 检查           | 命令                                                                                                                            | 期望                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 迁移记录       | `SELECT count(*) FROM schema_migrations;`                                                                                       | **7**                          |
| 新列存在       | （第 2 步同款查询）                                                                                                             | **5 行**                       |
| 约束存在       | `SELECT conname FROM pg_constraint WHERE conname LIKE 'items_%precision_check' OR conname='items_occurrence_date_order_check';` | 5 个约束                       |
| 旧数据语义不变 | 第 2 步 DATETIME 样本复查                                                                                                       | `*_at` 值逐一不变，新列全 NULL |
| 行数不变       | 与第 2 步比对                                                                                                                   | 完全一致                       |

**007 内容**（`backend/migrations/007_date_precision.sql`，纯增、幂等）：
`raw_captures.captured_tz`；`items` 五个新列（`start_date`/`occurrence_start_date`/
`occurrence_end_date`/`due_date`/`time_zone`）；5 个 CHECK（DATE xor DATETIME 互斥 +
occurrence 日期先后）；1 个部分索引 `items_owner_due_date`。

## 5. 部署 API

```
cd /opt/daymark/daymark
pnpm --filter @daymark/api build
systemctl restart cm-api
systemctl is-active cm-api        # 期望 active
curl -s https://api.daymark.top/api/v1/health   # 期望 200 健康 JSON
```

重启窗口（秒级）内客户端同步会瞬时报错——客户端有重试/退避，属预期。

## 6. 真实 API 冒烟验证

| #   | 动作                                                                                  | 期望                                                                                             |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `curl -s -o /dev/null -w '%{http_code}' https://api.daymark.top/api/v1/health`        | 200                                                                                              |
| 2   | `curl -s -o /dev/null -w '%{http_code}' -X POST https://api.daymark.top/api/v1/items` | 401（未带令牌被拒，路由在、认证在）                                                              |
| 3   | 旧版 0.1.15 客户端登录、随手建一条普通事项、重启应用读回                              | 保存成功、读回一致（旧载荷缺键→null）                                                            |
| 4   | 新版客户端（测试包）创建 DATE 事项 + DATETIME 事项、编辑互切、重启读回                | 精度保持、互斥清对侧                                                                             |
| 5   | 只读库检                                                                              | `SELECT id, due_date, due_at, time_zone FROM items ORDER BY created_at DESC LIMIT 5;` 与界面一致 |
| 6   | 冲突解卡                                                                              | 手机端那条卡住的 RawCapture 冲突打开后选「已同步记录」保存 → 成功（服务端白名单修复随部署生效）  |

## 7. 旧版 0.1.15 客户端兼容要求（API 更新窗口期）

- **载荷方向**：旧客户端不发送新字段 → 新 API 视为 NULL（contracts「缺省视为 null」，
  real-PG 集成测试实证）。旧客户端一切功能不受影响。
- **响应方向**：新 API 响应多出的字段被旧客户端忽略（loose DTO）。
- **约束安全**：旧客户端写入永不触碰新列 → CHECK 全 NULL 放行，不受 007 约束影响。
- **同步窗口**：⑤ 重启瞬间同步请求失败属预期，客户端退避重试即可，无需人工干预。
- **注意**：在④发版之前，**新测试包客户端**的云同步不完整（旧 API 校验新字段载荷会 400
  ——即已知断链 bug）。所以双端线上同步验收必须排在①②之后。

## 8. 失败停止点、回退与恢复

| 失败点                                 | 处置                                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 2/3 步检查不过                      | 停止，无任何变更，查清再继续                                                                                                                                                                                           |
| `pnpm db:migrate` 中途报错             | **停止**。007 大多幂等（IF NOT EXISTS / DROP IF EXISTS）；先 `SELECT count(*) FROM schema_migrations`（应仍为 6，迁移器事务性记账）并核对是否有半应用 DDL（查 information_schema）；能续跑则续跑，不能则见「结构回退」 |
| 部署后 `cm-api` 起不来 / health 非 200 | 先看 `journalctl -u cm-api -n 50`。若为代码问题：`git checkout <上一个已知好的 SHA>` + 重新 build + restart（**API 回退不需要回滚 007**——旧 SQL 不引用新列，约束对旧写入全 NULL 放行）                                 |
| 冒烟 3/4 不过                          | 停止发版；API 可按上行回退；数据无损                                                                                                                                                                                   |
| 发版后客户端异常                       | 清单可回退到上一版内容（脚本清理保护保证旧资产仍在，直接重发旧清单即可），见 HOT_UPDATE_RELEASE.md                                                                                                                     |

**结构回退（仅紧急）**：**不要指望降级 API 自动回滚 schema——迁移不会自动撤销。**
007 是纯增列；回退 API 后新列闲置无害，通常**无需**结构回退。若确需撤销：
优先用第 3 步备份整体恢复（pg_restore 到新库再切连接串）；
`DROP INDEX items_owner_due_date; ALTER TABLE items DROP CONSTRAINT …, DROP COLUMN …`
（删列会**丢弃**新客户端已写入的日期数据）——只在备份恢复不可行且明文授权后才考虑。

## 9. 客户端发版（④，另需单独授权）

版本号递增（`src-tauri/tauri.conf.json`，0.1.15 → 新号）→ 双端构建（带签名环境）→
`uv run --with paramiko python scripts/publish_release.py --notes … --body …`
（脚本顺序已加固，见 `scripts/publish_release.py` 头注与 PR-006 记档）→ 按
HOT_UPDATE_RELEASE.md 终检（公网清单 200、Content-Length、验签）。

**已批准资产策略（2026-10-11 用户裁决）**：GitHub 资产版本化命名
（`daymark_<v>_x64-setup.exe` + `app-universal-release-<v>.apk`），固定名
`app-universal-release.apk` 保留为**兼容别名**（翻转后刷新并校验，兼容 README/客户端回退）；
Release 资产 = 每版本两件 + 别名，保留最近 2 个版本，清理永不触及线上引用。
README 与 HOT_UPDATE_RELEASE.md 的资产数量/命名/发布顺序说明**已同步修订**。
固定 tag `v0.1.0` 策略与正式版本号不变。

---

## 附录 A：发布前人工实机验收清单（NOT RUN — 必须由用户在双端实测）

以下场景自动化测试已覆盖逻辑，但**设备级实测全部未完成**（不得记 PASS）：

| #   | 场景                                                                    | Windows | Android | 备注                 |
| --- | ----------------------------------------------------------------------- | ------- | ------- | -------------------- |
| 1   | 输入「2026年10月20日交作业」→ 创建结果为 DATE（无伪造午夜时间）         | ☐       | ☐       |                      |
| 2   | 带具体时间的输入 → DATETIME，时分正确                                   | ☐       | ☐       |                      |
| 3   | 标题净化：「2026年10月21日课堂展示」→ 标题「课堂展示」、日期 2026-10-21 | ☐       | ☐       |                      |
| 4   | 列表年份规则：本年不显年份、跨年（2027/2025）显年份；TimeBlock 同规则   | ☐       | ☐       | 可借系统改日期测跨年 |
| 5   | 日历全天事件范围、详情、编辑面板日期一致                                | ☐       | ☐       |                      |
| 6   | DATE→DATETIME→DATE 互切，对侧字段清空、精度不丢                         | ☐       | ☐       |                      |
| 7   | 编辑保存后重启应用，日期/精度/时区不漂移                                | ☐       | ☐       |                      |
| 8   | DATE 提醒实机通知（到期=当日日终、发生=09:00 锚点）                     | ☐       | ☐       | 桌面+手机通知        |
| 9   | 离线创建/编辑→恢复联网→同步一致，RawCapture 原文未被改写                | ☐       | ☐       | 需①②完成             |
| 10  | 双端行为差异对照                                                        | ☐       | ☐       | 用同一账号各测一遍   |
| 11  | 旧版 0.1.15 客户端在新 API 下正常使用                                   | ☐       | ☐       | API 部署后验         |

（源自 RC Gate 报告的 NOT RUN 项 + 第二阶段验收遗留的 6/7/8 项，全部保留未完成状态。）
