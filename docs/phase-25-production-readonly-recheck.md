# Phase 25 Final Production Read-Only Recheck

复查日期：2026-08-25（Asia/Shanghai）
生产快照完成时间：2026-08-25 16:44:01（UTC+8）
目标：`[ENV] PRODUCTION` / `cloud1***6d8e`
性质：严格只读；未部署、未调用生产云函数、未写数据库、未修改环境变量/ACL/索引/集合/存储，未 migration/backfill，未 commit/push/tag
最终结论：**READY FOR PRODUCTION AUTHORIZATION**

## A. Executive Summary

本轮重新读取了 production 实际状态，没有复用上次报告的计数。五个集合的 metadata count 与逐页 QUERY 扫描数完全一致；canonical conversation、message、appointment/system、latest-summary 可验证项和三类敏感集合 ACL 均无异常；四个相关云函数均为 Active/Available，production 仍运行 Phase 24 source。

上一轮唯一重大 blocker `ROLLBACK_PROJECTION_PRIVACY_UNSAFE` 已由 hash-sealed 的 `phase25-message-query-projection-floor-v1`、deployment guard 与 partial rollback suite 关闭。本轮再次证明 approved query 被接受，Phase 24/unknown query 在 lifecycle data present 时被拒绝，break-glass 不能降级。

Production 当前 Phase 25 lifecycle state 为 `absent`：recalled message、delete-for-me message、hidden conversation 均为 0。上线仍必须先部署 minimum-safe `messageQuery`，验证远端 hash/status 后，才允许任何 writer 或客户端暴露 lifecycle mutation。

## B. Safety Boundary

本轮只执行：

- Git、本地 source/hash、deployment tooling 与测试检查；
- production `DescribeTables`、`DescribeSafeRule`、`DescribeTable` 和函数 detail/source 读取；
- production 数据库 `QUERY`，结构字段最小投影；
- aggregate lifecycle-state 计数，不导出正文、fileID、坐标、OPENID 或完整内部 ID。

审计器 `scripts/audit-phase-25-production-readonly.js` 的数据库命令类型封闭为 `QUERY`，没有 function invoke、deploy、数据库 write、事务或 maintenance 路径。本轮没有 production/staging 写入或部署。

## C. Git / Local Baseline

| 项目 | 实际结果 |
| --- | --- |
| branch | `main` |
| HEAD | `7131e58a72dfe2a90342e8a23554c6e94aeabb6c` |
| origin/main（远端只读核验） | `7131e58a72dfe2a90342e8a23554c6e94aeabb6c` |
| ahead / behind | `0 / 0` |
| `phase-24-complete^{}` | `7131e58a72dfe2a90342e8a23554c6e94aeabb6c` |
| staged | 0 |
| modified tracked | 15 |
| untracked porcelain entries | 20（含本报告；目录按一个 entry） |

Phase 24 baseline 未漂移。Phase 25 仍是未提交 local candidate，符合本轮禁止 commit/push/tag 的约束。Minimum-safe query 通过精确 source SHA-256 seal，不依赖未生成的 Git commit；负责人后续封版若产生任何源码变化，必须更新 artifact hash 并重跑全部 gate。

## D. Production Baseline

| Collection | metadata count | QUERY scanned | 结果 |
| --- | ---: | ---: | --- |
| users | 8 | 8 | MATCH |
| products | 72 | 72 | MATCH |
| conversations | 26 | 26 | MATCH |
| messages | 156 | 156 | MATCH |
| appointments | 22 | 22 | MATCH |

函数基线：`messageAction`、`messageQuery`、`appointmentAction`、`appointmentQuery` 均为 Active / Available、Nodejs18.15、`index.main`、timeout 10、memory 256、dependency install TRUE。四者 production source 均与 Phase 24 commit 一致。

## E. Canonical / Message / Appointment Integrity

Conversation：

- active canonical：6；merged aliases：20；
- invalid/unknown status：0；
- duplicate active/all `participantPairKey`：0 / 0；
- missing `participantPairKey`：0；
- malformed canonical/alias：0 / 0；
- dangling `mergedInto`/canonical alias：0。

Message：

- total / unique message id：156 / 156；
- orphan、missing/non-canonical conversation：0 / 0 / 0；
- sender-not-participant：0；invalid type：0；
- malformed recall/delete state：0 / 0；
- system messages：58；missing appointment reference：0；conversation mismatch：0。

Appointment：

- total：22；missing/non-canonical conversation：0 / 0；
- participant mismatch：0；product missing：0。

6 个 active conversation 当前均没有 optional `lastMessageId`，符合 Phase 24 数据形态。因无 `lastMessageId`，latest-summary 的 message missing/mismatch、type/time、last-sender 异常均为 0；unread 精确历史仍不能仅靠只读快照完全证明，但 canonical/unread 既有自动回归继续通过，没有新增异常证据。

## F. ACL / Diagnostic Safety

| Collection | production ACL |
| --- | --- |
| messages | `ADMINONLY` |
| conversations | `ADMINONLY` |
| appointments | `ADMINONLY` |

客户端没有新增这些集合的直读路径，继续通过云函数安全 DTO 访问。

Production `messageAction` 与 `messageQuery` 的 `JICHU_ENVIRONMENT_ROLE` 均为 `(unset)`。本轮专项回归显式验证：

- server role 为 unset / production / unknown 时 diagnostic response 均关闭；
- staging/development 才允许封闭白名单 diagnostic；
- production/unknown client 拒绝 diagnostic；
- production `formatAttemptDiagnostic` 返回空串，因此“发送诊断（测试环境）”viewer 不会显示。

Diagnostic 回归为 PASS（69 assertions），production 继续双重 fail closed。

## G. Minimum Safe Rollback Floor

| 属性 | 值 |
| --- | --- |
| baseline | `phase25-message-query-projection-floor-v1` |
| required function | `cloudfunctions/messageQuery` |
| approved local SHA-256 | `c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30` |
| forbidden Phase 24 SHA-256 | `a758d68da1d811d692a6bf0330580b3ecf155e215bb91b71a7a91cd6339b0313` |
| artifact source | `scripts/phase-25-minimum-safe-rollback-core.js` |
| executable guard | `scripts/guard-phase-25-minimum-safe-rollback.js` |

本轮重新计算本地 `messageQuery` hash，仍与 approved hash 完全一致，required projection markers 齐全。服务端保证 recalled neutral projection、viewer-scoped delete filtering、activity-bound hide filtering及 system/appointment projection；Phase 24-like client 无法恢复服务端未返回的 payload。

## H. Deployment Guard

Guard 与 dedicated suite 重新证明：

- approved minimum-safe hash：`MINIMUM_SAFE_PROJECTION_APPROVED`；
- exact Phase 24 hash + lifecycle present：`FORBIDDEN_PHASE24_MESSAGE_QUERY_ROLLBACK`；
- unknown/unsealed hash + lifecycle present：`UNSEALED_MESSAGE_QUERY_ROLLBACK_TARGET`；
- lifecycle present 即使给出 break-glass/owner authorization 也不能部署 Phase 24；
- pre-lifecycle break-glass 仅在 state=`absent` 且项目负责人显式授权时成立；
- `deploy-phase-24-message-query.js`、`deploy-phase-24-pair-conversations.js` 均在 deploy 之前执行 floor guard，正常部署入口不暴露 break-glass。

Operational risk：拥有生产权限的人理论上仍可通过旧 checkout、直接 cloud CLI 或控制台覆盖绕过本地 guard。本轮不能也不需要修改云平台权限。强制操作规程是：生产 `messageQuery` 只允许从当前已审计 checkout 使用带 guard 的批准流程发布；每次发布前后记录 local/remote hash；禁止控制台覆盖、旧 checkout 与裸 `cloudbase fn deploy`。任何绕开行为按 production change-control violation 处理。

## I. Lifecycle State Transition Model

本轮审计器增加只读 lifecycle aggregate，并由自动回归验证 fail-closed 分类。Production 当前结果：

| 状态 | 计数 |
| --- | ---: |
| recalled messages | 0 |
| delete-for-me messages | 0 |
| hidden conversations | 0 |
| combined lifecycle records | 0 |
| classification | `absent` / `pre-first-lifecycle-mutation` |

切换点定义如下：

- State 0/1 且 Phase 25 writer/client 尚未暴露时，实时只读查询为 absent，属于 first mutation 之前；
- 首次成功写入 `recalled/recalledAt`、任一 participant delete marker 或任一 participant hide snapshot 时，永久进入 minimum-safe floor；
- 为避免 hide 后被新 activity 清空而丢失历史证据，正式 change log 必须记录 floor lock；任何历史不确定性一律按 `present` 处理；
- 保守操作上，从 Phase 25 writer/client lifecycle capability 可达开始就保留 minimum-safe query，不以之后字段再次变空作为降级依据。

因此上线前当前可理论完整回滚；一旦 lifecycle capability 上线并产生或不能排除 mutation，Phase 24 `messageQuery` 永久成为 forbidden target。

## J. Local vs Production Deploy Matrix

| Function | production SHA-256 | local Phase 25 SHA-256 | changed | deploy | rollout role | rollback constraint |
| --- | --- | --- | --- | --- | --- | --- |
| messageQuery | `a758d68d…0313` | `c4472a12…f30` | 是 | **MUST** | minimum-safe privacy floor，第一步 | 仅在 writer/client 未暴露且 lifecycle absent 的 owner break-glass 下可回 Phase 24；之后永久禁止 |
| messageAction | `c900008f…c0f6` | `345fbe2a…fa47` | 是 | 是 | Phase 25 lifecycle writer | 可回滚 writer，但 mutation 后必须保留 safe query |
| appointmentAction | `b95fb961…5f91` | `8959c9a8…2f83` | 是 | 是 | system activity / hide reset writer | 可回滚 action，但 mutation 后必须保留 safe query |
| appointmentQuery | `1747a033…388f` | `1747a033…388f` | 否 | 否 | unchanged reader | 无 Phase 25 deploy |

真实 full hash 已由审计 JSON 核验；表中为便于阅读的首尾缩写。没有 dependency/runtime/config、migration、index 或 collection deploy 项。

## K. Rollout Order

最安全顺序仍为：

1. 部署 minimum-safe `messageQuery`；
2. 立即只读核验 remote source hash 精确等于 `c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30`，状态 Active/Available，production diagnostic role 仍 unset；
3. 部署 `messageAction`；
4. 核验其 remote hash/status/role；
5. 部署 `appointmentAction`；
6. 核验其 remote hash/status；
7. 发布 production-target client。

硬 gate：步骤 1-2 未通过时，禁止执行步骤 3-7。任何 Phase 25 writer 能写 lifecycle state 之前，production 必须已经运行并验证 minimum-safe query。`appointmentQuery` 不部署。

## L. Rollback Matrix

| Rollout state | 判定与允许动作 | 禁止动作 |
| --- | --- | --- |
| State 0：未部署 Phase 25 | 当前 production Phase 24；可保持现状 | 无授权不得部署 |
| State 1：只部署 safe query | writer/client 未暴露且实时只读 state=absent 时，可保留 safe query；如确需完整回滚，必须使用项目负责人 pre-lifecycle break-glass 并再次核验 absent | 未核验 absent 或 unknown 时回 Phase 24 query |
| State 2：writer/client 已上线但 mutation 未确认 | 先停止/回滚 writer/client exposure，再做只读 lifecycle check；正常策略保留 safe query；任何 race、历史或状态不确定性按 present | 先回 query；仅凭一次字段为空忽略历史 transition |
| State 3：任一 lifecycle mutation 已存在/发生/无法排除 | 可回滚 writer、client、appointmentAction；保留 minimum-safe query；roll-forward repair | Phase 24/unknown `messageQuery`，包括 break-glass |

State 3 的 floor 是永久 change-control 状态。数据字段后来被新 activity 清空不解除该状态。

## M. Residual Risk

保留既有记录：

> Low-frequency CloudBase/database update-path safe failure observed under intentionally synchronized hide/send stress. Transaction rollback and client-visible failure preserve consistency; no evidence of partial write or canonical/unread corruption.

本轮 production integrity 重查仍为 0 anomaly，899-assertion race suite 继续通过，没有新增证据改变分类。该问题仍是 **availability/transient safe failure**，不是 privacy 或 data-corruption blocker；失败时事务回滚并向客户端安全暴露 availability failure。

Operational bypass risk 由批准工具、exact hash 复核和 change-control procedure 控制；它不改变代码 guard 的 PASS，但必须作为生产操作硬约束。

## N. Verification Evidence

| 验证 | 本轮结果 |
| --- | --- |
| production read-only audit | PASS；fresh counts/QUERY，readiness blockers 0 |
| production lifecycle state | PASS；absent，0 / 0 / 0 |
| Phase 25 lifecycle | PASS；8 gates / 57 assertions |
| hide/send race | PASS；899 assertions/scenarios |
| diagnostic production gate | PASS；69 assertions |
| rollback compatibility | PASS；11 gates / 35 assertions |
| rollback floor guard | PASS；approved hash accepted |
| Phase 24 pair compatibility | PASS；52 assertions/scenarios |
| project verify | PASS；81 checks |
| Git baseline / tag | PASS；Phase 24 commit unchanged，ahead/behind 0/0 |
| `git diff --check` | PASS |

Rollback suite 覆盖 recalled text/image/voice/location/product、双方 delete-for-me、双方 hide、新 activity restore、system/appointment、forwarded copy、Phase 24-like client、A-D partial rollback matrix、Phase 24/unknown rejection、break-glass 和 lifecycle transition classification。

## O. Final Production Rollout Candidate

本轮只生成以下候选计划，不执行：

**PRE-DEPLOY**

1. 从批准的当前 checkout 重跑全部 verification 与 `git diff --check`；
2. production fresh read-only snapshot；
3. 确认 lifecycle state=`absent`，三类计数仍为 0；
4. 确认 ACL=ADMINONLY、四函数状态正常、target/app id 与授权单一致；
5. 记录 approved local hashes，禁止控制台/旧 checkout/裸 CLI。

**DEPLOY**

1. minimum-safe `messageQuery`；
2. verify exact hash/status/diagnostic role；
3. `messageAction`；
4. verify exact hash/status/diagnostic role；
5. `appointmentAction`；
6. verify exact hash/status；
7. production-target client。

**POST-DEPLOY**

1. normal-use smoke；
2. privacy lifecycle smoke（recall/delete/hide/new activity）；
3. ACL denial smoke；
4. integrity delta audit（counts、canonical、message、appointment/system、lifecycle transition）；
5. 在 change log 锁定 minimum-safe floor；任何失败按 State 1/2/3 matrix 回滚。

## P. Final Readiness Decision

本轮所有授权 gate 均通过：production baseline、canonical/message/appointment integrity、ACL、diagnostic fail-closed、hash-sealed safe projection、guard、partial rollback、deploy matrix、query-before-writer 顺序、rollback procedure、无 migration/index blocker、全套自动回归以及 residual safe-failure 分类均已确认；没有未解决的 privacy 或 data-corruption blocker。

最终状态：

```text
READY FOR PRODUCTION AUTHORIZATION
```

该结论表示技术与操作 gate 已达到可由项目负责人授权的状态，不代表本轮执行了授权或部署。仍须等待负责人明确 production authorization；未部署 production，未 commit/push/tag。
