# Phase 25 Round 1：Staging 定向部署与验收准备报告

日期：2026-08-16
依据：`126.md`
结论：**NOT READY**

本报告只记录 staging 事实。没有执行 production 部署、production 数据操作、maintenance 切换、集合/ACL/索引变更、历史迁移、Git commit/push/tag 或 staging cleanup。

## A. Staging preflight

- Git：`main`，HEAD `7131e58a72dfe2a90342e8a23554c6e94aeabb6c`，与 `origin/main` ahead/behind `0/0`；Phase 25 工作区改动保持未提交。
- 目标：环境角色 `staging`，环境 ID `jichu-***022f`，AppID `wx5e54***418c`；active client target 与 staging 注册目标一致，且与 production 目标不同。
- 写入预检使用 staging masked target 明确确认；在 active client target 为 staging 时尝试 production audit 会被 `ACTIVE_ENVIRONMENT_MISMATCH` 拒绝。
- 部署前维护状态：结构有效，`enabled=false`，即 OFF。
- 部署前业务计数：users 3、products 2、conversations 1、messages 8、appointments 0；会话为 active canonical 1、merged alias 0。
- 部署前三个函数均为 Active/Available、Nodejs18.15、`index.main`、10 秒、256 MB。
- 三个函数的 `index.js`、`maintenance.js` 通过语法检查；`npm ci --ignore-scripts --dry-run` 通过；`wx-server-sdk 4.0.2`、`ws 8.21.3` 可加载。

## B. 三函数部署结果和 hash

仅部署：

- `messageAction`：success，部署包 23.3 KB。
- `messageQuery`：success，部署包 18.0 KB。
- `appointmentAction`：success，部署包 19.8 KB。

部署后回读三者均为 Active/Available、Nodejs18.15、`index.main`、10 秒、256 MB。远端下载包依赖均为 `wx-server-sdk 4.0.2`、`ws 8.21.3`，并可由 Node 加载。

| 函数 | 文件 | 本地/远端 SHA256 | 结果 |
| --- | --- | --- | --- |
| messageAction | index.js | `71083ad5fbd83504f6e3baa36e898a47a7853fa4c7c5756e13912a62b46ff932` | MATCH |
| messageAction | package.json | `10f02e0891f1be13d79953d7941a80765b83354f7a6431a1e30d8f2905a0251f` | MATCH |
| messageAction | package-lock.json | `fef58c4c7f55f5a941634ccc505f7ac8fe91bbf15a42c02ef430de94b6eb5be1` | MATCH |
| messageAction | maintenance.js | `55ad557f5aa8abc2e646a0f6fb825f89dbec627199c11f603cfe6e7cfecc5189` | MATCH |
| messageQuery | index.js | `6125c8c3fc99a72d1689656a64fb2929d63d464dd8a2aaa6f914f61e4f24967b` | MATCH |
| messageQuery | package.json | `501eac1bb79c650772f255be715bc1df11a89dbea9ca85b610f12d75ccaaeaba` | MATCH |
| messageQuery | package-lock.json | `a4b7d66744288d5a2162b6ea8b9de5bf5de82ec2f681af3666cfa1c86a1fc38b` | MATCH |
| messageQuery | maintenance.js | `ef4c9a75ffa370b02ea33804ce08552c8b82ef64b1e2bb40088f7d3ab3362b07` | MATCH |
| appointmentAction | index.js | `8959c9a8953071f9819b18bd47b655aa780ad8344e2ec5f4e0c544c9150e2f83` | MATCH |
| appointmentAction | package.json | `7139e279489945aa420e9271ec41744abbca6b366ad5759c7296b5c0582e588b` | MATCH |
| appointmentAction | package-lock.json | `9ee6857f9e72e0c77d59d37b0a36c09166daafe79615e537e24e1c000b2ada98` | MATCH |
| appointmentAction | maintenance.js | `55ad557f5aa8abc2e646a0f6fb825f89dbec627199c11f603cfe6e7cfecc5189` | MATCH |

部署前后只读计数均为 3/2/1/8/0，证明部署本身没有写业务数据。部署命令没有集合、ACL 或索引操作。

## C. 自动验证结果

- `npm run phase-25-message-lifecycle:verify`：PASS。显示的是 6 个聚焦测试门，不是 6 条断言；内部共 31 条独立断言，随后综合 81 项全部通过。
- 六门断言分布：server authorization/alias 6、recall projection 5、participant scope 6、trusted forward 5、long-press UX 5、runtime regression 4。
- `npm run phase-24-pair:verify`：PASS，52 assertions/scenarios。
- `npm run verify`：PASS，81 checks。
- 修改相关 JavaScript `node --check`：PASS；JSON parse：PASS；`git diff --check`：PASS。
- Staging preview：PASS，主包 508.4 KB（520,652 bytes），warning 0、error 0；`pages/message-forward/index` 已注册。只生成 preview QR，没有体验版/正式版发布。

## D. A/B 人工验收结果

当前开发者工具真实登录态是现有账号 A，现有 canonical 是 A↔B。通过小程序正常云函数路径完成的 A 侧结果：

- PASS：补齐 image、location，原有 text/voice/product，加预约 system 后六类业务消息齐全。
- PASS：A 隐藏会话后，一条全新用户消息使会话重新出现。
- PASS：A 隐藏会话后，预约 cancel system activity 使会话重新出现；随后保留一条新的 pending 预约。
- PASS：A 的 delete-for-me 查询投影不再返回目标文本，数据库 message 文档仍存在。
- PASS：A 在两分钟内撤回后查询只返回中和投影，数据库保留原始 payload；两次并发撤回均收敛为 recalled。
- PASS：超过 120 秒的 A 消息返回 `MESSAGE_RECALL_EXPIRED`；system 撤回返回 `MESSAGE_NOT_RECALLABLE`，均未修改目标消息。
- PASS：同一发送幂等键并发两次只生成一条消息；预约重复创建返回 `reused=true`。
- FAIL（未完成门禁，不代表已发现产品缺陷）：B 侧列表/未读/摘要、双方 delete-for-me、8 秒跨设备轮询、客户端 120 秒入口、预约接受/拒绝/完成、真机 UI 与 iOS/Android 检查均需要 B 的真实登录设备，当前未执行。

## E. C 越权结果

FAIL（未执行）：staging 已有第三个真实用户 C，但当前没有 C 的登录会话，无法合法执行 C 对 A↔B 的 hide/delete/recall/read/forward/markRead 越权矩阵。没有伪造 OPENID，也没有直接改库。

## F. 并发结果

- PASS：同 clientMessageId 并发发送只落一条。
- PASS：同一条新消息两次并发 recall 收敛为 recalled；unread 最终非负。
- FAIL（未执行）：A hide + B new message、A recall + B markRead、A recall + B new message 三项跨账号关键门禁；缺少 B 的同时在线会话。

## G. 媒体转发结果

- 直接 image/voice 消息的两个 media fileID 均匹配当前 canonical 合法路径。
- 同一 A↔B 会话作为转发目标被服务端拒绝为 `INVALID_FORWARD_TARGET`，没有绕过目标约束，也没有产生 forwarded message。
- FAIL（未执行）：A↔B 到 A↔C 的 text/image/voice/location/product 转发、目标媒体复制、幂等与 recall 竞态。原因是当前两件可用商品均由 A 发布，A 无法通过正常业务路径建立 A↔C；staging 也没有 merged alias。未直接插入会话或别名，未做危险媒体故障注入。

## H. 最终 staging 数据摘要

- users 3、products 2、conversations 1、messages 18、appointments 2。
- active canonical 1、merged alias 0、duplicate active pair key 0。
- 消息：text 11、image 1、voice 1、location 1、product 1、system 3；recalled 1、A delete-for-me 1、forwarded 0。
- 预约：cancelled 1、pending 1；两条预约关键字段完整，预约 system message 存在。
- 所有 conversation unread 均 `>= 0`；没有第二 active canonical。
- 当前数据不足：A↔C canonical 缺失，merged alias 缺失；两件商品只有一个 seller。新建的 image 与现有 voice 都有 canonical 路径和 message 引用，但未执行全存储桶 orphan 扫描。

## I. Maintenance 状态

最终只读核对：配置结构有效，`enabled=false`，即 OFF。全过程没有切换 maintenance。

## J. Production readiness 判断

**NOT READY**

阻塞项：A↔C canonical 与 A↔B merged legacy alias 尚未通过普通业务路径准备；B/C 双设备人工矩阵、三项跨账号并发门禁、跨 canonical 转发与媒体复制、第三账号越权和真机 UI 尚未完成。下一步需要项目负责人用真实 B/C 账号完成数据准备和 `126.md` 第 13—31 节人工验收；在此之前不得进入 production。
