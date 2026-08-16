# Phase 24：按用户对唯一的聊天会话

## 当前结论

本专项已完成本地实现、生产/预发布只读审计、迁移 dry-run、迁移/回滚/checkpoint/resume/hash/maintenance 工具加固、staging 真实迁移/回滚/故障注入、production migration、4 个目标索引、4 个正式业务函数部署、自动 smoke，以及双账号和第三账号真机人工闭环。最终 production 只读核验通过，maintenance 保持 OFF；加固证据见 `docs/phase-24-pair-migration-hardening.md`。

产品语义已经改为：

```text
聊天对象 = 人
商品 = 当前/最近一次聊天上下文
```

同一无序 `publicUserId` 用户对使用一个确定性会话 ID；从不同商品、不同方向进入均复用同一会话，只更新顶部商品上下文。历史消息、未读、参与者关系和预约商品语义保留。

## 只读数据审计（2026-08-13）

### Production

| 项目 | 结果 |
| --- | ---: |
| conversations | 20 |
| messages | 147 |
| appointments | 20 |
| 逻辑用户对 | 6 |
| 存在重复会话的用户对 | 3 |
| 重复用户对覆盖的 conversations | 17 |
| 重复用户对覆盖的 messages | 135 |
| 重复用户对覆盖的 appointments | 19 |
| 孤儿消息 / 预约 | 0 / 0 |
| 参与者、卖家、发送者或预约关系错配 | 0 |
| 合并后消息幂等唯一键冲突 | 0 |

6 个用户对的真正最新消息均可确定；旧 conversation 的摘要/时间不能直接作为合并结果，迁移器会从真实最新 message 重算。147 条消息都能从显式字段或来源 conversation 推断商品上下文。

生产 dry-run 结果：创建 6 条 canonical conversation；147 条 message、20 条 appointment 改指 canonical conversation；20 条旧 conversation 归档为 `status=merged` 并保留 `mergedInto`，不物理删除。

### Staging

`conversations/messages/appointments` 均为 0；迁移 dry-run 是安全空操作。后续需要准备两个真实测试账号和至少同一卖家的两个商品，才能执行人工闭环。

## 身份与上下文模型

确定性身份：

```text
sortedUserIds = sort(participantAUserId, participantBUserId)
digest = SHA256(sortedUserIds[0] + ":" + sortedUserIds[1])
conversation._id = "c_" + digest
participantPairKey = "pp_" + digest
```

canonical conversation 使用：

- `status=active`、`schemaVersion=2`；
- `participantA/BUserId` 按 public user ID 排序；
- `participantA/BOpenid` 仍只保存在服务端；
- `lastProductId/lastProductSnapshot` 表示当前聊天头部上下文；
- `productId/productSnapshot` 暂时镜像当前上下文，兼容旧客户端；
- `participantPairKey` 由 unique 索引提供服务端唯一性；迁移会先为 canonical 与 archived alias 全部写入互不冲突的键；
- 每条新消息写入 `contextProductId`。

旧 conversation 只作兼容别名。`legacyProductId` 保存原商品 ID；`productId` 改成每条记录唯一的 `merged_<legacy conversation digest>`，避免迁移期间与旧的商品参与者唯一索引冲突，该占位值不进入任何业务响应：

```text
status = merged
mergedInto = canonical conversationId
```

查询、发消息、标已读和预约入口都先解析别名。归档记录不物理删除；私有迁移清单保存完整迁移前快照、逐条映射和迁移后证据。

## 预约边界

预约继续是商品级业务，不因聊天去商品化而丢失语义：

- 创建和查询都显式传 `conversationId + productId`；
- 服务端确认商品卖家确实是会话参与者；
- 学校、卖家、参与者、状态机和 ACL 规则不放宽；
- `appointments.productId` 原样保留，只把 `conversationId` 改为 canonical；
- 系统消息同时保存 `productId/contextProductId`；
- 同一聊天切换顶部商品时，不会把其他商品预约误显示为当前商品预约。

## 迁移和发布工具

默认只读：

```powershell
node scripts/migrate-phase-24-pair-conversations.js --env production
node scripts/migrate-phase-24-pair-conversations.js --env staging
node scripts/deploy-phase-24-pair-conversations.js --env production
```

迁移私有清单位于被忽略的 `tmp/`，包含真实 ID，不得提交。任何写入都需要：

- 显式目标环境；
- masked target 二次确认；
- `--apply` 或 `--deploy`；
- 项目负责人授权口令；
- 维护窗口；
- 迁移后逐条验证。

生产安全顺序调整为：

```text
写入 maintenance=ON 配置（此时旧函数尚未冻结）
→ 只部署 maintenance gate 四函数
→ 逐项确认四接口均返回 SERVICE_MAINTENANCE
→ 获取最终完整快照并执行 dry-run
→ 执行迁移并持续保存 checkpoint
→ 创建 3 个 conversations 索引和 1 个 appointments 索引
→ 函数/索引/数据自动与双账号人工验证
→ maintenance=OFF
```

以上顺序是已经执行完成的 production runbook。不得在后续环境中跳过 maintenance、迁移验证或索引 Ready 门禁，也不得先单独部署依赖新 schema 的查询函数。

## 自动验证

- `npm run phase-24-pair:verify`：21 个场景通过，覆盖方向无关身份、商品切换不增行、上下文回填、未读映射、最新摘要、预约改指、孤儿/唯一键冲突阻断、重跑幂等和空 staging。
- `npm run verify`：81 项综合检查通过，覆盖消息权限、富消息路径、幂等、未读、游标、预约状态机、学校边界和认证回归。
- production migration dry-run：`safeToApply=true`、issues=0。
- production deployment dry-run：仅计划 4 个索引和 4 个云函数，业务数据/ACL 均不写。

## Staging / DevTools 人工清单

1. 账号甲打开账号乙的商品 A，联系卖家并发送“咨询 A”。
2. 返回后打开乙的商品 B，再次联系卖家。
3. 确认进入同一聊天历史、顶部变为商品 B、旧消息仍在。
4. 返回消息页，确认乙只显示一条会话。
5. 再打开商品 A，确认仍是同一 conversation，顶部切回 A。
6. 发送新消息，核对摘要、时间和双方未读。
7. 在 A 和 B 分别创建/查看预约，确认预约不串商品。
8. 反向入口、并发连点、退出重登、杀进程恢复后，确认始终只有一条 active conversation。
9. 第三账号继续验证读取会话、读取消息、发送消息均被拒绝。

## Production 最终结果

production migration 最终形成 26 条 conversations，其中 6 条为确定性 active canonical、20 条为 merged aliases；没有物理删除历史会话、消息或预约。自动 smoke 后为 150 条 messages、21 条 appointments；双账号和第三账号人工闭环后合理增加 5 条消息、1 条已完成预约及 2 个测试商品，最终只读计数为 8 users、72 products、26 conversations、155 messages、22 appointments。

最终核验确认：duplicate active pair、orphan、sender/participant 异常、message idempotency conflict、context product 异常、预约关系异常和第三账号越权写入均为 0；4 个目标索引 Ready 且强制 hint 查询通过；`messageAction`、`messageQuery`、`appointmentAction`、`appointmentQuery` 均为 Active/Available 且远端 hash 与验收源码一致；maintenance `enabled=false`、schemaVersion 正确、无残留冻结。

本专项 production rollout 和人工/自动验收均已关闭，可以随 Phase 24 最终 Git 封版标记为 COMPLETE。
