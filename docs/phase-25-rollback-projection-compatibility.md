# Phase 25 Rollback Projection Compatibility

审计日期：2026-08-25（Asia/Shanghai）
审计范围：本地实现、自动回归与 staging 只读 hash 核验
安全边界：未部署 production，未写 production/staging 数据，未修改 ACL、索引、集合、环境变量或存储，未 commit / push / tag
结论：**Phase 25 Minimum Safe Rollback Floor 已建立并通过验证；可进入 production read-only recheck，不构成 production 上线授权。**

## A. Root Blocker

上一轮 `ROLLBACK_PROJECTION_PRIVACY_UNSAFE` 的根因是：Phase 25 以 additive optional fields 保存 recall、delete-for-me 和 hide-for-me 状态，但 Phase 24 `messageQuery` 不识别这些字段。若读取层完整回滚到 Phase 24，旧查询会重新投影已撤回的原正文/媒体、当前用户已删除的消息和当前用户已隐藏的旧会话。

本轮按“保留兼容 Phase 25 lifecycle states 的最小安全服务端 projection”关闭该 blocker。没有改为物理清空原数据，也没有扩大数据模型。

## B. Minimum Safe Projection Definition

正式 artifact：`MINIMUM_SAFE_ROLLBACK_BASELINE`

| 属性 | 值 |
| --- | --- |
| baseline id | `phase25-message-query-projection-floor-v1` |
| required function | `cloudfunctions/messageQuery` |
| approved source SHA-256 | `c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30` |
| source candidate | `PHASE25_UNCOMMITTED_CANDIDATE` |
| forbidden Phase 24 SHA-256 | `a758d68da1d811d692a6bf0330580b3ecf155e215bb91b71a7a91cd6339b0313` |
| compatible clients | Phase 24-like、Phase 25 |
| compatible `messageAction` | Phase 24、Phase 25 |
| compatible `appointmentAction` | Phase 24、Phase 25 |

真实 source/hash 映射与 allowlist 定义在 `scripts/phase-25-minimum-safe-rollback-core.js`。由于 134.md 明确禁止 commit/tag，本轮只能记录真实未提交 candidate；负责人后续封版时应把 `sourceCommit` 更新为最终 commit，并在任何源码变化后重新 seal hash 和重跑全套验证。

不可低于的运行时底座是服务端 `messageQuery`。`services/message-service.js`、`pages/chat` 与 `pages/messages` 的 Phase 25 版本提供更完整的字段标准化和交互体验，但不是保护 recall/delete/hide 读取隐私的最低条件。服务端必须在任何客户端渲染前删除不应返回的数据。

## C. Server-side Privacy Guarantee

Minimum-safe `messageQuery` 在服务端执行以下规则：

- `recalled === true` 时立即生成中性 DTO，只保留 `messageId`、`senderPublicUserId`、`isMine`、`type: recalled`、`recalled: true`、`createdAt`、`recalledAt`；不继续投影原 `content`、媒体 `fileID`、location 或 product payload。
- listMessages 根据已认证 viewer 对应的 participant slot 过滤 `deletedForParticipant{slot}At`，另一 participant 的结果不受影响。
- listConversations 根据当前 viewer 的 hide activity id/time snapshot 过滤旧会话；出现不同的新 activity snapshot 后会话恢复。
- system/appointment projection 继续保留合法引用，system recall 仍被 action 层禁止。

因此旧客户端拿不到原 payload；客户端“不要显示”不是安全边界。原始记录继续保存在数据库中不影响该保证，因为读取层不会把被保护字段投影给当前用户。

## D. Old Client Compatibility

专项测试使用 Phase 25 lifecycle fixtures 调用真实 `cloudfunctions/messageQuery.main`，再把返回值交给 Phase 24-like renderer，并同时覆盖当前 `MessageService` normalize 路径。

结果：旧客户端只能看到 neutral recalled item，无法从响应恢复 text、image、voice、location 或 product 原 payload；delete-for-me item 不在响应中；尚未发生新 activity 的 hidden conversation 不在响应中。旧客户端可能缺少 `forwarded` 标签或 Phase 25 交互能力，但这种表现降级不会扩大服务端返回的数据。

## E. Partial Rollback Matrix

| Case | messageQuery | messageAction | client | 结果 |
| --- | --- | --- | --- | --- |
| A | Phase 25（minimum-safe） | Phase 25 | Phase 25 | PASS：完整 Phase 25 行为 |
| B | minimum-safe | Phase 24 | Phase 24-like | PASS：读取隐私安全，旧交互 graceful degradation |
| C | minimum-safe | Phase 25 | Phase 24-like | PASS：旧客户端无法恢复 recall/delete/hide 内容 |
| D | minimum-safe | Phase 24 | Phase 25 | PASS：基本读取安全，写能力按旧 action 降级 |
| E | Phase 24 | 任意 | 任意；已存在 Phase 25 lifecycle data | **FORBIDDEN ROLLBACK TARGET** |

Case B-D 允许 action/client 层局部回滚，但不允许 projection 层低于本 baseline。只要 production 已经存在 Phase 25 recalled/delete/hide 数据，Case E 永久不属于可接受回滚目标。

## F. Message Type Coverage

| 类型 | recalled projection | 旧客户端可恢复原 payload | 结果 |
| --- | --- | --- | --- |
| text | 不返回原 `content` | 否 | PASS |
| image | 不返回原 fileID/payload | 否 | PASS |
| voice | 不返回原 fileID/payload | 否 | PASS |
| location | 不返回坐标/位置 payload | 否 | PASS |
| product | 不返回原 product payload | 否 | PASS |

Forwarded copy 按当前产品设计是独立、合法的新 message。source 后续 recall 时，source 返回 neutral recalled projection；已创建的 forwarded copy 继续可见。本轮没有擅自改变该语义，且测试确认不会经 recalled source 响应泄露原 payload。

## G. Appointment/System Compatibility

Minimum-safe projection 未改变 system message 的合法列表形态和 `appointmentId` 引用。现有 appointment system fixture 能正常查询；Phase 25 action 继续禁止 system recall。Phase 24/Phase 25 `appointmentAction` 均可与 minimum-safe query 配合：Phase 25 writer 会显式维护 `lastMessageId`/清理 hide snapshot，Phase 24 writer 的新 `lastMessageAt` 也会使旧 hide snapshot 失配并恢复会话，只是缺少 Phase 25 的显式字段维护。

## H. Deployment Guard

`scripts/guard-phase-25-minimum-safe-rollback.js` 和 core allowlist 提供可执行 deployment guard：

- production lifecycle state 为 `present` 时，只接受已 seal 的 exact source hash 且要求关键 projection markers 存在；
- exact Phase 24 hash 被拒绝；unknown/unsealed hash 被拒绝；
- 已存在 lifecycle data 时，即使传入 break-glass 也不能部署 Phase 24；
- 特殊 break-glass 只适用于明确证明 lifecycle data 为 `absent` 的 pre-lifecycle 环境，并要求项目负责人授权短语；
- 现有 `deploy-phase-24-message-query.js` 与 `deploy-phase-24-pair-conversations.js` 在任何 deploy 调用前执行该 guard，并固定 production lifecycle state 为 `present`，正常部署入口不暴露 break-glass。

这是源码与批准部署工具层的 guard，不是云平台的不可绕过策略；生产操作规程必须只使用带 guard 的封版工具，禁止通过旧 checkout 或云控制台直接覆盖 `messageQuery`。专项测试验证 guard 在 deploy 之前执行且正常入口不存在绕过参数。

## I. Emergency Rollback Procedure

1. 停止或回滚产生故障的 Phase 25 lifecycle writer；保留现场并停止扩大影响。
2. 始终保留 `messageQuery` 在 `phase25-message-query-projection-floor-v1` 或经同等/更强验证的新 baseline。
3. 必要时可回滚小程序客户端、`messageAction` 或 `appointmentAction` 到 Phase 24；接受功能/标签降级，但不得回滚安全 query。
4. 用 guarded tooling 核验 target hash；如有任何 lifecycle data，拒绝 Phase 24/unknown query target。
5. 修复后 roll-forward，并重跑 lifecycle、race、rollback、diagnostic 与 project verification。

硬性规则：**只要 production 已经存在 Phase 25 recalled/delete/hide 数据，永远不得把 `messageQuery` 回滚到 Phase 24。** Pre-lifecycle break-glass 不适用于该生产状态。

## J. Automated Verification

| 验证 | 结果 |
| --- | --- |
| dedicated rollback compatibility | PASS：10 gates / 30 assertions |
| Phase 25 lifecycle | PASS：8 gates / 57 assertions |
| hide/send race | PASS：899 assertions/scenarios |
| production diagnostic gate | PASS：61 assertions |
| project verify | PASS：81 checks |
| Phase 24 pair-conversation compatibility | PASS：52 assertions/scenarios |
| Phase 24 first-round compatibility | PASS：88 checks |
| current baseline guard | PASS：`MINIMUM_SAFE_PROJECTION_APPROVED` |

`package.json` 的 `phase-25-message-lifecycle:verify` 已包含 dedicated rollback verification；另提供 `phase-25-rollback-floor:guard` 与 `phase-25-rollback-floor:verify` 独立入口。测试覆盖 134.md 列出的 recalled 五类 payload、双方 delete-for-me、双方 hide、新 activity 恢复、system message、旧客户端、partial rollback matrix 和 deployment guard。

Staging 只读 dry-run 核验远端 `messageQuery` source hash 与本地 approved hash 同为 `c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30`，函数状态 Available、角色 staging。因已是同一安全 baseline，本轮没有重复部署 staging。

## K. Production Impact

本轮没有访问或修改 production 业务数据，也没有部署 production。没有 migration、backfill、index、collection、dependency 或 runtime 变更需求。实现只新增本地 guard/verification/documentation，并把 guard 接入现有部署入口。

Staging/development diagnostic 行为保持不变；production diagnostic 仍由 server/client 双重 gate fail closed。本轮未使 production diagnostic viewer 生效。

## L. Final Readiness

以下 gate 全部满足：

- recalled 原内容无法被旧客户端或部分回滚重新暴露；
- delete-for-me 内容由服务端按 viewer 过滤；
- hidden conversation 在新 activity 前由服务端过滤；
- minimum-safe query baseline 和 forbidden Phase 24 target 已映射到真实 source hash；
- deployment guard 及 partial rollback matrix 已通过自动测试；
- system/appointment/forwarded compatibility 通过；
- 不需要 migration/index/collection change；
- production diagnostic 继续 fail closed；
- production 未部署、未写入。

因此上一轮 `ROLLBACK_PROJECTION_PRIVACY_UNSAFE` 已在本地/staging 验证层关闭，状态为：**READY FOR PRODUCTION READ-ONLY RECHECK**。该状态仅授权下一次 production read-only review，明确不是 `READY FOR PRODUCTION AUTHORIZATION`。
