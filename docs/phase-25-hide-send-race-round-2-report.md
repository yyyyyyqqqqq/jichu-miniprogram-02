# Phase 25 hide/send 极窄竞态第二轮报告

日期：2026-08-21
环境：staging（脱敏）
结论：`READY FOR SECOND TARGETED STAGING RETEST`

## A. 第一轮为什么仍会失败

第一轮应用分类器能识别原始 `DATABASE_TRANSACTION_CONFLICT`，但真实提交路径经过了 `wx-server-sdk@4.0.2` 的有损包装：

1. 底层 `@cloudbase/database@1.4.3` 在 commit 返回 `res.code` 时直接抛出响应对象，真实冲突码位于 `error.code`。
2. `wx-server-sdk` 的 `Transaction.commit()` 再调用 `returnAsFinalCloudSDKError/toSDKError`；对普通对象只读取 `errCode/errMsg`，不保留 `code/message`。
3. 原始 `{ code: 'DATABASE_TRANSACTION_CONFLICT', ... }` 因而可能变成 `errCode=-1`、`transaction.commit:fail undefined ...`。
4. 第一轮分类器无法安全确认这是冲突，于是没有进入 attempt 2，直接映射为 `DATABASE_ERROR`；这正是截图中的 Toast 和红色失败气泡路径。

第一轮的 activity snapshot 语义本身正确，并明显缩小了窗口；剩余失败不是“三次 fresh transaction 仍耗尽”，而是第一次真实 commit conflict 在 SDK 包装处丢码后被误判为不可重试。

## B. 真实 UI 与发送链路审计

### 删除确认框

- `pages/messages/index.js` 在 longpress 时从当前 `this.data.conversations` 读取 item，并把整个 conversation 对象闭包传入确认框。
- `expectedLastMessageId/At` 因此冻结在 longpress 时；弹窗等待期间列表状态可能变化，但 confirm 不会把旧意图升级为新 activity。
- confirm 成功：仅本地移除该列表项，不额外查询或写库。
- superseded：提示“收到新消息，未删除会话”，触发一次 reset list query。
- 失败：保留列表并显示带安全 trace ID 的错误。
- `listConversations` 是纯查询；消息列表页不调用 `markConversationRead`。`requestVersion/isRefreshing` 会屏蔽重叠或过期查询结果。

### 发送

- optimistic bubble 使用稳定的 `clientMessageId` 和独立安全 `traceId`。
- message insert 与 canonical conversation 的 latest/unread/hidden 更新完全处于同一事务，commit 前失败会整体回滚。
- 每一应用 attempt 都执行新的 `startTransaction`，重新解析 canonical、participant slot、latest activity 和 existing deterministic message。
- client-supplied expected activity 在 hide retry 间保持不变；不会被 fresh read 替换。
- existing message 检查在 payload 写入前；同 client ID 复用已有消息，不重复增加 unread 或摘要副作用。

## C. 第二轮修复

### `cloudfunctions/messageAction/index.js`

- 使用当前锁定 SDK 暴露的 raw transaction control 执行 commit/rollback，避免有损 `wx-server-sdk` commit 包装；业务读写仍使用官方 transaction collection wrapper。
- 保持最多 3 次，仅原始、明确的 `DATABASE_TRANSACTION_CONFLICT` 可重试。
- 每次重试均创建全新 transaction 并完整重新读取，不复用 conversation 或 participant snapshot。
- 增加最小安全 trace：action、trace ID、attempt、transaction created、raw-error preservation、commit start/end、safe code、retryable、会话/消息哈希、expected/current activity 时间与哈希、snapshot changed、message existing、response outcome。
- 不记录 OPENID、正文、clientMessageId、真实 conversation/message ID、文件、头像或坐标。

### `cloudfunctions/messageQuery/index.js`

- 新增只读 `getMessageDeliveryStatus`。
- 服务端以当前身份、原 conversation ID 和同一 client ID 重新计算 deterministic message ID；校验参与者、sender 和 canonical conversation 后才返回 safe message。
- 查询不写 conversation、不 mark read、不修复状态，不参与写冲突。

### `services/message-service.js` / `pages/chat/index.js`

- 对 `DATABASE_ERROR / INTERNAL_ERROR / NETWORK_ERROR / CLOUD_TIMEOUT / CLOUD_CALL_FAILED / INVALID_RESPONSE` 只进行一次只读 delivery reconciliation。
- 找到 deterministic message 才把 pending bubble 转成功；找不到或对账失败则保留原失败。
- 不重新调用 send、不换 client ID、不吞业务错误、不直接伪造成功。
- 请求 trace ID 即使响应丢失也保留；若最终仍失败，Toast 显示安全诊断编号。

### `pages/messages/index.js`

- 保持 longpress 冻结 M1 的语义；stale confirm 始终由服务端返回 superseded。
- hide 失败显示安全诊断编号，便于关联 send/hide trace。

## D. 为什么不是降低概率

- 真实 commit conflict 不再经过会丢失 `code` 的包装，因此精确重试分支是确定的，而不是碰运气。
- M1 hide 意图在所有 attempt 中保持 M1；M2 一旦存在，hide 必为 superseded 或 send 在 fresh retry 后清除 hide。最终 M2 可见、摘要为 M2、未读只增加一次。
- commit 结果未知不再永久产生红色失败状态：客户端只读确认同一个 deterministic message 已存在后恢复成功。
- 非冲突、业务错误和未确认成功的请求仍失败，不会被掩盖。

## E. 自动验证

- Phase 25：8 focused gates / 57 assertions，PASS；相对第一轮新增 1 gate、12 条第二轮断言。
- 专项：Case A–F、三次冲突耗尽、SDK wrapper 丢码绕过、commit 结果未知、list refresh 并发，PASS。
- 重复 interleavings：120 轮；专项总计 899 assertions，PASS。
- Phase 24 pair：52 assertions/scenarios，PASS。
- 项目总验证：81 checks，PASS。
- JavaScript syntax、JSON parse、`git diff --check`：PASS。

关键新增场景：

- E：list=M1 -> longpress freeze M1 -> B send M2 -> delayed confirm(M1) -> superseded、M2 visible、unread=1。
- F：confirm(M1) 与 send(M2) commit 真正交错 -> fresh transaction retry -> M2 visible、single message、single unread。
- attempt 1/2/3 全冲突 -> 保留原始 `DATABASE_TRANSACTION_CONFLICT`，无部分写。
- commit 应用成功但响应丢失 -> 同 client ID 只读对账 -> single message、single unread、success recovery。

## F. staging 部署与预览

仅部署实际变化函数：

| Function | Status | Runtime | Remote/local source SHA-256 |
| --- | --- | --- | --- |
| `messageAction` | Active / Available | Nodejs18.15 | `67b9694df429d7b3f40f5e1aea8f9d294a666ca2f06349b9fdb7e8fcbbdd1945` / MATCH |
| `messageQuery` | Active / Available | Nodejs18.15 | `3290f88650af30be25f93362fbcfc14eaa5e1ae8526bcc50c122e8e25dc1f1ed` / MATCH |

- handler、timeout、memory、environment variables 均未改变。
- 未部署 `appointmentAction`。
- 未写业务数据，未改 collection/index/ACL/maintenance。
- 部署后 maintenance 再次回读：valid、OFF。
- 已用当前工作区生成新的 staging preview QR：本机临时目录中的 `phase25-round2-staging-preview.png`（未纳入 Git）。
- production 未操作；未 commit/push/tag。

## G. 真人复测

使用本轮新 preview，双方角色互换，总计 10–20 轮：

1. A 在消息列表 longpress，停留在删除确认框。
2. B 在聊天页准备短文本。
3. A 点“删除”与 B 点“发送”尽量同时。
4. 允许出现“收到新消息，未删除会话”；不允许数据库错误或红色失败气泡。
5. 每轮核对单条消息、无丢失、A 会话可见、unread 正确、latest summary 正确。
6. 若仍失败，记录 Toast 中 `tr_...` 诊断编号；该编号可直接关联 action、attempt、commit outcome 与只读对账结果。

真人复测前的最高结论仅为：`READY FOR SECOND TARGETED STAGING RETEST`。
