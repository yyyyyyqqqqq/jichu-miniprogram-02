# 阶段 18 前历史测试候选人工确认与双轨灰度方案

> 定稿日期：2026-07-29（Asia/Shanghai）
> 最终生产只读审计时间：2026-07-29 20:48:06（Asia/Shanghai）
> 目标环境：`cloud:cloud1***6d8e`
> Git 基线：`c1cf7a64d47406d490527c1f5f0597f528976508`（`phase-17-complete`）
> 性质：只读人工确认材料和阶段 18 设计参数；**不是数据处理授权，不是阶段 18 实施或上线授权**

## 1. 结论

预约—商品状态门禁已通过：

```text
pending = 0
accepted = 0
有效预约 = 0
reserved = 0
孤立 reserved = 0
reservedAppointmentId 异常 = 0
预约—商品状态异常 = 0
```

阶段 22A 原来仅按标题文本识别 14 条候选。后续 79.md 又以固定 ID 和 12/12 历史种子指纹确认 `p#56853a8ed6` 为阶段 4 初始化测试商品；它的原始标题不命中阶段 22A 文本正则。81.md 明确要求固定种子也纳入，因此当前真实候选为 **15 条**，不是强行维持 14 条。

分类结果：

```text
T1 = 0
T2 = 6
T3 = 1
T4 = 6
T5 = 2
```

技术条件允许在用户接受本文决策后启动阶段 18 代码开发。当前仍缺用户对逐条分类、灰度方式、默认关闭、历史商品退出影响、索引和部署的明确授权，因此本轮停止在方案定稿。

## 2. Git、范围与隐私边界

| 项目 | 结果 |
| --- | --- |
| 分支 | `main` |
| HEAD | `c1cf7a64d47406d490527c1f5f0597f528976508` |
| 标签 | `phase-17-complete` |
| `main...origin/main` | ahead 0 / behind 0 |
| 冲突或未合并文件 | 0 |
| 初始工作区 | 阶段 22A、阶段 18 前置、单对象复核及维护文件完整保留 |
| 业务代码变化 | 0 |

候选表不包含完整商品 ID、用户 ID、OPENID、昵称、头像、联系方式、标题原文、描述原文、精确地点、经纬度、媒体 URL、聊天正文或预约地点时间。

## 3. 状态一致性复核

原维护目标 `p#56853a8ed6`：

- 全库唯一，仍为 `offline`；
- 维护摘要仍为 `m#81248774c14c`；
- 10/10 不受维护影响的历史种子指纹仍一致；
- 收藏、会话、消息、预约、浏览和媒体关系仍为 0；
- 其他 36 条商品投影摘要仍为 `b9496176...7a437e04`，与维护完成快照一致。

不存在 accepted 预约对应非 reserved 商品，不存在 reserved 商品但无 accepted 预约，也不存在非 reserved 商品保留有效 `reservedAppointmentId`。

## 4. 候选规则、变化与编号

候选集合使用以下规则的并集：

1. 标题命中 `阶段 N / 测试 / 验收 / 验证 / test / demo / mock`；
2. 固定阶段 4 种子 ID 摘要和 12/12 指纹证据；
3. 已知阶段 17 学校绑定验收记录；
4. 已软删除测试记录；
5. 预约、聊天、商品卡片和媒体验收关系只用于风险分类，不用于扩大到普通商品。

变化如下：

| 项目 | 数量 |
| --- | ---: |
| 阶段 22A 标题候选 | 14 |
| 当前候选 | 15 |
| 新增 | 1 |
| 移除 | 0 |

新增项是后来通过固定种子证据确认的 `p#56853a8ed6`。它从 `reserved` 转为 `offline` 不会使测试身份消失；其当前主分类为 T3。由于阶段 22A 未对它执行 T1—T5 分类，所以不存在“旧分类被状态维护改变”的情况。

稳定编号规则：

```text
商品摘要 ASC
摘要 = p# + SHA-256(完整商品 _id) 前 10 位
```

重新执行时只要候选集合不变，编号保持一致。

## 5. 测试候选人工确认表

缩写：

- 学校：`权威` 或 `无`；
- 卖家：是否存在真实 users 记录；
- 收藏：`关系数/商品计数`；
- 预约：`历史数/有效数`；
- 浏览：`关系数/商品计数`；
- 媒体：`图片数/视频`；
- 快照：会话快照与商品卡片快照合计。

| TC | 摘要 | 标题分类 | 状态/公共 | 学校 | 卖家 | 收藏 | 会话/消息 | 预约 | 浏览 | 媒体 | 快照 | 分类 | 建议与风险 |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| TC-001 | `p#07afbbeec3` | [测试或验收商品] | sold/否 | 无 | 有 | 0/0 | 1/6 | 1/0 | 2/2 | 1/无 | 4 | T2 | 已完成交易且有系统消息、商品卡片和快照；保持非公开并长期保留。 |
| TC-002 | `p#133d829407` | [测试或验收商品] | available/是 | 无 | 有 | 0/0 | 0/0 | 0/0 | 0/0 | 1/无 | 0 | T4 | 无关系但仍有真实卖家和媒体；保持原状，等待用途确认。 |
| TC-003 | `p#358536aea0` | [测试或验收商品] | sold/否 | 无 | 有 | 0/0 | 2/4 | 1/0 | 0/0 | 1/无 | 2 | T2 | 有完成预约、会话、语音消息和快照；长期保留。 |
| TC-004 | `p#52ff896e18` | [测试或验收商品] | available/是 | 无 | 有 | 0/0 | 0/0 | 0/0 | 0/0 | 1/无 | 0 | T4 | 真实账号可管理且有媒体；不能仅按标题清理。 |
| TC-005 | `p#542228dea0` | [测试或验收商品] | available/是 | 权威 | 有 | 0/0 | 0/0 | 0/0 | 1/1 | 1/无 | 0 | T4 | 阶段 17 后学校商品且有真实浏览；保持原状等待确认。 |
| TC-006 | `p#56853a8ed6` | [阶段4初始化种子商品] | offline/否 | 无 | 无 | 0/18 | 0/0 | 0/0 | 0/412 | 0/无 | 0 | T3 | 固定种子、无真实关系或媒体；只列为后续软删除候选。 |
| TC-007 | `p#64f4a511af` | [测试或验收商品] | deleted/否 | 无 | 有 | 0/0 | 0/0 | 0/0 | 0/0 | 1/无 | 0 | T5 | 已软删除；不重复删除、不物理清理，保留审计记录。 |
| TC-008 | `p#6ae5f2588e` | [测试或验收商品] | available/是 | 无 | 有 | 0/0 | 0/0 | 0/0 | 1/1 | 1/无 | 0 | T4 | 有真实浏览和媒体；保持原状等待确认。 |
| TC-009 | `p#78ac6b9c40` | [测试或验收商品] | sold/否 | 无 | 有 | 0/0 | 1/4 | 1/0 | 2/2 | 1/无 | 2 | T2 | 有完成预约、商品卡片和快照；长期保留。 |
| TC-010 | `p#910341f711` | [测试或验收商品] | sold/否 | 无 | 有 | 0/0 | 0/0 | 0/0 | 0/0 | 1/无 | 0 | T4 | sold 但无交易关系证据且有媒体；需人工判断产生方式。 |
| TC-011 | `p#9646b13699` | [阶段17验收商品] | deleted/否 | 权威 | 有 | 0/0 | 0/0 | 0/0 | 0/0 | 1/无 | 0 | T5 | 阶段 17 已完成软删除；保持历史记录。 |
| TC-012 | `p#9ec62f476b` | [测试或验收商品] | sold/否 | 无 | 有 | 0/0 | 1/4 | 1/0 | 0/0 | 1/无 | 1 | T2 | 有完成预约、文本/系统消息和快照；长期保留。 |
| TC-013 | `p#aa7b7883d6` | [测试或验收商品] | sold/否 | 无 | 有 | 0/0 | 2/13 | 5/0 | 0/0 | 1/无 | 2 | T2 | 预约历史复杂，含完成、取消和拒绝；长期保留。 |
| TC-014 | `p#ba5fb507ea` | [测试或验收商品] | available/是 | 无 | 有 | 1/1 | 1/9 | 3/0 | 1/2 | 1/无 | 1 | T2 | 有收藏、会话、消息、取消预约和计数差异；保留，后续可单独确认 offline。 |
| TC-015 | `p#f07b37d359` | [测试或验收商品] | available/是 | 无 | 有 | 0/0 | 0/0 | 0/0 | 1/1 | 1/无 | 0 | T4 | 有真实浏览和媒体；保持原状等待确认。 |

全部 15 条的有效预约均为 0，视频均不存在，媒体清理任务均无待处理项。除 TC-006 外均有 1 张商品图片；本轮只统计投影，没有访问实际媒体。

## 6. T1—T5 汇总

| 分类 | 数量 | 本轮结论 |
| --- | ---: | --- |
| T1 正式或演示数据 | 0 | 没有足够证据将疑似测试记录改判为正式数据 |
| T2 历史验收记录 | 6 | 保留关系；公共可见的 TC-014 可后续独立确认是否 offline |
| T3 后续软删除候选 | 1 | 仅 TC-006；仍需单独授权 |
| T4 需要人工确认 | 6 | 真实卖家、媒体、浏览或 sold 状态使自动处理风险过高 |
| T5 已软删除 | 2 | 保持软删除，不重复删除或物理清理 |

其他汇总：

| 指标 | 数量 |
| --- | ---: |
| 公共可见 | 6 |
| offline | 1 |
| sold | 6 |
| deleted | 2 |
| 有权威学校 | 2 |
| 无权威学校 | 13 |
| 有真实卖家 | 14 |
| 无真实卖家 | 1 |
| 有会话/消息/预约/快照历史 | 6 |
| 无任何关系 | 6 |
| 有商品媒体 | 14 |
| 无商品媒体 | 1 |

**T3 只是后续安全软删除候选，不是删除授权。**

## 7. 全部无学校历史商品聚合

无权威学校商品总计 35 条：

| 指标 | 数量 |
| --- | ---: |
| available | 20 |
| offline | 2 |
| sold | 11 |
| deleted | 2 |
| reserved | 0 |
| 当前测试候选 | 13 |
| 非测试候选 | 22 |
| 有真实卖家 | 19 |
| 无真实卖家 | 16 |
| 有收藏关系的商品 | 5 |
| 有会话的商品 | 13 |
| 有消息的商品 | 13 |
| 有预约历史的商品 | 10 |
| 有浏览记录的商品 | 11 |
| 有商品媒体或历史媒体引用 | 19 |
| 有可自动采用的学校强证据 | 0 |
| 证据冲突 | 17 |
| 证据不足 | 18 |
| 自动迁移候选 | 0 |

当前没有任何历史商品可自动迁移。卖家当前学校不能倒推历史发布学校；旧 `campus` 不能直接映射；面交地点不是学校证据；买家、收藏者或聊天参与者学校也不能决定商品归属。

## 8. 双轨灰度定稿

### 8.1 旧模式：`legacy_market`

- 正式切换前继续兼容当前公共市场；
- 匿名可调用；
- 查询 `available/reserved`；
- 首页和搜索共用 `productQuery/list`；
- 使用 `page + pageSize + skip + limit`；
- 不按学校过滤。

旧模式只用于阶段 18 灰度和回滚窗口，不能被新模式错误自动调用。

### 8.2 新模式：`school_scoped_market`

- 匿名用户只进入首页壳，不查询普通市场；
- 未登录、未选校或学校不可用均不查询；
- 服务端从微信身份定位确定性用户，再读取权威用户学校；
- 数据库条件必须包含服务端解析的 `schoolId`；
- 客户端提交的市场模式和 `schoolId` 不可信；
- 只返回当前学校的 `available/reserved`；
- 历史无学校商品不拼接到校园市场；
- 使用学校和查询条件绑定的稳定游标；
- 查询、学校、游标或索引错误均明确失败，不回退全市场。

同一响应只能属于一个模式。响应返回：

```js
{
  marketMode: 'legacy' | 'schoolScoped',
  scope: {
    schoolId: '安全公开学校 ID 或空字符串',
    schoolName: '权威学校名称或空字符串'
  }
}
```

客户端需要 `schoolId` 来识别作用域变化并清空列表，但不能用它决定权限。模式或学校改变时必须清空旧列表、旧游标、总数和加载错误，旧响应由 requestVersion/市场作用域共同丢弃。

### 8.3 灰度控制

第一推荐：**G4，服务端代码内固定灰度名单**。

- 默认 `schoolScopedMarketEnabled=false`；
- 名单元素使用服务端认证后得到的确定性内部用户 ID，不接受客户端 OPENID或用户 ID；
- 当前少量测试账号无需新增集合；
- 名单为空时全部生产用户继续旧模式；
- 改名单需要重新部署 `productQuery`，代价明确但审计简单；
- 日志只记录用户 ID摘要、决策模式和错误码；
- 回滚是移除/关闭名单并部署，下一次请求回旧模式。

备选：**G3，ADMINONLY 服务端只读配置文档，默认关闭**。当灰度账号频繁调整时使用；它需要新集合或明确配置文档、权限、缓存失效和审计设计，本轮不创建。

### 8.4 默认值和失败行为

```text
schoolScopedMarketEnabled = false
```

| 场景 | 行为 |
| --- | --- |
| 配置读取失败 | 默认关闭，记录脱敏错误，不误开启 |
| 名单为空 | 全部用户保持 legacy |
| 不在名单 | 灰度期保持 legacy |
| 匿名用户 | legacy 灰度期沿用旧模式；正式切换后只显示首页壳 |
| 已判定新模式但学校异常 | 明确错误，不回退 legacy |
| 新模式数据库查询失败 | 明确错误，不回退全市场 |
| 游标非法或跨作用域 | `INVALID_CURSOR_SCOPE`，不回第一页 |
| 索引缺失 | 明确错误，绝不移除 `schoolId` 条件 |
| 用户退出灰度名单 | 下一请求回 legacy，旧学校游标失效 |

## 9. G1—G5 比较

| 方案 | 安全/隐私 | 运维与回滚 | 新集合 | 当前评价 |
| --- | --- | --- | --- | --- |
| G1 服务端确定性用户白名单 | 安全；只用服务端身份，可记录摘要 | 取决于名单存储；可快速撤销 | 不确定 | 作为原则正确，但必须落实为 G3 或 G4 |
| G2 环境级开关 | 环境内一致，不能细分账号 | 单真实环境会同时影响普通用户 | 否 | 不适合当前账号级灰度 |
| G3 服务端只读配置 | 安全、可动态审计，失败可默认关闭 | 更新和回滚快，但需权限、缓存和配置治理 | 是 | 备选，灰度规模扩大时采用 |
| G4 代码内固定名单 | 安全、最小表面积，不泄露客户端 | 每次改名单需部署；回滚清晰 | 否 | **第一推荐，适合当前少量账号** |
| G5 客户端参数 | 可伪造，泄露身份/模式边界 | 无可信回滚或审计 | 否 | **明确拒绝** |

## 10. 稳定游标协议

### 10.1 载荷

```text
version
marketMode
scopeSchoolId
action
categoryId
normalizedKeywordDigest
sortBy
statuses
pageSize
snapshotAt
lastSortValues
lastItemId
```

游标采用 `base64url(JSON payload) + HMAC-SHA256`。HMAC 密钥只在服务端配置中；Base64 仅编码，不是签名或保密。游标内容不放标题、关键词原文、用户身份或 OPENID。

首屏由服务端生成 `snapshotAt`，后续页增加 `createdAt <= snapshotAt`，避免分页期间新商品插入旧结果窗口。综合计数和价格可能被业务更新，seek 分页能消除 offset 位移，但不能提供数据库快照隔离；客户端仍按商品 ID去重，明显漏项通过刷新重新建立窗口。

### 10.2 完整 seek 条件

所有分支都同时包含：

```text
schoolId = 服务端当前学校
status IN ['available', 'reserved']
createdAt <= cursor.snapshotAt
分类和关键词条件与游标摘要一致
```

综合：

```text
favoriteCount < F
OR favoriteCount = F AND viewCount < V
OR favoriteCount = F AND viewCount = V AND createdAt < T
OR favoriteCount = F AND viewCount = V AND createdAt = T AND _id > I
```

最新：

```text
createdAt < T
OR createdAt = T AND _id > I
```

价格升序：

```text
price > P
OR price = P AND createdAt < T
OR price = P AND createdAt = T AND _id > I
```

价格降序：

```text
price < P
OR price = P AND createdAt < T
OR price = P AND createdAt = T AND _id > I
```

主字段和时间都相同时，`_id ASC` 是唯一兜底，因此下一页使用 `_id > I`。市场模式、学校、action、分类、关键词摘要、排序、状态集合、pageSize或游标版本任一变化，游标立即失效。非法、篡改、过期或跨学校游标明确拒绝，不回退旧分页或首页第一页。

## 11. 最小组合索引方案

以下 8 项覆盖现有四种排序的分类/非分类组合，均为非唯一索引。本轮未创建。

| 索引 | 字段 | 用途 | 必要性 |
| --- | --- | --- | --- |
| `idx_school_status_createdAt_id` | schoolId ASC, status ASC, createdAt DESC, _id ASC | 非分类最新 | 对应排序启用前必须 |
| `idx_school_status_favorite_view_createdAt_id` | schoolId ASC, status ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC | 非分类综合 | 对应排序启用前必须 |
| `idx_school_status_price_asc_createdAt_id` | schoolId ASC, status ASC, price ASC, createdAt DESC, _id ASC | 非分类价格升序 | 对应排序启用前必须 |
| `idx_school_status_price_desc_createdAt_id` | schoolId ASC, status ASC, price DESC, createdAt DESC, _id ASC | 非分类价格降序 | 对应排序启用前必须 |
| `idx_school_status_category_createdAt_id` | schoolId ASC, status ASC, categoryId ASC, createdAt DESC, _id ASC | 分类最新 | 对应排序启用前必须 |
| `idx_school_status_category_favorite_view_createdAt_id` | schoolId ASC, status ASC, categoryId ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC | 分类综合 | 对应排序启用前必须 |
| `idx_school_status_category_price_asc_createdAt_id` | schoolId ASC, status ASC, categoryId ASC, price ASC, createdAt DESC, _id ASC | 分类价格升序 | 对应排序启用前必须 |
| `idx_school_status_category_price_desc_createdAt_id` | schoolId ASC, status ASC, categoryId ASC, price DESC, createdAt DESC, _id ASC | 分类价格降序 | 对应排序启用前必须 |

等值作用域字段在前，真实排序字段随后，`_id` 稳定收尾。分类索引把 `categoryId` 放在等值 `schoolId/status` 之后、排序字段之前。8 项不能彼此完整复用，但可按灰度实际开放的排序逐项创建；若四种排序全部保持可用，则八项都必须在灰度前创建并反查。

当前 11 项商品索引全部保留，迁移、灰度和回滚期间不删除。关键词使用多字段正则，以上组合索引不保证优化正则分支；必须通过真实查询错误、耗时和查询计划验证，不能宣称性能已保证。

## 12. 阶段门禁

### 12.1 开发启动

| 条件 | 当前 |
| --- | --- |
| 预约—商品异常为 0 | 满足 |
| 候选分类完成 | 满足，当前真实为 15 条 |
| 用户接受分类和历史处理策略 | **待确认** |
| 用户接受 G4 和默认关闭 | **待确认** |
| 用户授权修改业务代码 | **未授权** |
| 用户授权后续索引和 `productQuery` 部署 | **未授权** |
| 接受正式切换后无学校商品退出普通市场 | **待确认** |

因此当前不直接启动开发。

### 12.2 灰度启用

尚不满足。必须先完成代码与自动验证、创建并反查索引、为两个 active 学校分别准备测试账号和可展示商品、通过 A/B 同校与 C 跨校、跨校游标拒绝、匿名首页壳、无学校/学校失效限制、新模式失败不回退、详情保持阶段 19 前现状，以及旧模式无回归。

当前上海财经大学浙江学院没有生产用户或商品，双学校测试库存条件不满足。

### 12.3 正式切换

尚不满足。还需灰度真机验收、双校隔离、分页和索引性能、历史影响与首页库存接受、历史收藏/会话/预约/我的发布可达、明确回滚操作及用户再次授权。不得仅凭自动验证正式切换。

## 13. 回滚方案

灰度回滚：

1. 服务端关闭或清空固定名单；
2. 受控用户下一次请求恢复 legacy；
3. 客户端发现模式变化后清空新游标和列表；
4. 保留新索引、代码和审计，不迁移或删除数据。

正式切换回滚：

- 旧查询路径在明确回滚窗口内保留；
- 只能由用户/产品负责人明确授权临时恢复；
- 恢复旧市场会重新暴露跨学校和无学校商品，必须记录时间、原因和影响；
- 新模式查询失败绝不能自动触发旧市场；
- 正式稳定且回滚窗口关闭后，另行授权删除旧路径。

禁止通过删除 `schoolId`、批量修改商品、删除索引、Git 强制回退或“查询失败返回全市场”回滚。

## 14. 下一轮阶段 18 决策参数

```text
candidateCount = 15
candidateOrder = productDigest ASC
candidateClasses = T1:0,T2:6,T3:1,T4:6,T5:2

legacyMode = legacy_market
strictMode = school_scoped_market
rolloutControl = G4_server_code_fixed_allowlist
rolloutAlternative = G3_server_readonly_config_default_off
rolloutIdentity = deterministic_server_user_id
schoolScopedMarketEnabled = false
clientChoosesMode = false
strictFailureFallsBackToLegacy = false
strictStatuses = available,reserved

cursorVersion = 1
cursorEncoding = base64url_json_plus_hmac_sha256
cursorBinds = mode,school,action,category,keywordDigest,sort,statuses,pageSize,snapshotAt
cursorInvalidBehavior = reject

requiredIndexCandidates = 8
retainLegacyIndexes = true
regexPerformanceGuaranteed = false

historicalNoSchoolAutoMigration = false
historicalRelationsPreserved = true
phase18ImplementationAuthorized = false
```

## 15. 本轮文件与验证

新增或更新：

- `scripts/phase-18-preflight-review.js`
- `scripts/verify-phase-18-preflight.js`
- `docs/phase-18-preflight-data-review-and-rollout.md`
- `package.json`
- 本地忽略的 `00-项目总交接文档.md`

本轮未修改小程序业务页面、Service、业务云函数或正式数据。

验证结果：

```text
npm run phase-22a:verify
  6 组通过

npm run phase-18-orphan-review:verify
  7 组通过

npm run phase-18-orphan-fix:verify
  8 组通过

npm run phase-18-preflight:verify
  10 组通过

npm run verify
  79 项通过

JavaScript 语法
  94 个文件通过

JSON.parse
  67 个文件通过

git diff --check
  通过
```

生产 dry-run 重复执行后继续得到 15 条相同稳定编号和相同分类；运行前后数量与投影摘要一致。

## 16. 无写入证明

| 集合 | 运行前 | 运行后 | 投影摘要 |
| --- | ---: | ---: | --- |
| users | 7 | 7 | 一致 |
| products | 37 | 37 | 一致 |
| favorites | 5 | 5 | 一致 |
| conversations | 16 | 16 | 一致 |
| messages | 132 | 132 | 一致 |
| appointments | 19 | 19 | 一致 |
| productViews | 14 | 14 | 一致 |
| schools | 2952 | 2952 | 一致 |

工具复用已经验证的只读投影，只调用 `QUERY`。两次读取的八集合投影 SHA-256 逐项一致。没有数据库写 API、事务、部署、索引、权限、删除、迁移或媒体访问路径。

证明边界：这能证明本工具没有写路径且审计窗口内所选投影一致；不能排除其他主体在窗口外或未投影字段上的独立操作。

## 17. 本轮明确未执行

- 未删除或软删除候选；
- 未修改任何商品、预约、收藏、会话、消息或浏览记录；
- 未迁移或推断学校；
- 未实施阶段 18 或 22B；
- 未修改首页、搜索、分页、详情或关系权限；
- 未创建灰度配置集合或客户端入口；
- 未创建索引；
- 未部署云函数；
- 未修改权限或学校状态；
- 未访问或清理媒体；
- 未 commit、push 或创建/移动标签。

## 18. 等待用户确认

1. 是否接受当前 15 条候选及其 T1—T5 分类；
2. 是否接受新增第 15 条来自阶段 4 固定种子证据，而不是强行维持原 14 条；
3. 是否允许未来对唯一 T3（TC-006）执行独立受控软删除；
4. 哪些 T2 必须长期保留，是否允许后续将公共可见的 TC-014 转为 offline；
5. 是否接受 G4 服务端代码内固定灰度名单，G3 作为备选；
6. 是否接受严格模式默认关闭以及任何失败都不回退全市场；
7. 是否授权阶段 18 正式代码开发；
8. 是否授权后续创建并反查最小组合索引；
9. 是否授权后续部署 `productQuery`；
10. 是否接受正式切换后历史无学校商品退出普通市场；
11. 是否先为两所 active 学校分别准备测试账号和可展示商品。
