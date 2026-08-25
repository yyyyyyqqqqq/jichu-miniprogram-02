# Phase 25 pre-commit failure evidence analysis

日期：2026-08-21
证据 trace：`tr_d9osi972uv`

## 结论摘要

本次证据确定：事务已经创建，确定性消息的存在性读取成功并返回不存在，失败发生在事务体后半段、`commit_start` 之前；消息未落库，对账为 `not_found`。证据不足以把该 UNKNOWN 错误认定为可重试，因此 retry 分类和三次上限均未修改。

## 1. transactionCreated 到 commitStarted 之间的真实执行顺序

`sendTextMessage` 进入 `sendMessage(..., forcedType='text')` 后，事务回调按以下顺序执行：

1. `canonical_resolve`：读取请求会话；若是 merged alias，再读取 canonical 会话。
2. `participant_validate`：验证当前 OPENID 是参与者；转发场景另校验 canonical 目标，普通文本不走该分支。
3. `existing_message_check`：按确定性 message ID 读取消息，执行 first-write-wins 幂等判断。
4. `context_validate`：从会话取得当前商品上下文并验证格式。
5. `context_product_read`：事务内读取当前会话商品，确认没有删除。
6. `payload_validate`：校验文本非空、长度，构造 message data，并调用 `db.serverDate()`。
7. `message_write`：`messageDocument.set({data})`。
8. `conversation_update`：构造安全商品快照、summary、last-message、hidden、unread 等更新，并执行 `conversationDocument.update({data})`。
9. `response_projection`：把事务内结果投影为安全响应对象。
10. 回调返回后，事务控制器才发出 `commit_start` 并调用底层 commit。

现有 diagnostic 中 `messageExistedBeforeAttempt=false` 只会在第 3 步的读取成功后写入，因此第 1–3 步已经完成。普通文本剩余的数据库调用主要是：当前商品 `get`、消息 `set`、会话 `update`。

## 2. UNKNOWN_SAFE_ERROR 的可能来源

显式 `businessError(...)` 会走单独的业务错误响应分支，不会生成这份 generic attempt diagnostic；所以本次更符合没有 `businessCode` 的 SDK/数据库异常或意外 JavaScript 异常。

具体候选包括：

- `context_product_read` 的事务内 document `get`；
- `message_write` 的 document `set`，包括 SDK 参数校验、EJSON/command 序列化和 `database.modifyDocument` 请求；
- `conversation_update` 的数据构造、序列化或 document `update` 请求；
- `db.serverDate()`、安全商品快照或安全响应投影中的同步异常；
- SDK 将底层错误包装为只有数值 `errCode` 或 `errCode=-1` 的普通 `Error`，而旧 classifier 不认识该表示。

## 3. SDK 是否会丢失数据库底层类别

会。当前函数安装的是 `wx-server-sdk 4.0.2` 和 `@cloudbase/node-sdk 3.17.2`。本地 SDK 源码显示：

- transaction document 的 `get/set/update` 会先调用 `@cloudbase/database`，再经过 `wx-server-sdk` 的 `checkError` / `maybeTransformError` / `toSDKError`；
- `DATABASE_REQUEST_FAILED` 会被映射为数值 `errCode=-502001`；其他数据库错误映射为 `-502002` 至 `-502005`；
- 旧 diagnostic classifier 只识别字符串 code/name，数值 `errCode` 因此会落入 `UNKNOWN_SAFE_ERROR`；
- SDK 对普通 Error 还可能统一写入 `errCode=-1`，此时原始底层类别也不一定可恢复。

本轮只依据 SDK 的固定映射表，将 `-502001..-502005` 安全归类为 `DATABASE_ERROR`、`-501002` 归类为 `CLOUD_TIMEOUT`、通用系统/限流数值码归类为 `INTERNAL_ERROR`。没有读取或返回 raw message、SDK object 或 stack，也没有用 message 文本猜测 DB_READ/DB_WRITE 类别；读写位置由独立白名单 stage 表达。

## 4. 是否仍可能是 commit 前事务竞争

可能，但不能确认。CloudBase 的事务读、set、update 请求本身都可能在回调尚未返回时失败；因此竞争不必等到显式 commit 才暴露。

SDK 源码还显示 `wx-server-sdk` 的错误码映射表没有显式列出 `DATABASE_TRANSACTION_CONFLICT`，未知底层 code 会回退为通用系统数值码。包装后的 message 形状也不保证命中项目当前的 exact-conflict 文本条件。所以“底层是 pre-commit conflict、包装后成为 UNKNOWN”在技术上成立，但当前 diagnostic 没有保留足够类别，不能把它当成已证实事实。

## 5. 是否支持把 UNKNOWN 改成 retryable

不支持。UNKNOWN 同时覆盖数据库请求失败、SDK 包装丢码、序列化异常和其他内部错误。把整个 UNKNOWN 类改为 retryable 会扩大业务行为并可能重复无意义或非瞬态操作。因此本轮没有修改：

- `isRetryableTransactionConflict`；
- application retry 次数；
- send transaction、hide snapshot、unread、summary 或确定性 ID；
- delivery reconciliation 决策。

## Stage diagnostic 变更

staging/development 的每次 attempt 现在只允许返回固定白名单中的 `lastCompletedStage` 和 `failedStage`。客户端用同一白名单重建响应，非法 stage 会使整份 diagnostic 被拒绝。production 仍因服务端显式环境角色和客户端私有环境角色双重门控而不返回、不展示 stage diagnostic。

下一次复现应能把失败收敛到 `context_product_read`、`message_write`、`conversation_update` 等具体阶段；如果仍为通用数值码，也不会据此自动改变 retry 策略。

## 验证与 staging 交付

- Phase 25 lifecycle：8 gates / 57 assertions，通过。
- hide/send race：899 assertions，通过。
- attempt/stage diagnostic：55 assertions，通过，包含 stage 白名单、固定 SDK 数值码映射、production 门控和敏感字段扫描。
- 全项目：81 checks，通过；`git diff --check` 通过。
- 仅重新部署 staging `messageAction`；远端为 Active / Available，源码 SHA-256 与本地一致，runtime/handler/timeout/memory、其他环境变量未改变。
- 未部署 `messageQuery` 或其他函数；未写业务数据，未改 ACL/集合/索引/maintenance，未操作 production。
- 最终 staging preview：本机临时目录中的 `phase25-pre-commit-stage-final-staging-preview.png`（未纳入 Git），526,553 bytes（514.2 KB）。
- 未 commit/push/tag。

当前结论：`READY FOR PRE-COMMIT-STAGE EVIDENCE RETEST`
