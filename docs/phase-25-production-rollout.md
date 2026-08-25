# Phase 25 Production Rollout

最后更新：2026-08-25（Asia/Shanghai）
当前状态：**PHASE 25 PRODUCTION ROLLOUT PASS — READY FOR GIT FINAL SEAL**

## A. Authorization

项目负责人通过 `136.md` 明确授权：

```text
AUTHORIZE PHASE 25 PRODUCTION ROLLOUT
```

本轮只按批准顺序部署 `messageQuery`、`messageAction`、`appointmentAction`；`appointmentQuery` 未部署。未修改 ACL、索引、集合、maintenance、存储、业务数据或函数环境变量。

## B. Pre-Deploy Snapshot

2026-08-25 fresh production read-only audit：

```text
environment: [ENV] PRODUCTION
cloud target: cloud1***6d8e
project AppID: wx5e54***418c
users=8 / products=72 / conversations=26 / messages=156 / appointments=22
active canonical=6 / merged aliases=20
duplicate pair / dangling alias / orphan message / sender mismatch / appointment mismatch=0
messages / conversations / appointments ACL=ADMINONLY
lifecycle: recalled=0 / delete-for-me=0 / hidden=0 / state=absent
```

四个相关函数部署前均为 Active/Available、Nodejs18.15、`index.main`、10 秒、256 MB、dependency install TRUE，production diagnostic role 为 unset。Git 基线为 `main/origin/main/phase-24-complete = 7131e58a72dfe2a90342e8a23554c6e94aeabb6c`，ahead/behind 为 0/0；Phase 25 保持未提交 candidate，部署前未 commit。

## C. Source Freeze / Approved Hashes

部署前、私有目标切换后和部署工具生成后均重新计算三个业务源码 SHA-256，结果始终精确匹配批准值：

```text
messageQuery      c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30
messageAction     345fbe2ab6016ca24f3adfb06189f8c2b0d0e4f05d11d30982c5852c11d5fa47
appointmentAction 8959c9a8953071f9819b18bd47b655aa780ad8344e2ec5f4e0c544c9150e2f83
```

Source Freeze 期间未修改业务源码、依赖或 lockfile。新增的 production 单函数 rollout 工具只允许两个 writer、锁定批准 hash、强制 safe query 在线、保持环境变量指纹，并逐项下载远端包核验。

Pre-deploy 回归全部通过：Phase 25 lifecycle 57、hide/send race 899、diagnostic 69、rollback 35、Phase 24 pair 52、Phase 24 compatibility 88、project verify 81、minimum-safe guard 和 `git diff --check`。

## D. messageQuery Safe-Floor Deployment

`messageQuery` 作为唯一目标首先部署。部署后：

```text
Active / Available
Nodejs18.15 / index.main / 10s / 256MB
dependency install TRUE
remote source SHA-256 = c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30
package + lock MATCH
wx-server-sdk 4.0.2 / ws 8.21.3 loadable
environment fingerprint unchanged
diagnostic role unset
```

minimum-safe guard 返回 `MINIMUM_SAFE_PROJECTION_APPROVED`。State 1 checkpoint 通过后才允许 writer 部署。

## E. messageAction Deployment

`messageAction` 作为唯一目标部署。部署前后 safe query 均保持批准 hash；部署后：

```text
Active / Available
Nodejs18.15 / index.main / 10s / 256MB
dependency install TRUE
remote source SHA-256 = 345fbe2ab6016ca24f3adfb06189f8c2b0d0e4f05d11d30982c5852c11d5fa47
package + lock MATCH
wx-server-sdk 4.0.2 / ws 8.21.3 loadable
environment fingerprint unchanged
diagnostic role unset
```

## F. appointmentAction Deployment

`appointmentAction` 在 `messageAction` 完整核验后作为唯一目标部署。部署后：

```text
Active / Available
Nodejs18.15 / index.main / 10s / 256MB
dependency install TRUE
remote source SHA-256 = 8959c9a8953071f9819b18bd47b655aa780ad8344e2ec5f4e0c544c9150e2f83
package + lock MATCH
wx-server-sdk 4.0.2 / ws 8.21.3 loadable
environment fingerprint unchanged
diagnostic role unset
```

`appointmentQuery` 未部署，继续保持 Phase 24 hash：

```text
1747a0333a75395c9458778318495b8c1585866ab1f50021ab889c21e58d388f
```

## G. Production Client Target

本机私有活动目标已从 staging 切换并经统一 preflight 证明为：

```text
[ENV] PRODUCTION
cloud target: cloud1***6d8e
project AppID: wx5e54***418c
activeTargetMatches=true
targetsDistinct=true
```

微信开发者工具 production preview 成功，主包 526716 Byte / 514.4 KB。二维码与 info 输出只保存在被忽略的 `tmp/`，不进入 Git。该 preview 不是体验版上传、提交审核或正式发布。

## H. Production Smoke

项目负责人通过 `137.md` 报告：双向文本、未读/摘要、hide/new-activity restore、delete-for-me、两分钟内 recall、text forward、appointment system activity 和 production diagnostic 不显示均为 PASS。第三真实账号当前不可用，因此非 participant 人工越权项明确为 `NOT TESTED`，没有伪记 PASS。

第 8 项不是 `136.md` 的硬阻塞：已有 staging 第三账号真实越权证据，production 继续由 ADMINONLY ACL、participant 服务端校验和自动攻击回归覆盖；该项作为 residual/manual coverage gap 接受。

首次 post-smoke 审计未发现 delete marker，因此没有把即时 UI 消失当作持久化证据，也没有提前封版。项目负责人随后补做最近普通消息 delete-for-me：A 冷启动/刷新后仍不可见，B 冷启动/刷新后仍可见。fresh production audit 随即确认 `deleteForMeMessages=2`、`hiddenConversations=1`、`recalledMessages=1`，人工语义与服务端持久字段一致，证据缺口正式关闭。

## I. Lifecycle Floor Lock

production Phase 25 writer 已投入可达状态，change-control 立即记录：

```text
MINIMUM SAFE QUERY FLOOR LOCKED
messageQuery >= phase25-message-query-projection-floor-v1
Phase24 / unknown messageQuery = FORBIDDEN ROLLBACK TARGET
```

该锁定不依赖当前 lifecycle 字段是否为空，也不会因 hide marker 被新 activity 清空而解除。

## J. Integrity Delta Audit

后端三函数部署完成后的 fresh read-only audit：

```text
users=8 / products=72 / conversations=26 / messages=156 / appointments=22
lifecycle recalled/delete/hide=0/0/0
ACL=ADMINONLY / readiness blockers=0
三个 Phase 25 目标 hash MATCH
appointmentQuery Phase 24 hash unchanged
```

部署本身没有业务数据 delta。`137.md` 人工 smoke 后 fresh audit 为：

```text
users=8 (Δ0) / products=72 (Δ0) / conversations=26 (Δ0)
messages=166 (Δ+10) / appointments=23 (Δ+1)
system messages=59 (Δ+1)
active canonical=6 / merged aliases=20
duplicate/dangling/orphan/sender/type/appointment-system anomalies=0
recalled=1 / delete-for-me=0 / hidden current markers=0
ACL=ADMINONLY / readiness blockers=0
三个 Phase 25 目标 hash MATCH / appointmentQuery unchanged
```

`messages +10 / appointments +1 / system +1` 与双向发送、恢复消息、撤回、转发和预约活动 smoke 的合法增长方向一致，结构与关系异常为 0。lifecycle state 已为 `present`，safe floor 永久锁定。

delete persistence recheck 后最终 lifecycle：

```text
recalled messages=1
delete-for-me messages=2
hidden conversations/current lifecycle markers=1
malformed recall/delete state=0
state=present
transition=minimum-safe-messageQuery-floor-permanently-enforced
```

五集合计数仍为 8 / 72 / 26 / 166 / 23，没有因复核新增消息或预约；readiness blockers 继续为 0。

## K. Residual Risk

继续接受并保留：极窄同步 hide/send 压力下可能出现低频 `conversation_update_write` availability/transient safe failure。已知证据为 transaction 未 commit、deterministic message absent、reconciliation not_found；没有 partial message/unread/summary/canonical write。不得扩大 INTERNAL_ERROR retry 或无边界增加重试。

## L. Rollback State

当前已超过 State 1，writer 已部署。允许按故障范围回滚 `messageAction`、`appointmentAction` 或客户端，但必须保留 minimum-safe `messageQuery`。Phase 24/unknown query 永久禁止作为 production rollback target。

## M. Git Final Seal

状态：封存完成。双账号人工 smoke、delete-for-me 冷启动复核、post-smoke lifecycle 与 integrity delta audit 均已通过；Phase 24 配对会话 52 项、Phase 24 首轮 88 项及 Phase 25 全量验证均通过。最终提交使用 `feat: complete phase 25 message lifecycle rollout`，`origin/main` 与本地 `main` 同步，annotated tag `phase-25-complete` 指向该正式 Phase 25 提交。精确提交 hash、文件统计与远端标签核验记录在最终交接输出及被忽略的总交接文档中。

选择性暂存只包含 Phase 25 业务代码、页面、验证/部署工具和证据报告；`00-项目总交接文档.md`、`136.md`、`137.md`、private cloud 配置、production preview 二维码/info、凭据及 production 原始数据均未进入提交。

## N. Final Production Status

```text
PHASE 25 PRODUCTION ROLLOUT PASS
BACKEND PRODUCTION ROLLOUT PASS
PRODUCTION-TARGET PREVIEW AND MANUAL SMOKE PASS
MINIMUM SAFE QUERY FLOOR LOCKED
POST-SMOKE INTEGRITY AUDIT PASS
GIT FINAL SEAL COMPLETE
PHASE 25 COMPLETE
WECHAT OFFICIAL REVIEW / FORMAL RELEASE NOT CLAIMED
```
