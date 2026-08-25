# Phase 25 staging attempt-level 诊断交付报告

日期：2026-08-21

## 范围

本轮只增加 staging/development 的失败可观测性。未改变事务读写、冲突重试次数、hide 活动快照、未读数、会话摘要、确定性消息 ID 或 delivery reconciliation 决策。

## 实现

- `messageAction` 对每次 application attempt 记录：attempt 序号、白名单错误码、是否可重试、事务是否创建、是否开始 commit、commit outcome，以及可选的 `messageExistedBeforeAttempt` / `snapshotChanged`。
- commit outcome 仅使用 `committed`、`conflict`、`failed_non_conflict`、`outcome_unknown`、`rolled_back`、`unknown`，无法证明时不猜测。
- 最终 staging/development 失败响应附带最小 diagnostic；没有显式 `JICHU_ENVIRONMENT_ROLE=staging|development` 时默认关闭。
- `messageQuery` 对 delivery reconciliation 返回 `found` / `not_found` / `query_failed` 的环境受控诊断。
- 客户端再次按私有环境角色校验，并重建字段白名单；最终失败时弹出可查看、可复制的 JSON。production 客户端不接受或展示 diagnostic。
- diagnostic 不包含 OPENID、真实会话/消息/client message ID、正文、媒体 fileID、资料、地址、坐标、商品快照、原始错误或 stack。

## 自动验证

- attempt diagnostic 专项：45 assertions，覆盖 conflict→retry→success、三次冲突耗尽、非冲突数据库失败、commit outcome unknown、reconciliation found/not_found/query_failed、staging/production 门控和敏感字段扫描。
- hide/send race：899 assertions，通过。
- Phase 25 lifecycle：8 gates / 57 assertions，通过。
- 全项目：81 checks，通过。
- `git diff --check`：通过。

## Staging 部署与预览

- 仅部署 `messageAction`、`messageQuery`；两者均为 Active / Available，远端源码 SHA-256 与本地一致。
- runtime、handler、timeout、memory 未改变；除新增非敏感 staging 角色标记外，其他环境变量未改变。
- 未写业务数据，未改 ACL、集合、索引或 maintenance；未操作 production。
- 新 staging preview：本机临时目录中的 `phase25-attempt-diagnostics-staging-preview.png`（未纳入 Git）。
- preview 主包：526,140 bytes（513.8 KB）。

## 真人复测

继续执行“A 停留在删除确认框，B 几乎同时发送”的真实双账号复现。若再次出现红色失败气泡，弹窗中点击“复制”，返回完整 JSON diagnostic；其中应包含 traceId、attempts 和 reconciliation outcome。

当前结论：`READY FOR EVIDENCE-CAPTURE RETEST`
