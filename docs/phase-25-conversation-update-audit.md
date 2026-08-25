# Phase 25 conversation_update audit

日期：2026-08-21
证据 trace：`tr_ywtwvx00yw`

## 证据结论

本次 attempt 已完成 `message_write`，在旧的 `conversation_update` 阶段失败，尚未开始 commit；事务回滚后 deterministic message 不存在，对账为 `not_found`。这排除了 message set 阶段和 commit 结果未知，但旧阶段同时覆盖同步 payload 准备与 `document.update`，尚不能直接断言底层 update 请求失败。

## 1. 旧 conversation_update 的真实内容

### 同步 prepare

旧阶段先同步构造 `updateData`：

- `productId` / `lastProductId`：已验证的当前商品 ID；
- `productSnapshot` / `lastProductSnapshot`：由 `toProductSnapshot` 生成，只包含固定字段，字符串经 trim/截断，price 归一化为非负有限数；
- `lastMessage`：文本截断至 80 字，其他类型使用固定 summary；
- `lastMessageType`、确定性 `lastMessageId`、发送者 OPENID；
- `lastMessageAt` / `updatedAt`：两个 `db.serverDate()` 内部值；
- 双方 hidden 相关字段：固定清空值 `null` 或空字符串；
- unread：依据已验证 participant slot，只选择固定的 A/B unread 字段之一，并对事务内 fresh-read count 做非负整数归一化后加一。

这一部分可能同步抛错的位置是 `toProductSnapshot`、字符串/数值归一化、`db.serverDate()` 和普通对象构造。

### database write

prepare 之后执行：

```text
conversationDocument.update({ data: updateData })
```

在 `wx-server-sdk 4.0.2` / `@cloudbase/node-sdk 3.17.2` 中，该调用还包含 SDK 参数检查、对象 flatten、ServerDate 内部类型编码、EJSON 序列化、`database.modifyDocument` 事务请求、返回码检查及微信 SDK 错误包装。旧 stage 无法区分同步编码失败与远端事务 update 失败。

## 2. INTERNAL_ERROR 能解释到什么程度

上一轮加入的固定 SDK 数值码映射只会在以下已知输入上返回 `INTERNAL_ERROR`：

- `-501001`：SDK `SYS_ERR`；
- `-501003`：`EXCEED_REQUEST_LIMIT`；
- `-501004`：`EXCEED_CONCURRENT_REQUEST_LIMIT`；
- 原始 code/name 本身是白名单 `INTERNAL_ERROR`，或包含明确的 INTERNAL code token。

当前 diagnostic 只保留汇总后的 `INTERNAL_ERROR`，没有返回原始数值码，所以不能判断本次属于上述哪一种。特别是 `wx-server-sdk` 对未收录底层 code 会回退到 `SYS_ERR=-501001`，该类别不能证明 transient，也不能证明 transaction conflict。

## 3. hide+send 是否会制造非法 update payload

目前没有发现这种项目侧路径：

- payload 字段名固定；唯一条件字段只在 `participantAUnreadCount` / `participantBUnreadCount` 两个固定名称中选择；
- 没有把 hide 请求、expected snapshot、客户端对象或动态 field path 合入 update；
- 没有 `db.command.inc/push/remove` 等动态 command；
- 两个商品快照由同一份已经成功读取的 product record 经纯归一化生成；
- `undefined` 不会主动写入，ServerDate 是 SDK 明确支持的内部类型；
- hide 并发可以改变会话文档版本或同时更新 hidden/unread 字段，但不能改变 send 本地 `updateData` 的结构或类型。

自动回归也持续覆盖普通 send、hide/send 交错、冲突、幂等和 unread 状态。没有 payload 缺陷证据；但旧 stage 尚未证明本次已越过同步 prepare，所以本轮仍只做证据拆分，不把该结论夸大为远端故障定案。

## 4. 是否已有明确 CloudBase transient/internal failure 证据

没有。`transactionCreated=true`、`message_write` 完成和 `INTERNAL_ERROR` 说明错误位于事务体后段，但旧 stage 无法排除同步 prepare/serialization；安全码又合并了 SYS_ERR、请求限流和并发限流。当前不能把 INTERNAL_ERROR 整体标记为 retryable，也没有修改 retry 策略。

## 最小 stage 拆分

仅把发送 attempt 的旧阶段拆为：

- `conversation_update_prepare`：从 updateData 构造开始，到 unread 字段完成；
- `conversation_update_write`：从调用 `conversationDocument.update` 前开始，到 Promise 成功返回。

服务端和客户端继续使用封闭白名单；production 仍不返回或展示 diagnostic。send/hide/unread/summary/deterministic ID/reconciliation/retry 行为均未改变。

## 下一份证据的判定

如果下一次出现：

```text
lastCompletedStage=conversation_update_prepare
failedStage=conversation_update_write
```

那么同步 payload 构造将被直接排除，失败点会收敛到 SDK 的 update 参数检查、序列化或事务 `database.modifyDocument` 请求链。结合固定、无动态 command、已通过回归的 payload，可明确把它评估为“低概率 CloudBase/database update-path safe failure”的强证据，而不是继续无边界修改业务事务。

即便如此，`INTERNAL_ERROR` 汇总码本身仍不足以自动扩大 retry；是否调整错误归类或恢复策略，应基于下一份 stage 证据和可稳定识别的底层安全码单独决策。

## 验证与预发布交付

- 定向 stage 诊断回归：61 assertions 通过；
- hide/send 并发回归：899 assertions 通过；
- Phase 25 完整验证：8 gates / 57 assertions、81 project checks 全部通过；
- 仅部署预发布 `messageAction`，未部署其他云函数，未写业务数据，未修改 ACL、索引或维护状态；
- 云函数状态 `Active / Available`，运行时仍为 `Nodejs18.15`，diagnostic 环境角色为 staging；
- 本地与预发布远端源码 SHA-256 均为 `345fbe2ab6016ca24f3adfb06189f8c2b0d0e4f05d11d30982c5852c11d5fa47`；
- 新体验版构建成功，总包大小 526589 bytes；二维码文件 SHA-256 为 `9B6A92A3D18955BFA2797691E7DFEC0AD4D4268F036D722FDCD1E62F4CF22672`。

状态：已准备好采集最终 update-stage 证据；生产环境未变更。
