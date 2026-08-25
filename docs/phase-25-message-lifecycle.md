# Phase 25 Round 1：消息生命周期

## 本轮范围

本轮在 Phase 24 双人唯一 canonical 会话模型上增加四项能力：

- 消息列表长按删除会话：仅写当前参与者的隐藏时间，同时清零其未读；任一新消息或预约系统消息会清除隐藏标记，使会话重新出现。
- 聊天消息长按“仅从我这里删除”：仅写当前参与者槽位的删除标记，不物理删除消息或媒体。
- 发送者两分钟内撤回：以云函数服务器时间和消息 `createdAt` 判定；数据库保留原载荷，查询只返回不含原内容、媒体或业务快照的 `recalled` 安全投影。
- 转发到已有会话：客户端只提交原会话、原消息、目标会话和新的幂等键；云端读取可信原消息并创建新消息。图片和语音在云端复制到目标 canonical 会话目录。

## 兼容字段

全部为可选字段，不需要数据库迁移，也没有新增索引：

- conversations：`lastMessageId`、`participantAHiddenAt`、`participantBHiddenAt`、双方 `HiddenLastMessageId/At`。
- messages：`deletedForParticipantAAt`、`deletedForParticipantBAt`、`recalled`、`recalledAt`、`forwarded`。

旧消息没有 `lastMessageId` 时，删除最新摘要仍以 `createdAt === lastMessageAt` 兼容判断。旧别名入口继续先解析到 canonical 会话；新写入仍落 canonical。

## 安全与一致性

- 删除会话和删除消息都只影响操作方。
- 撤回只允许发送者，系统消息、已删除给自己的消息、已撤回消息和超时消息不能首次撤回；重复撤回返回幂等成功。
- 撤回未读修正在同一事务内完成并下限归零；重复撤回不重复扣减。
- 被撤回消息的数据库原载荷不返回客户端，会话摘要按查看方显示“你撤回了一条消息”或“对方撤回了一条消息”。
- 转发拒绝系统消息、撤回消息、当前查看方已删除的消息、非参与者目标和 merged 别名目标；事务内再次读取原消息，避免撤回/删除竞争后继续转发。
- 删除与撤回均不触发媒体物理清理。只有媒体转发复制后最终写入失败时，才回收刚生成的目标副本。

## 验证

本地入口：

```powershell
npm run phase-25-message-lifecycle:verify
```

该命令先检查 Phase 25 静态契约，再执行全项目验证。全项目消息云函数 mock 流程覆盖：撤回载荷隐私、未读只扣一次、双方删除可见性、会话隐藏与新活动浮现、可信新消息转发及撤回消息禁止转发。

当前自动覆盖还包括：120 秒边界与超时、system 禁止撤回/转发、recalled 媒体不回传、双方分别 delete-for-me 但原记录仍在、system delete-for-me 不影响预约、alias 入口、第三账号无副作用、text/image/voice/location/product 转发、旧 alias 媒体路径复制、merged 目标拒绝、转发重复请求不重复增加未读、8 秒轮询替换最新窗口以同步其他设备的删除/撤回状态，以及 Phase 24 canonical/alias 52 项回归。

## 修改文件与部署影响

- `cloudfunctions/messageAction/index.js`：四个生命周期 action、服务端撤回窗口、未读与摘要事务、媒体转发复制。
- `cloudfunctions/messageQuery/index.js`：按参与者过滤隐藏状态、删除状态、viewer-specific 摘要和 recalled 最小投影。
- `cloudfunctions/appointmentAction/index.js`：预约系统新活动写入 `lastMessageId` 并让隐藏会话重新出现。
- `services/message-service.js`：生命周期 DTO、错误码、recalled 安全归一化和客户端撤回窗口提示。
- `pages/messages/*`、`pages/chat/*`：长按菜单、点击隔离、删除/撤回反馈和跨设备轮询收敛。
- `pages/message-forward/*`、`app.json`、`constants/routes.js`：已有会话转发选择器与页面注册。
- `scripts/verify-project.js`、`scripts/verify-phase-25-message-lifecycle.js`、`package.json`：真实 mock 流程、聚焦门禁和命令入口。

2026-08-16 已按 `126.md` 定向部署 staging 的 `messageAction`、`messageQuery`、`appointmentAction`，并逐文件下载核对远端 SHA256；三者均为 Active/Available。已生成包含新页面的 staging preview。`appointmentQuery`、其他云函数、数据库 ACL、集合和索引均未改变。

## 主要风险与控制

- unread：撤回和 markRead/新消息都更新同一 conversation 文档并由事务冲突重试；计数下限为 0，重复撤回不再扣减。
- lastMessage：新消息写 `lastMessageId`；旧记录用时间等值兼容。删除摘要只对当前查看方投影，撤回不扫描历史重建上一条摘要。
- media：源路径同时校验 type、canonical/merged alias、原发送者、日期和 clientMessageId；目标副本进入目标 canonical/当前发送者目录。删除/撤回不做 GC。
- alias：所有生命周期 source 先解析 canonical；目标转发只接受 canonical，避免 alias 在选择器中重复出现。
- system/appointment：system 只允许 delete-for-me，不允许撤回或转发；消息和会话隐藏不删除 appointment。
- 并发/重试：写操作事务化；转发目标使用现有确定性 ID，首次成功后即使原消息随后撤回，同一幂等键仍返回既有结果，不复制第二份消息或重复加未读。

## Staging 双账号 / 第三账号验收清单

环境 preflight、三函数定向部署、远端 hash 核对和 preview 已完成；A 单账号可执行的消息/预约准备与安全探针也已完成。以下双账号/第三账号步骤仍未完成。当前只有 A↔B source canonical，没有 A↔C target canonical 和 merged alias；必须先由真实 B/C 账号通过普通业务路径补足，不能直接插库伪造。

1. A/B 先记录 conversations/messages/appointments 数量、双方未读和两个 canonical ID；确认 maintenance OFF，所有目标均为 staging。
2. B 给 A 发未读消息；A 在消息 Tab 长按删除 A↔B。确认 A 列表消失且未读清零，B 列表仍在，三集合数量不减少。重复删除不产生额外变化；从 alias 入口执行同样动作仍落 canonical。
3. B 再发一条普通消息，再触发一条预约 system 活动。分别确认两种新活动都会让 A 的会话重新出现，并且只各增加一次正确未读。
4. A 依次删除自己文本、B 文本、图片/语音/位置/商品和一条 system；确认 A 不见、B 仍见。B 再删除同一普通消息，确认数据库 message 和 appointment 仍存在，媒体 fileID 仍可由未删除方访问。
5. A 发文本后在 2 分钟内撤回；A 显示“你撤回了一条消息”，B 在一次 8 秒轮询内显示“对方撤回了一条消息”，消息列表摘要不含原文，B 未读安全减一。重复撤回与网络超时重试不再减未读。
6. A 再发消息并等待超过 2 分钟，确认客户端不再提供撤回；用旧界面/直接 staging 调用尝试时服务端返回 `MESSAGE_RECALL_EXPIRED`。B 撤回 A 消息、A 撤回 system 均失败且无副作用。
7. A 将 text/image/voice/location/product 从 A↔B 转发到已有 A↔C。确认目标生成新 ID、显示“已转发”、C 未读每条只加一、目标摘要正确；媒体位于 A↔C canonical/A 的合法路径，原文件保持。
8. 对同一 clientMessageId 重试转发；确认目标无重复消息、未读不重复。原消息在首次转发后撤回，再重试同一键仍返回首次结果；使用新键转发 recalled/system/已 delete-for-me 消息均失败。
9. 传 merged alias 作为转发目标、传 A 不参与的 active conversation、传 source/message 不匹配组合，全部应 fail closed 且目标无写入。
10. C 作为 A↔B 非参与者，分别尝试 hide、delete-for-me、recall、读取 source 并 forward，均返回 `FORBIDDEN`；对 conversations/messages/appointments/unread/summary/media 做前后快照，必须零副作用。
11. 做双击删除、双击撤回、撤回与 markRead 同时、撤回与 B 新消息同时、A hide 与 B 新消息同时、双方同时 delete-for-me；最终确认 unread 不小于 0、摘要对应最新活动、无第二 canonical、预约不丢失。
12. 回归普通文本、语音、图片/拍照、位置、商品卡片、预约全状态、markRead、历史分页、发送失败重试、8 秒轮询、不同商品进入同一用户对、alias 深链、跨校历史关系和 C 越权。保存 staging 函数 hash、客户端版本、前后快照与人工结果。

## 发布边界

本轮已完成本地实现、自动验证、staging 三函数定向部署、远端 hash 核对和 preview；production 未改变，也没有数据迁移、ACL/集合/索引或 maintenance 变更。A/B/C 人工门禁尚未完成，当前结论为 **NOT READY**。完整事实见 `docs/phase-25-round-1-staging-report.md`。
