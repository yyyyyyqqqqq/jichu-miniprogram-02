# 阶段 18 前置：孤立 reserved 历史测试商品单对象维护记录

> 执行日期：2026-07-29（Asia/Shanghai）
> 正式更新时间：2026-07-29 18:10:18（Asia/Shanghai）
> 写后只读复核时间：2026-07-29 18:17:30（Asia/Shanghai）
> 目标环境：`cloud:cloud1***6d8e`
> 商品摘要：`p#56853a8ed6`
> 维护操作摘要：`m#81248774c14c`
> 结论：**用户明确授权的唯一历史初始化测试商品已从 `reserved` 受控转为 `offline`。全库 `reserved=0`、有效预约=0、孤立 `reserved=0`；未发现任何非白名单字段、其他商品、其他集合、关系、媒体或学校数据变化。**

本文只保留脱敏维护证据，不包含完整商品 ID、完整维护操作 ID、OPENID、完整用户 ID、商品原文、地点、媒体地址、完整云环境 ID或凭据。写入前后快照保存在系统临时目录，不进入 Git。

## 1. Git 基线与授权边界

| 项目 | 结果 |
| --- | --- |
| 分支 | `main` |
| HEAD | `c1cf7a64d47406d490527c1f5f0597f528976508` |
| HEAD 标签 | `phase-17-complete` |
| 与 `origin/main` | ahead 0 / behind 0 |
| 用户授权 | 仅将 `p#56853a8ed6` 从 `reserved` 转为 `offline` |
| 未授权 | 其他数据修改、软删除、恢复可售、标记售出、补学校/卖家、阶段 18、22B、部署、索引、权限、提交、推送、标签 |

工作区开始时已有阶段 22A、阶段 18 安全停止和单对象来源复核的未提交文件。本轮保留这些文件，没有覆盖用户或既有任务的改动。

## 2. 历史测试来源证据

目标在全库 37 条商品中唯一匹配。写入前，以下 12 项与阶段 4 固定生产初始化测试夹具完全一致：

```text
完整 ID 的 SHA-256、标题 SHA-256、描述 SHA-256、价格、原价、
分类、成色、状态、favoriteCount、viewCount、createdAt、updatedAt
```

结果为 `12/12`。历史 Git 证据表明该种子路径曾可直接写入 `reserved` 而不创建预约归属，后续已经移除；正式预约状态机晚于该种子记录引入。目标没有真实卖家、业务关系或媒体，因此维护用途被限定为隔离历史测试夹具。

## 3. 写入前脱敏快照

| 检查项 | 写入前结果 |
| --- | --- |
| 唯一性 | 1 条，唯一 |
| 历史种子指纹 | 12/12 |
| 状态 | `reserved` |
| version | 字段缺失，不按 0 处理 |
| reservedAppointmentId / reservedAt | 均缺失 |
| offlineAt / soldAt / deletedAt | 均缺失 |
| maintenance / lastMutationId | 均缺失 |
| 预约历史 | 0 |
| 收藏 / 会话 / 消息 / 浏览关系 | 0 / 0 / 0 / 0 |
| 图片 / 视频 /媒体清理文件 | 0 / 无 / 0 |
| 真实卖家 users 记录 / sellerOpenid | 不存在 / 缺失 |
| schoolId / schoolName | 均缺失 |
| 全库 pending / accepted | 0 / 0 |
| 全库孤立 reserved | 1，且只有本目标 |

商品文档内的 `favoriteCount=18` 和 `viewCount=412` 是历史种子预置展示计数，不对应真实关系集合记录。本轮保持不变。

## 4. dry-run 与写入白名单

正式写入前使用同一维护操作 ID执行 dry-run，结果为 `DRY_RUN_OK`：

- 环境掩码、商品摘要和维护操作 ID均显式提供；
- 目标恰好 1 条，12/12 指纹一致；
- 全部商品、预约、关系、卖家、学校和媒体前置条件通过；
- `writeReady=true`、`applyAllowed=true`；
- `writeExecuted=false`。

唯一允许变化的顶层字段为：

```text
status
offlineAt
updatedAt
version
maintenance
```

工具不接受自定义状态、软删除、商品 ID、过滤器、批量或迁移参数。未提供 `--apply` 时没有数据库写路径。

## 5. 单文档原子更新条件

正式操作只向 `products` 发出一条 `UPDATE`，固定为：

```text
updates.length = 1
multi = false
upsert = false
```

条件同时包含：

- 进程内的精确内部商品 ID；
- `status=reserved`；
- `version / reservedAppointmentId / reservedAt / offlineAt / soldAt / deletedAt / lastMutationId / maintenance` 均不存在；
- `sellerOpenid / schoolId / schoolName` 均不存在；
- 标题、描述、价格、原价、分类、成色、展示计数、创建时间、更新时间仍等于写入前 12/12 种子值。

关系集合前置条件先在写入前快照中确认，写入后立即再次核对。数据库接口不能把跨集合条件放入同一商品更新，因此没有尝试扩大更新范围或自动修改其他集合。

## 6. 实际更新结果

更新内容固定为：

```text
status = offline
version = 1
offlineAt = 服务端时间
updatedAt = 服务端时间
maintenance.type = orphan_reserved_to_offline
maintenance.source = phase_4_seed_fixture
maintenance.reason = orphan_reserved_test_product
maintenance.mutationId = 本地一次性操作 ID
maintenance.appliedAt = 服务端时间
```

CloudBase CLI 的原始 UPDATE 返回结构未被首版结果解析器识别，因此首个 apply 进程返回 `UPDATE_RESULT_UNREADABLE`，没有把这一解析错误误当成可重试写入。紧接着的只读读取已确认目标完成授权转换；结合以下证据，原更新命中数确定为 1：

1. 命令只有一个精确 ID目标，且 `multi=false / upsert=false`；
2. 目标从写入前 `reserved` 变为 `offline`；
3. version、时间戳和相同维护操作摘要同时出现；
4. 写前快照存在且可与写后状态完整对账；
5. 其他 36 条商品和所有非商品集合投影均未变化。

工具随后增加对该已完成状态的只读对账分支。相同维护操作 ID复核返回 `ALREADY_APPLIED`、`originalAtomicUpdateCount=1`、`secondWriteExecuted=false`。没有发生部分写入或第二次更新。

## 7. 写入前后字段对比

| 字段或字段组 | 写入前 | 写入后 | 结果 |
| --- | --- | --- | --- |
| status | `reserved` | `offline` | 授权变化 |
| offlineAt | 缺失 | 存在，2026-07-29 18:10:18（Asia/Shanghai） | 授权变化 |
| updatedAt | 历史种子时间 | 2026-07-29 18:10:18（Asia/Shanghai） | 授权变化 |
| version | 缺失 | `1` | 授权变化 |
| maintenance | 缺失 | 类型、来源、原因、操作摘要和 appliedAt 完整 | 授权变化 |
| 标题/描述不可逆哈希 | 一致 | 一致 | 未变化 |
| 价格/原价/分类/成色 | 种子值 | 同前 | 未变化 |
| 地点与创建时间 | 历史值 | 同前 | 未变化 |
| favoriteCount / viewCount | `18 / 412` | `18 / 412` | 未变化 |
| 学校字段缺失状态 | 均缺失 | 均缺失 | 未变化 |
| 卖家字段 | 历史引用；无 sellerOpenid | 同前 | 未变化 |
| 图片/视频 | 0 / 无 | 0 / 无 | 未变化 |
| 预约归属字段缺失状态 | 均缺失 | 均缺失 | 未变化 |

排除授权字段后的目标商品摘要前后均为：

```text
8a854e24964e4941a36bd62dbe35a769c5e21434d38a8d7f0fefb313ad937685
```

白名单核对结果为 `whitelistPassed=true`。

## 8. 幂等与错误操作验证

| 场景 | 结果 | 是否写入 |
| --- | --- | --- |
| 相同 maintenance mutationId 再执行 `--apply` | `ALREADY_APPLIED` | 否 |
| 相同操作后的 version / offlineAt / updatedAt | 保持 `1`，时间不变 | 否 |
| 不同 mutationId 再尝试 | `PRECONDITION_FAILED` | 否 |
| 不同 mutationId 是否到达 UPDATE 命令 | 否 | 否 |

维护工具不会用宽松条件覆盖已完成结果。

## 9. 写后预约—商品一致性

| 项目 | 写前 | 写后 |
| --- | ---: | ---: |
| pending 预约 | 0 | 0 |
| accepted 预约 | 0 | 0 |
| 有效 pending/accepted | 0 | 0 |
| reserved 商品 | 1 | 0 |
| available 商品 | 21 | 21 |
| offline 商品 | 1 | 2 |
| 商品总数 | 37 | 37 |
| 孤立 reserved | 1 | 0 |
| accepted 与商品状态不匹配 | 0 | 0 |

阶段 18 的预约—商品状态前置门禁已解除。阶段 22A 仍保留“绝大多数公共商品缺少权威学校”的迁移安全停止条件，这与本次单对象维护无关。

## 10. 关系与媒体写后复核

目标商品的收藏、会话、消息、预约、浏览记录继续全部为 0；图片为 0、视频不存在、媒体快照引用为 0、媒体清理文件为 0、失败清理为 0、待处理清理任务为否。没有访问、上传或删除云存储文件。

## 11. 八集合数量

| 集合 | 写前 | 写后 | 变化 |
| --- | ---: | ---: | ---: |
| users | 7 | 7 | 0 |
| products | 37 | 37 | 0 |
| favorites | 5 | 5 | 0 |
| conversations | 16 | 16 | 0 |
| messages | 132 | 132 | 0 |
| appointments | 19 | 19 | 0 |
| productViews | 14 | 14 | 0 |
| schools | 2952 | 2952 | 0 |

## 12. 投影摘要对账

写前、写后脱敏快照使用同一投影和稳定排序算法。

| 投影 | 结果 |
| --- | --- |
| users | 一致 |
| favorites | 一致 |
| conversations | 一致 |
| messages | 一致 |
| appointments | 一致 |
| productViews | 一致 |
| schools | 一致 |
| products 完整投影 | 按预期变化，仅来自目标授权字段 |
| 其他 36 条商品投影 | 一致 |
| 目标排除授权字段后的投影 | 一致 |

其他 36 条商品投影摘要前后均为：

```text
b9496176ead65cc3f3fc2c3163be371a25001923c4f0f5b239a436ba7a437e04
```

非商品集合的写前、写后投影摘要逐项完全相同。`products` 完整投影摘要按预期从 `007760...e054a1f0` 变为 `31c83e...0b4c73`，没有将授权变化错误描述为全商品摘要一致。

## 13. 自动验证

真实执行结果：

```text
npm run phase-22a:verify
  6 组通过

npm run phase-18-orphan-review:verify
  7 组通过

npm run phase-18-orphan-fix:verify
  8 组通过

npm run verify
  79 项通过

JavaScript 语法检查
  92 个文件通过

JSON 解析检查
  67 个文件通过

git diff --check
  通过
```

写后还真实执行了阶段 22A 生产只读盘点和单对象生产只读复核。两者均证明运行前后计数及自身读取投影不变、没有调用写 API。

## 14. 云函数与其他云端边界

`appointmentAction / appointmentQuery / manageProduct / productQuery` 均为 Active，入口、运行时、超时和本地/云端入口 SHA-256 一致。

本轮云端唯一写操作是对 1 条目标商品的单文档原子更新。未修改其他商品或集合，未部署云函数，未改函数配置，未创建临时云函数，未创建或修改索引，未修改数据库权限，未修改学校状态，未访问或删除媒体。

## 15. 本地修改文件

- `scripts/phase-18-fix-orphan-reserved-product.js`：一次性、默认拒绝、严格前置条件、单文档原子更新、脱敏快照和幂等对账工具。
- `scripts/verify-phase-18-fix-orphan-reserved-product.js`：维护工具 8 组专项验证。
- `scripts/phase-18-orphan-reserved-review.js`：识别本次授权的 `offline` 维护结果，并继续支持写后只读审计。
- `scripts/verify-phase-18-orphan-reserved-review.js`：增加授权维护完成态验证。
- `package.json`：增加 `phase-18-orphan-fix:verify` 命令。
- `docs/phase-18-orphan-reserved-product-fix.md`：本脱敏维护记录。
- `00-项目总交接文档.md`：本地忽略的项目交接摘要。

本轮未修改小程序业务页面、Service 或业务云函数。

## 16. 未执行事项与剩余风险

本轮没有软删除、恢复 `available`、标记 `sold`、补学校、补卖家、修改展示计数、修改关系、访问媒体、实施阶段 18、实施 22B、commit、push 或创建/移动标签。

本次孤立 `reserved` 异常已经消除。剩余迁移风险仍包括：21 条公共商品中仅 1 条具有权威学校，20 条没有权威学校；因此不能把本次维护理解为阶段 22B 数据迁移获准或阶段 18 正式开发获准。

## 17. 门禁结论

当前有效预约为 0，孤立 `reserved` 为 0，预约—商品状态一致性检查通过。可以在用户下一次明确授权后，重新执行 14 条测试候选人工确认并完成双轨灰度方案定稿。

这只解除阶段 18 的预约—商品状态前置阻断，不等于阶段 18 已开始、已完成或已获正式开发授权，也不等于 22B 已开始。
