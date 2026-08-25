# Phase 25 Production Read-Only Review

审计日期：2026-08-25（Asia/Shanghai）
审计目标：`[ENV] PRODUCTION` / `cloud1***6d8e`
审计性质：只读；未部署、未调用生产云函数、未写数据库、未修改环境变量/ACL/索引/集合/存储
最终结论：**NOT READY FOR PRODUCTION AUTHORIZATION**

## A. Executive Summary

生产现状健康：Phase 24 Git 和远端云函数基线一致，canonical conversation、message、appointment、ACL 和现有索引审计均通过；Phase 25 自动回归与已完成的双账号人工验收也通过。已知极窄 hide/send 现象属于低频、事务回滚后客户端可见的 availability safe failure，没有数据损坏证据。

但上线授权仍有一个重大 blocker：**Phase 25 写出的 recall/delete-for-me/hide 状态不能安全地由完整 Phase 24 代码读取。**

- recall 只新增 `recalled=true` / `recalledAt`，原正文或媒体仍保存在 message；
- Phase 25 query 会返回脱敏 recalled projection；
- Phase 24 `messageQuery` 不识别 `recalled`，完整回滚后会重新返回原正文/媒体；
- Phase 24 同样忽略 delete-for-me 和 conversation hide 字段，会让用户已删除/隐藏的内容重新出现。

这不会破坏数据库结构，但会破坏撤回与个人删除的隐私/用户语义。根据 133.md 的 rollback gate，当前必须判定 NOT READY。修复或正式定义“不回滚 projection 层”的最低安全回滚版本，并新增相应回归后，才可重新申请 production authorization。

## B. Scope / Safety Boundary

本轮仅执行：

- Git、diff、依赖与本地代码只读检查；
- production `Describe*` 元数据读取；
- production 数据库 `QUERY`，且只投影结构字段；
- production 云函数 detail/source hash 读取；
- 本地自动测试。

明确没有执行：

- production deploy / function invoke；
- database INSERT / UPDATE / DELETE；
- migration、maintenance、环境变量、ACL、index、collection 或 storage 修改；
- 测试消息、会话、预约或用户创建；
- Git commit / push / tag。

审计器为 `scripts/audit-phase-25-production-readonly.js`，数据库命令类型封闭为 `QUERY`。输出只含聚合计数、ACL、索引、函数配置和源码 hash；未导出正文、fileID、坐标、OPENID 或真实内部 ID。第一次连接因本地临时凭证过期在访问数据前失败；执行只读 `env list` 刷新本地登录态后重跑。一次元数据读取出现 `ECONNRESET`，原样只读重跑后成功。

## C. Git / Local Baseline

| 项目 | 结果 |
| --- | --- |
| current branch | `main` |
| HEAD | `7131e58a72dfe2a90342e8a23554c6e94aeabb6c` |
| origin/main | `7131e58a72dfe2a90342e8a23554c6e94aeabb6c` |
| ahead / behind | `0 / 0` |
| staged | 0 |
| modified | 13（Phase 25 本地业务/客户端/测试文件，未 staged） |
| untracked | 15 个 porcelain entries（目录按单项计数；Phase 25 页面、测试脚本、诊断/审计文档） |

Phase 24 封版基线确认：

- commit：`7131e58a72dfe2a90342e8a23554c6e94aeabb6c`
- tag：`phase-24-complete`
- tag 指向上述同一 commit。

本轮没有自动提交任何文件。

## D. Phase 25 Change Inventory

分类：A = production 业务；B = staging/development diagnostic；C = test/audit-only；D = documentation。

| 模块 | 变更与原因 | Phase 25 功能 | production 必需 | 分类 |
| --- | --- | --- | --- | --- |
| `cloudfunctions/messageAction/index.js` | participant ACL、hide-for-me、delete-for-me、2 分钟 server recall、forward、`lastMessageId`、隐藏恢复、deterministic delivery/reconciliation 支持、精确 transaction-conflict bounded retry | 完整消息生命周期与 hide/send 一致性 | 是 | A + B |
| `cloudfunctions/messageQuery/index.js` | 隐藏会话/个人删除过滤、recalled safe projection、forwarded projection、`lastMessageId`、只读 delivery status | 查询侧隐私与失败对账 | 是 | A + B |
| `cloudfunctions/appointmentAction/index.js` | system message 写 `lastMessageId` 并清空双方 hide/latest-delete 状态 | appointment activity 恢复隐藏会话 | 是 | A |
| `cloudfunctions/appointmentQuery` | 无 Phase 25 本地变更 | 无 | 否 | — |
| `services/message-service.js` | 新 actions、optional-field normalize、失败 delivery reconciliation、trace/diagnostic 白名单与客户端 gate | 客户端业务边界 | 是（随小程序） | A + B |
| `pages/messages/*` | 长按仅本端删除会话、stale hide superseded、列表更新；安全 diagnostic modal | hide-for-me UX | 是（随小程序） | A + B |
| `pages/chat/*` | 长按删除/撤回/转发、recalled/forwarded UI、发送失败/对账状态；安全 diagnostic modal | message lifecycle UX | 是（随小程序） | A + B |
| `pages/message-forward/*` | 选择 existing canonical target conversation 并转发 | forward UX | 是（随小程序） | A |
| `app.json` / `constants/routes.js` | 注册转发页与路由 | forward | 是（随小程序） | A |
| `package.json` | 增加 Phase 25 本地 verify/deploy 脚本入口 | 工程验证 | 否 | C |
| `scripts/verify-project.js` | Phase 25 runtime/security/compatibility regressions | 自动验证 | 否 | C |
| `scripts/verify-phase-25-*.js` | lifecycle、race、attempt diagnostic 专项回归 | 自动验证 | 否 | C |
| `scripts/deploy-phase-25-hide-send-race.js` | staging-only、只允许 `messageAction/messageQuery` 的诊断发布器 | staging evidence | 否，且拒绝 production | C |
| `scripts/audit-phase-25-production-readonly.js` | 本轮结构字段最小化 production 只读审计 | 上线 gate | 否 | C |
| `docs/phase-25-*.md` | staging、race、trace、update-stage 和本审计证据 | 交付记录 | 否 | D |

### Diagnostic 分类决策

建议采用 Option A：保留 diagnostic 代码，但 production 双重 gate 永远关闭。

应保留但仅 staging/development 启用：

- attempt count / safe code / retryable / transaction-created；
- commit outcome / reconciliation outcome；
- last-completed-stage / failed-stage；
- diagnostic JSON viewer/copy modal；
- `JICHU_ENVIRONMENT_ROLE` 显式角色 gate。

不得成为 production 行为：

- `diagnostic` response 字段；
- attempt/stage JSON viewer；
- raw SDK error、stack、OPENID、真实业务 ID、正文或媒体/位置字段。

保留理由：字段和 action/stage/code 均为封闭白名单，对 staging 极低频问题仍有价值；server 和 client 均 fail closed，测试已覆盖。删除会降低未来可诊断性，并不解决当前 rollback blocker。

## E. Production Data Baseline

2026-08-25 只读统计：

| Collection | count | 实际扫描数 |
| --- | ---: | ---: |
| users | 8 | 8 |
| products | 72 | 72 |
| conversations | 26 | 26 |
| messages | 156 | 156 |
| appointments | 22 | 22 |

Phase 24 报告末次为 155 messages；当前增加 1 条，但全部一致性检查通过，不构成异常。

conversation 状态：

- active canonical：6
- merged alias：20
- invalid/unknown status：0

## F. Canonical Conversation Integrity

| Invariant | 结果 |
| --- | ---: |
| duplicate active `participantPairKey` | 0 |
| duplicate all `participantPairKey` | 0 |
| missing `participantPairKey` | 0 |
| active canonical malformed | 0 |
| merged alias malformed | 0 |
| alias -> canonical dangling | 0 |

真实 Phase 24 schema 使用：

- active：`status=active`、`schemaVersion=2`、`participantPairKey=pp_<digest>`；
- alias：`status=merged`、`mergedInto=<canonical id>`、`participantPairKey=archived:<legacy conversation id>`。

生产数据未使用 `canonicalConversationId` 作为 alias 持久字段；代码中的解析字段为 `mergedInto`。unordered user-pair 唯一 canonical 和 archived aliases 均保持 Phase 24 invariant；没有重新生成 product-level active conversation。

## G. Message / Appointment Integrity

### Messages

| 检查 | 结果 |
| --- | ---: |
| total / unique ID | 156 / 156 |
| orphan | 0 |
| conversation missing | 0 |
| conversation not active canonical | 0 |
| sender not participant | 0 |
| invalid stored type | 0 |
| malformed recalled state | 0 |
| malformed delete-for-me state | 0 |

生产仍是 Phase 24 数据，因此 recalled/delete-for-me optional fields 缺失是合法状态，不被误判。

### Appointment / system message

| 检查 | 结果 |
| --- | ---: |
| appointments | 22 |
| appointment conversation missing | 0 |
| appointment conversation not canonical | 0 |
| appointment participant mismatch | 0 |
| appointment product missing | 0 |
| system messages | 58 |
| system appointment ref missing | 0 |
| system/appointment conversation mismatch | 0 |

代码复核确认 system message 不允许 recall；delete-for-me 仅写 participant-scoped optional flag，不物理删除 message 或 appointment record。

### unread / latest summary

6 条 active conversation 当前均没有 `lastMessageId`，符合 Phase 24 历史数据兼容设计；Phase 25 使用空值 fallback，不要求 backfill。

| 检查 | 结果 |
| --- | ---: |
| lastMessageId present | 0 |
| optional lastMessageId absent | 6 |
| referenced message missing | 0 |
| message/conversation mismatch | 0 |
| invalid lastMessageType | 0 |
| invalid lastMessageAt | 0 |
| last sender not participant | 0 |

unread 的实时准确值不能仅凭静态只读快照完全证明：`not fully provable by read-only audit`。现有结构 invariant、自动 interleavings 和双账号人工验收通过。

## H. ACL / Security Review

生产 ACL：

| Collection | ACL |
| --- | --- |
| messages | `ADMINONLY` |
| conversations | `ADMINONLY` |
| appointments | `ADMINONLY` |

`pages/` 与 `services/` 未发现对上述敏感集合的直接 database collection 访问；读写均通过云函数，Phase 24 安全模型未漂移。

### Production diagnostic safety

production 当前 `messageAction` 和 `messageQuery` 的 `JICHU_ENVIRONMENT_ROLE` 均为 **unset**。本轮未修改。

默认行为安全：

- server 只有值严格等于 `staging` 或 `development` 才创建/返回 diagnostic；unset/production/unknown 均关闭；
- client 还要求有效 private target 且 `environmentName` 为 staging/development 才接受 diagnostic；production 会丢弃；
- viewer 只有在 service 返回已白名单化 diagnostic 时才展示，因此 production 不展示或复制 JSON；
- response diagnostic 不包含 OPENID、conversationId、messageId、clientMessageId、正文、fileID、坐标、raw SDK object 或 stack；
- raw server failure response 只返回业务安全 code/message；SDK raw object 与 stack 不返回。

send/hide response 仍可返回随机、格式封闭的 opaque `traceId` 用于失败关联；它不是 trace detail，也不能反推出业务 ID。normal business DTO 必须包含自身 API 所需的 conversation/message ID；“内部 ID 不泄漏”在本审计中指 diagnostic/error payload 不额外泄漏这些关联字段。

当前工作区 client private target 是 staging。上线 seal 时必须显式切换并验证 production private target；本轮不修改。

## I. Production Function Matrix

所有函数当前均为 Phase 24 production 版本：

| Function | Status | Available | Runtime | Handler | Timeout | Memory | installDependency | Role |
| --- | --- | --- | --- | --- | ---: | ---: | --- | --- |
| messageAction | Active | Available | Nodejs18.15 | index.main | 10 | 256 | TRUE | unset |
| messageQuery | Active | Available | Nodejs18.15 | index.main | 10 | 256 | TRUE | unset |
| appointmentAction | Active | Available | Nodejs18.15 | index.main | 10 | 256 | TRUE | unset |
| appointmentQuery | Active | Available | Nodejs18.15 | index.main | 10 | 256 | TRUE | unset |

## J. Local vs Production Deploy Matrix

| Function | Production SHA-256 | Local Phase 25 SHA-256 | Changed | Phase 25 deploy | 原因 |
| --- | --- | --- | --- | --- | --- |
| messageQuery | `a758d68da1d811d692a6bf0330580b3ecf155e215bb91b71a7a91cd6339b0313` | `c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30` | 是 | 是 | hide/delete/recalled projection + reconciliation |
| messageAction | `c900008f137638353709eff3424f532352da82d6416802bf749506010694c0f6` | `345fbe2ab6016ca24f3adfb06189f8c2b0d0e4f05d11d30982c5852c11d5fa47` | 是 | 是 | lifecycle actions、transaction consistency、optional writes |
| appointmentAction | `b95fb9618fc0efd4d46c6b5ac4b734c806371f99a0c57f7458776b7e58d25f91` | `8959c9a8953071f9819b18bd47b655aa780ad8344e2ec5f4e0c544c9150e2f83` | 是 | 是 | system activity 写 lastMessageId 并恢复 hide |
| appointmentQuery | `1747a0333a75395c9458778318495b8c1585866ab1f50021ab889c21e58d388f` | `1747a0333a75395c9458778318495b8c1585866ab1f50021ab889c21e58d388f` | 否 | 否 | 无有效 Phase 25 变更 |

production hash 与各自 Phase 24 commit source hash 全部相同。

## K. Dependency / Runtime / Index Review

### Schema compatibility

新增持久字段均为 optional additive fields：

- conversation：`lastMessageId`、participant A/B hide/activity/latest-delete 时间和 ID；
- message：participant A/B delete-for-me 时间、`recalled`、`recalledAt`、`forwarded`。

新代码对旧记录使用 normalize/boolean/date fallback。生产 6 条 active conversation 全部没有 `lastMessageId` 仍能通过审计，证明不要求 migration/backfill。无需新 collection、migration 或 backfill。

注意：这是“旧数据 -> 新代码”兼容；“新数据 -> 完整 Phase 24 回滚”存在 Q 节 blocker。

### Runtime / dependency

- cloud function `package.json` / lockfile 无 Phase 25 变化；
- `wx-server-sdk ^4.0.2` 与 `ws 8.21.3` 不变；
- root dependency 无新增、无版本变化、无 package-lock 变化；
- production runtime 仍为 Nodejs18.15。

**No new production dependency/runtime migration required.**

### Index

所需已有索引：

- messages：`idx_conversation_createdAt_id`、`idx_conversation_sender_clientMessage_unique`；
- conversations：`idx_participant_pair_unique`、A/B status + lastMessageAt + id；
- appointments：conversation/product/status、buyer/seller/status 等 Phase 24 indexes。

Phase 25 不要求新 index：

- delete-for-me 在已授权 conversation message page projection 中过滤；
- recall、forward source/target、delivery status 和 lastMessageId 都按 deterministic `_id` / document lookup；
- `participantPairKey` 继续使用现有 unique index；
- 没有按 `lastMessageId` 做集合查询。

### Performance

- 普通 send 仍是 message set + conversation update 的同一事务；新增 optional fields 不增加正常路径 document write 数；
- transaction 只对精确识别的 conflict bounded retry，最多 3 attempts；未扩大 INTERNAL_ERROR retry；
- delivery reconciliation 只在列入安全集合的失败路径触发一次只读 deterministic message lookup；
- conversation/message list 为跳过 hidden/delete-for-me 记录可能分页多轮，代码上限 8 轮；普通无隐藏数据接近原查询成本；
- forward 会读取 source/target canonical conversation 与 source message；image/voice 还会做受控的 server-side download/validate/upload copy，失败时清理已复制文件；
- production gate 关闭后 attempt/stage diagnostic 不增加 DB/network 请求或 response payload，但仍有少量 collector/no-op CPU；
- separate safe trace 会对 send/hide 做截断 hash 与安全日志 I/O，不含原 ID/正文。它是可观测性开销，不是 staging diagnostic response。建议上线 seal 时明确生产日志保留策略，但当前未发现安全泄漏。

## L. Diagnostic Production-Safety Review

安全证明由代码审计与 `verify-phase-25-attempt-diagnostics.js` 共同覆盖：

- staging/development response 可以返回严格白名单 attempt/stage/reconciliation；
- production collector disabled，response 不含 `diagnostic`；
- production client normalization 再次拒绝 diagnostic；
- viewer 因无 normalized diagnostic 不展示；
- whitelist 拒绝未知 action/stage/code/shape 和超过 3 attempts；
- sensitive-field regression 覆盖 OPENID、真实 IDs、正文、fileID、坐标、raw error、stack。

结论：建议保留代码并保持 production 双 gate 关闭。生产环境变量 unset 的当前默认行为 fail closed，无需也不得在本轮修改。

## M. Known Residual Risk

正式风险记录：

> Low-frequency CloudBase/database update-path safe failure observed under intentionally synchronized hide/send stress. Transaction rollback and client-visible failure preserve consistency; no evidence of partial write or canonical/unread corruption.

已知证据：

- intentionally synchronized hide/send 极窄人工压力；
- `lastCompletedStage=conversation_update_prepare`；
- `failedStage=conversation_update_write`；
- `safeCode=INTERNAL_ERROR`；
- transaction created，但 commit 未开始；
- deterministic message 不存在、reconciliation `not_found`；
- transaction 原子回滚，message/unread/summary 无半写；
- 客户端明确失败，用户可以安全重试。

风险分类是 **availability/transient safe failure**，不是 data corruption。当前安全码不足以证明具体 CloudBase 根因，因此不描述为“100% CloudBase bug”，不增加 retry，也不继续无边界修改极端 race。

## N. Manual + Automated Validation Evidence

| Evidence | 结果 |
| --- | --- |
| normal-use smoke | PASS |
| hide/send automated interleavings | PASS，899 assertions |
| Phase 25 lifecycle focused tests | PASS，8 gates / 57 assertions |
| attempt/stage diagnostic tests | PASS，61 assertions |
| project verification | PASS，81 checks |
| dual-account manual lifecycle validation | PASS |
| extreme synchronized hide/send | rare safe failure documented |

双账号人工验收覆盖正常发送、列表隐藏/恢复、delete-for-me、2 分钟内/超时撤回、forward、unread、latest summary 和正常进入/退出/刷新。

## O. Rollout Plan

当前计划被 Q 节 blocker 暂停；以下仅为 blocker 关闭后的候选计划，不执行。

### Step A — Git seal

1. 先解决/决策 Phase 24 rollback projection blocker并新增 regression；
2. 复跑完整测试和本 production read-only audit；
3. 审查 Phase 25 完整 diff，切换并验证 production private target；
4. 经负责人授权后再 commit/push/tag；本轮不执行。

### Step B — Maintenance strategy

Phase 25 是 additive optional schema + 云函数/客户端发布，无 migration、backfill、collection 或 index 变更。blocker 解决后可采用无 maintenance 发布，避免无必要停服；部署窗口内暂停人工 lifecycle smoke，待后端三函数 hash/状态一致后再发布客户端。

### Step C — Minimal deployment order

1. `messageQuery`：先让读取层认识 recalled/delete/hide optional states；
2. `messageAction`：再开放 lifecycle writers；
3. `appointmentAction`：最后让 system activity 写 `lastMessageId` 并恢复 hide；
4. 发布 production-target 小程序客户端；
5. `appointmentQuery` 不部署。

### Step D — POST-AUTHORIZATION VALIDATION

以下均需真实生产写入，本轮未执行：

- 双账号 normal text send + unread/latest summary；
- hide conversation，随后对方新 activity 恢复；
- delete-for-me 只影响一方；
- sender recall 2 分钟内成功、超时与 system recall 拒绝；
- text/image/voice/location/product forward；
- appointment system message 在隐藏后恢复；
- 第三账号 ACL/participant denial；
- 每项后做只读 message/conversation/appointment integrity delta 检查。

### Step E — Rollback

Phase 24 target commit/hash：`7131e58a72dfe2a90342e8a23554c6e94aeabb6c` / `phase-24-complete`。

在任何 Phase 25 lifecycle mutation 发生前，可以回滚三个候选函数和客户端到 Phase 24，无数据库 rollback。

一旦已有 recalled/delete/hide 数据，**不得完整回滚 `messageQuery`/读取 projection 到 Phase 24**。安全应急策略只能是：

- 停止或回滚产生新 lifecycle 状态的 action/client；
- 保留能识别 Phase 25 optional flags 的 query/projection 安全底座；
- roll-forward 修复；
- 无数据 migration rollback。

这目前不是符合要求的“完整 Phase 24 rollback”，因此是授权 blocker。

## P. Rollback Plan Detail

| Phase 25 data | Phase 24 读取结果 | 结论 |
| --- | --- | --- |
| `lastMessageId` | 忽略 | 安全 |
| forwarded message | 仍是合法原始 message type；忽略 `forwarded` 标签 | 结构安全，标签丢失 |
| conversation hidden fields | Phase 24 list 不过滤，隐藏会话重现 | 用户语义不安全 |
| delete-for-me flags | Phase 24 listMessages 不过滤，个人删除消息重现 | 隐私/用户语义不安全 |
| recalled flags | Phase 24 query 忽略 flag 并返回仍存原正文/媒体 | **重大隐私 blocker** |
| recalled latest summary | Phase 24 不认识 `recalled` type，但可能显示已撤回摘要文本 | 表现降级；不是主要 blocker |

关闭 blocker 的候选方向由负责人另行授权，至少需二选一：

1. 修改 recall 的持久化/redaction 设计，使 Phase 24 projection 也不可能恢复原内容，并验证各 message type；或
2. 正式建立不可回退到 Phase 24 query 的 minimum safe rollback floor，将安全 projection 作为独立兼容层封版并验证部分回滚矩阵。

本轮只读 review 不擅自选择或实现。

## Q. Final Readiness Decision

### 通过项

- production baseline healthy；
- canonical invariants healthy；
- messages/appointments integrity healthy；
- ACL healthy；
- no migration/backfill/new collection required；
- no missing required index；
- production/local deploy matrix clear；
- staging diagnostic production response/viewer 双 gate safe；
- normal-use manual smoke and automated regression PASS；
- rare safe failure formally documented；
- no data corruption evidence。

### Blocker

`ROLLBACK_PROJECTION_PRIVACY_UNSAFE`：完整回滚到 Phase 24 会重新暴露已 recalled 的原正文/媒体，并恢复用户已 delete-for-me/hide 的内容。根据 133.md 第 22/24 节，这是重大 blocker。

## Final Decision

```text
NOT READY FOR PRODUCTION AUTHORIZATION
```

在 rollback projection compatibility 完成修复或得到明确安全底座方案、回归和复审之前：不部署 production，不 commit/push/tag，等待项目负责人下一步指令。
