# Phase 24：用户对会话迁移工具加固与 staging 故障演练

## 结论

2026-08-13 按 `114.md` 完成迁移工具完整快照、幂等、checkpoint、回滚、逐字段验证、规范化 hash 和权威 maintenance mode 加固，并在 staging 完成真实迁移/回滚/故障注入演练。

2026-08-13 当时的停止点为：

```text
MIGRATION TOOLING READY FOR FINAL PRODUCTION READ-ONLY REVIEW
```

当时 production 尚未执行迁移、回滚、maintenance、索引或函数部署，工具在最终只读复核和负责人授权边界安全停止。后续 production 执行结果见本文末尾。

## 快照与解析

CloudBase CLI 输出解析现在只接受一个完整的 object/array JSON 文档；JSON 字符串行不再被当作响应。日志混杂时使用字符串/转义感知的括号扫描提取唯一结构化候选；0 个或多个候选均 fail closed。

迁移快照按 `_id` 稳定排序和分页读取，并以 `DescribeTables` 前后两次元数据计数为边界：

- 集合缺失、响应结构非法、重复 `_id`、分页不完整、读取期间计数变化或达到安全上限均立即停止；
- production 最新只读快照稳定读取 `8 users / 70 products / 20 conversations / 147 messages / 20 appointments`；
- 不再允许 `products=0` 等静默缺失继续生成可 apply 计划。

## Migration 执行模型

dry-run 在任何写入前持久化 schema v2 私有清单，包含：

- `migrationRunId`；
- 完整 `beforeSnapshot`；
- migration plan；
- 每个 mutation 的 `before / expectedAfter / migrationRunId / stage`；
- 每集合及组合 normalized hash；
- 目标环境角色和 masked ID。

apply 必须显式引用这一份清单，且要求：

1. 环境角色和 masked ID 与清单一致；
2. maintenance 为 ON 且 `migrationRunId` 一致；
3. live snapshot 完整 hash 与 dry-run 一致；
4. plan 仍为 `safeToApply=true`。

写入顺序为：

```text
archives → canonicals → messages → appointments → post-validation
```

每个实际写入批次后持久化 checkpoint。命令按文档 payload 上限切分，避免 Windows 进程命令行截断。出现异常时清单进入 `apply-interrupted`，并立刻读取 live 数据，将每个 mutation 分类为 `before / after / missing / diverged`。

`--resume` 只允许 live 状态仍完全落在 before/expectedAfter 证据集合内；只重放仍处于 before 的 mutation。任何 missing/diverged 都拒绝自动恢复，必须保持维护并人工处理或 rollback。

## 完成态幂等

- `status=merged` 的 alias 在分组前被排除；
- alias 的 `merged_*` 占位 productId 不参与上下文计算；
- canonical 按确定性 ID、参与者和 participantPairKey 稳定识别；
- 已存在 canonical 的 `contextUpdatedAt` 保持自身已写值，不被最新 message 时间漂移；
- 只有目标字段确实不同才生成 canonical/message/appointment mutation。

staging 完成态第二、第三次 dry-run 均为：

```text
canonicalCreates=0
canonicalUpdates=0
archivedAliases=0
messageUpdates=0
appointmentUpdates=0
issues=0
```

## Rollback 执行模型

rollback 只依赖写前已持久化的 `beforeSnapshot + expectedMutations`，不依赖 afterSnapshot：

1. 确认 maintenance ON 和 migrationRunId；
2. 将每个 mutation 分类为 before/after；
3. 只恢复当前处于 after 的原记录；
4. 只删除本次迁移创建且当前处于 after 的 canonical；
5. 如果目标唯一索引已经创建，可用显式参数先删除本轮4个索引；
6. 再次读取完整快照并逐集合比较 normalized hash。

重复 rollback 在已经恢复的 before 状态不再重复写，仍能通过完整 hash。rollback 自身若被网络中断，会持久化 `rollback-interrupted` 和可读 live 状态；再次运行继续安全恢复。

## 逐字段与 hash 验证

post-validation 同时验证：

- conversation 数量增量只等于本轮新建 canonical 数；
- canonical、merged alias、message、appointment 每个 mutation 均等于 expectedAfter；
- users/products/messages/appointments 数量不丢失；
- 无孤儿 message/appointment；
- participantPairKey 唯一；
- message 幂等唯一键无冲突；
- 排除允许变化字段后的业务等价 hash 保持一致。

staging Round A：

- before combined hash：`cce511325ad07ec6f716ac79f4981916b91389d6e9767d345eb097b9ba478c7c`
- after combined hash：`b9af21bcae1dfd8de7f66dc7428efc52c976918622c0da6e23e8ef71c25918bb`
- before/after business hash：均为 `deafa763d5cc686f67f967b9bf8dffc839e75ff02072f8152792c3607cfc4981`
- rollback combined hash：恢复为 `cce511325ad07ec6f716ac79f4981916b91389d6e9767d345eb097b9ba478c7c`

## Maintenance mode

权威配置：

```text
collection: systemConfig
document: conversation_appointment_maintenance
schemaVersion: 1
enabled: boolean
migrationRunId: phase24_pair_...
```

四个函数 `messageAction / appointmentAction / messageQuery / appointmentQuery` 在身份与 action 校验后、任何业务读写前读取配置。ON 时统一返回：

```json
{
  "success": false,
  "code": "SERVICE_MAINTENANCE",
  "message": "服务维护中，请稍后再试",
  "data": null
}
```

配置缺失、schema 非法或读取失败均 fail closed。迁移期间查询也被冻结，避免客户端在跨集合非原子写入阶段观察到半迁移状态。

production 安全激活顺序不是“先取快照”：

1. 创建 maintenance config 并设 ON（旧函数暂不识别，尚未宣称冻结）；
2. 使用 `--maintenance-gate-only` 部署四个带闸门的新函数；
3. 用真实接口逐项确认四个函数均返回 `SERVICE_MAINTENANCE`；
4. 此后才取最终快照、dry-run 和执行迁移；
5. 创建索引、完成验证后才把 maintenance 设 OFF。

## Staging 真实演练

等价 fixture 覆盖：4个用户、3个用户对、6个 legacy conversation、6个商品、16条消息、4条预约、2个重复用户对、跨当前学校历史关系、双向未读、显式/待回填 context、无预约用户对和多预约用户对。

正常迁移结果：

- 6 legacy → 3 canonical + 6 merged；
- 16 messages 全部保留并改指；
- 4 appointments 全部保留并改指；
- post-validation 和业务等价 hash 通过；
- 实际网络 `ECONNRESET` 发生在全部写完/验证前，工具正确识别为 `after`，随后 `--resume` 完成验证。

正常 rollback 与重复 rollback 均通过完整逐集合 hash。原 staging 数据随后恢复为：

```text
3 users / 2 products / 1 active conversation / 8 messages / 0 appointments
```

四个目标索引和 maintenance OFF 状态也已恢复，四个 staging 函数下载包中的 `index.js / maintenance.js / package.json / package-lock.json` 均与本地逐文件同 hash。

## Fault injection

| 故障点 | 识别状态 | before / after mutation | 最终结果 |
| --- | --- | ---: | --- |
| archives 后 | partial | 23 / 6 | rollback 完整 hash 一致 |
| canonical 部分创建后 | partial | 22 / 7 | rollback 完整 hash 一致 |
| messages 部分改指后 | partial | 19 / 10 | rollback 完整 hash 一致 |
| appointments 部分改指后 | partial | 3 / 26 | rollback 完整 hash 一致 |
| 全写完、验证前 | after | 0 / 29 | rollback 完整 hash 一致 |

所有中断点均为 `missing=0 / diverged=0`，没有停留在未知状态。

## 自动验证

- pair 专项扩展为52项，覆盖完整 JSON、混杂日志、标量行、70+分页、数量不一致、真实完成态二/三次 no-op、四阶段中断、完整 hash、重复 rollback、maintenance ON/OFF/fail-closed；
- Phase 18—24 与综合回归合计971项通过；
- 190个 JavaScript 文件语法检查通过；
- `git diff --check` 通过。

## Production 执行与最终关闭

在项目负责人逐阶段授权后，production 严格按门禁完成 maintenance ON、迁移、索引 Ready 校验、四函数部署与配置/hash 复核，再关闭 maintenance 并执行自动 smoke。迁移过程中一次网络中断由 checkpoint/resume 安全恢复；最终 mutation state 无 missing/diverged，业务一致性验证通过，没有执行 rollback。

迁移结果为 26 条 conversations（6 active canonical、20 merged aliases）、147 条 messages、20 条 appointments；自动 smoke 合法增加 3 条消息和 1 条最终已取消预约。随后双账号和第三账号真机人工闭环通过，最终只读状态为 8 users、72 products、26 conversations、155 messages、22 appointments。所有 orphan、pairKey/message idempotency conflict、context/summary/unread、预约关系和权限异常均为 0。

4 个目标索引保持 Ready 且 forced hint 查询通过；4 个正式业务函数 Active/Available，运行配置和远端文件 hash 与已验收版本一致。maintenance 最终为 `enabled=false`、schemaVersion=1，无残留冻结。该结果已满足 Phase 24 最终 Git 封版条件。
