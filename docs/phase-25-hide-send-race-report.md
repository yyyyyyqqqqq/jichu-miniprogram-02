# Phase 25 隐藏会话 / 并发发送竞态修复报告

日期：2026-08-21
目标：staging（已脱敏）
范围：仅修复“甲方隐藏会话、乙方近同时发送消息”导致发送失败或新活动被陈旧隐藏覆盖的问题。

## 1. 根因与失败路径

- `hideConversation` 与 `sendMessage` 都会读取并更新同一 canonical `conversations` 文档。普通顺序操作没有并发写，因此不会触发；两端近同时操作时，乐观事务会在提交阶段检测到版本冲突。
- 随当前云函数打包的 `wx-server-sdk@4.0.2` 默认把底层事务最多执行 3 次，但会对所有异常重跑；次数耗尽后丢弃原始错误并抛出通用 `Transaction failed`。应用原先没有精确冲突分类或可控重试边界。
- 旧隐藏操作只写 `participantXHiddenAt` 并清零未读，没有保存“用户点击删除时看到的是哪一条最后消息”。事务重试或延迟执行后，它可能基于新快照清掉刚到消息的未读，形成陈旧隐藏覆盖新活动的语义风险。
- 截图中的“消息数据暂不可用，请稍后重试”来自 `messageAction -> DATABASE_ERROR -> MessageService` 的失败映射。staging 历史日志服务未启用，因此无法追溯当次原始平台日志；本次没有为取日志而启用新服务。根因由实际 SDK 源码、同一 canonical 文档写路径及可控冲突复现共同确认。

## 2. 最小修复

- `messageAction` 改用显式 `startTransaction / commit / rollback`：只对明确的 `DATABASE_TRANSACTION_CONFLICT` 重试，总尝试次数上限为 3；业务错误、网络错误及其他数据库错误不重试。
- 消息 ID 继续由 `conversationId + senderOpenid + clientMessageId` 确定生成。提交结果未知后使用同一 client ID 重试，只会复用既有消息，不会重复增加未读或触发第二份 canonical 副作用。
- 会话列表安全投影增加不含正文的 `lastMessageId`；客户端隐藏时同时提交 `expectedLastMessageId + expectedLastMessageAt`。
- 隐藏标记新增独立的 `participantXHiddenActivityId/At`，不复用“仅自己删除最后一条消息”的 `HiddenLastMessageId/At` 字段。若当前活动已变化，隐藏返回 `superseded` 且不清未读；客户端保留并刷新会话，提示“收到新消息，未删除会话”。
- 新消息仍在同一事务内写入消息与 canonical 摘要，并清除双方会话隐藏状态。预约系统消息路径原本会清除 `HiddenAt`，无需修改或重新部署 `appointmentAction`。
- 兼容旧隐藏记录：缺少新活动快照字段时，查询保留原有时间判断；无需迁移、索引或 ACL 变更。

## 3. 自动验证

- Phase 25 聚焦门禁：7 gates / 45 assertions，PASS。
- 可控竞态：A–D 全部 PASS：
  - A：hide read -> send read/commit -> hide commit/retry，陈旧隐藏返回 superseded，会话可见。
  - B：send read -> hide read/commit -> send commit/retry，新消息清除隐藏，会话可见。
  - C：显式冲突一次 -> 仅冲突重试 -> 发送成功，会话可见。
  - D：commit 结果未知 -> 同 client ID 重试 -> 单条消息、单次未读。
- 重复竞态：50 轮交替执行 A/B，共 381 条断言，PASS。
- Phase 24 pair-conversation：52 assertions/scenarios，PASS。
- 项目总验证：81 checks，PASS。
- JavaScript 语法、JSON、`git diff --check`：PASS。

## 4. staging 部署证据

仅部署以下确实变化的函数：

| 函数 | 状态 | 远端/本地源码 SHA-256 | 配置变化 |
| --- | --- | --- | --- |
| `messageAction` | Active / Available | `40f6a53c9623184ea2504a0c4a6035fa4d59000b08019870d76c2467a8d87a9c` / MATCH | 无 |
| `messageQuery` | Active / Available | `6308e001a0a9f68e0df9cde050e62af5a275790b71b5a248f869480a159cc82b` / MATCH | 无 |

- 未部署 `appointmentAction`。
- 未写业务数据，未修改集合、索引、ACL、环境变量或函数资源配置。
- 部署前维护模式为有效配置且 OFF；部署后再次回读确认 OFF。
- 未操作 production，未 commit / push / tag。

## 5. 真机定向复测

只需复测原始 A/B：A 连续执行“从消息列表删除”，B 在同一秒发送短文本，建议 5–10 轮并交换双方角色。每轮确认：

1. B 发送不出现“消息数据暂不可用”，消息只出现一次。
2. A 收到新消息后会话重新可见，未读为 1，最新摘要正确。
3. A 若点击的是陈旧列表项，会看到“收到新消息，未删除会话”，不会把新消息隐藏。
4. 双方历史记录连续，无重复 canonical 会话、重复消息或预约副作用。

当前结论：`READY FOR TARGETED STAGING RETEST`。这不是生产放行。
