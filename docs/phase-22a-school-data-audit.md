# 阶段 22A：存量学校数据只读盘点与阶段 18 前置门禁

> 审计时间：2026-07-29（Asia/Shanghai）
> 审计环境：`cloud:cloud1***6d8e`
> Git 基线：`c1cf7a64d47406d490527c1f5f0597f528976508`（`phase-17-complete`）
> 当前状态：只读盘点已完成；触发安全停止条件，禁止立即启用阶段 18 严格过滤
> Git 边界：未提交、未推送、未创建标签

## 1. 结论摘要

阶段 22A 已成功读取真实云端聚合数据，运行前后 8 个集合的数量和本次投影摘要完全一致。审计脚本只允许 `QUERY` 和 `listIndexes`，没有数据库写入 action、事务、部署、权限或索引修改路径。

本次触发两个强制停止条件：

```text
MOST_PUBLIC_PRODUCTS_LACK_AUTHORITATIVE_SCHOOL
ACTIVE_APPOINTMENTS_REFERENCE_UNASSIGNED_PRODUCTS
```

当前 `available + reserved` 公共商品共 22 条，只有 1 条具有完整权威学校，21 条没有权威学校，占 95.45%。同时有 1 条未删除的 `pending/accepted` 预约依赖无学校商品。若立即实施严格同校过滤，普通市场几乎清空，并会使进行中的交易对象退出市场列表。

因此本轮停止在只读报告和候选设计，不实施阶段 18，不执行 22B，不创建索引。

## 2. 阅读、工程和 Git 基线

完整核对：

- `00-项目总交接文档.md`
- `docs/phase-14-multi-school-audit.md`
- `docs/phase-15-school-data-and-query.md`
- `docs/phase-16-user-school-selection.md`
- `docs/phase-17-product-school-binding.md`
- `README.md`
- `.gitignore`
- `package.json`

同时审计 `productQuery`、`ProductService`、首页、认证守卫、收藏、消息、预约、浏览记录、学校 CLI、学校导入/状态工具、项目验证及既有索引文档。

开始状态：

```text
branch: main
HEAD: c1cf7a64d47406d490527c1f5f0597f528976508
tag at HEAD: phase-17-complete
main...origin/main: 0 ahead / 0 behind
tracked worktree: clean
```

编号文档和本机私有配置继续由 `.gitignore` 忽略。没有发现阶段 17 未收尾内容。

## 3. 当前公共市场真实实现

### 3.1 首页和搜索调用链

```text
pages/home/index
→ ProductService.getProducts
→ ProductService.callProductQuery
→ CloudService.ensureCloudReady
→ wx.cloud.callFunction(productQuery, action=list)
→ cloudfunctions/productQuery/index.js
→ products.where(condition).count()
→ orderBy + skip + limit
```

搜索不是独立页面或独立 action。`components/search-bar` 发出输入/确认/清空事件，首页将关键词并入同一 `list` 请求；输入使用 300ms 防抖。

### 3.2 action、身份和响应

`productQuery` 支持：

```text
list
detail
myProducts
```

- 公共列表 action：`list`
- 搜索 action：仍为 `list`
- 详情 action：`detail`
- 本人商品 action：`myProducts`
- `list/detail` 不读取微信身份，云函数层允许匿名调用。
- 首页 `requireMarketAccess` 对匿名状态返回允许，因此匿名用户当前仍会查询全市场。
- 已登录但资料未完成或学校未就绪的用户会进入资料/选校流程。
- 成功响应为 `success/data/code/message`，列表数据为 `list/total/page/pageSize/hasMore`。
- 公开字段通过 `toPublicProduct` 白名单返回；不会返回内部 OPENID、精确地点或学校管理字段。

### 3.3 筛选、搜索和排序

公共状态固定为：

```text
available / reserved
```

现有筛选：

- 分类：`all/digital/books/life/clothing/sports/other`
- 关键词：最多 40 字、最多 5 个空格分词
- 搜索字段：标题、描述、分类名、成色、地点和标签
- 搜索实现：转义后的大小写不敏感正则

现有排序：

| 模式 | 排序字段 |
| --- | --- |
| 综合 `default` | `favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC` |
| 最新 `newest` | `createdAt DESC, _id ASC` |
| 价格升序 `priceAsc` | `price ASC, createdAt DESC, _id ASC` |
| 价格降序 `priceDesc` | `price DESC, createdAt DESC, _id ASC` |

没有独立热度页或其他 Prompt 假设的算法。

### 3.4 当前分页和竞态

- 客户端：`page + pageSize`，首页默认每页 6 条。
- 服务端：最大页 100、最大每页 20。
- 数据库：先 `count`，再 `(page - 1) * pageSize` 的 `skip + limit`。
- 所有排序都有 `_id ASC` 唯一兜底，但仍属于偏移分页。
- 并发新增、状态变化或排序计数变化可能使后续页重复或漏项。
- 首页加载更多会按商品 ID 合并去重，但不能恢复已漏掉的记录。
- 关键词、分类、排序切换会清空列表和页码。
- `requestVersion` 丢弃旧响应；搜索计时器会在条件切换和卸载时取消。
- 下拉刷新重查第 1 页，加载更多使用下一页。
- 初次加载、查询中、空态、整页错误和加载更多错误已经分离。

本轮未修改上述实现。

## 4. 用户学校数据统计

全程只输出聚合数量。

| 指标 | 数量 |
| --- | ---: |
| 用户总数 | 7 |
| `active` 用户 | 7 |
| 非 `active` 用户 | 0 |
| 非空 `schoolId` | 3 |
| 缺少 `schoolId` 字段 | 4 |
| `schoolId = null` | 0 |
| `schoolId = ""` | 0 |
| `schoolId` 类型错误 | 0 |
| `schoolId` 格式错误 | 0 |
| `schoolName` 缺失或异常 | 4 |
| 学校字段完整且权威有效 | 3 |
| 指向不存在学校 | 0 |
| 指向 pending/inactive 学校 | 0 |
| 指向官方非 valid 学校 | 0 |
| 与权威学校名称不一致 | 0 |
| 无权威学校用户 | 4 |
| 无学校但已有任一业务数据的用户 | 2 |

按 active 学校：

| 学校 | 用户数 |
| --- | ---: |
| 上海工程技术大学 | 3 |
| 上海财经大学浙江学院 | 0 |

无权威学校用户的业务参与：

| 业务 | 涉及用户数 |
| --- | ---: |
| 任一业务 | 2 |
| 商品 | 1 |
| 收藏 | 1 |
| 会话 | 2 |
| 消息 | 2 |
| 预约 | 2 |

## 5. 商品学校数据统计

### 5.1 总体与字段

| 指标 | 数量 |
| --- | ---: |
| 商品总数 | 37 |
| 非空且格式合法 `schoolId` | 2 |
| 学校字段完整且权威有效 | 2 |
| 缺少 `schoolId` 字段 | 35 |
| `schoolId = null` | 0 |
| `schoolId = ""` | 0 |
| `schoolId` 类型错误 | 0 |
| `schoolId` 格式错误 | 0 |
| `schoolName` 缺失或异常 | 35 |
| 指向不存在学校 | 0 |
| 指向 pending/inactive 学校 | 0 |
| 指向官方非 valid 学校 | 0 |
| 与权威学校名称不一致 | 0 |

### 5.2 按状态

| 状态 | 总数 | 权威学校 | 无学校 | 非法 ID | 无效引用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| available | 21 | 1 | 20 | 0 | 0 |
| reserved | 1 | 0 | 1 | 0 | 0 |
| offline | 1 | 0 | 1 | 0 | 0 |
| sold | 11 | 0 | 11 | 0 | 0 |
| deleted | 3 | 1 | 2 | 0 | 0 |
| draft | 0 | 0 | 0 | 0 | 0 |
| 其他异常状态 | 0 | 0 | 0 | 0 | 0 |

公共市场关键比例：

```text
available + reserved = 22
有权威学校 = 1
无权威学校 = 21
无权威学校占比 = 95.45%
```

### 5.3 按 active 学校

| 学校 | 总数 | available | reserved | offline | sold | deleted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 上海工程技术大学 | 2 | 1 | 0 | 0 | 0 | 1 |
| 上海财经大学浙江学院 | 0 | 0 | 0 | 0 | 0 | 0 |

## 6. 无学校商品的业务影响

“无学校商品”在本节指没有完整、权威、active + valid 学校快照的商品。

| 模块 | 聚合结果 |
| --- | --- |
| 收藏 | 5 条关系、5 个不同商品、3 个不同用户 |
| 会话 | 16 条、涉及 13 个商品 |
| 最近会话代理指标 | 16 条会话最近 30 天有更新时间；当前 schema 没有独立 active 标志 |
| 消息 | 131 条相关消息 |
| 会话内消息 | 131 条 |
| 直接商品关联消息 | 50 条 |
| 商品卡片消息 | 7 条 |
| 会话历史商品快照 | 16 条 |
| 预约 | 19 条 |
| 预约状态 | pending 1、accepted 0、rejected 1、cancelled 9、completed 8 |
| 当前有效预约 | 1 条未删除的 pending/accepted |
| 浏览记录 | 13 条，涉及 11 个商品 |

这些统计证明历史无学校商品不是孤立数据。严格列表隔离不能同时被解释为删除收藏、会话、消息、预约或浏览历史的授权。

## 7. 可归属证据分析

无权威学校商品共 35 条：

| 证据指标 | 数量 |
| --- | ---: |
| 卖家当前具有权威学校 | 17 |
| 商品早于卖家首次选校 | 17 |
| 商品不早于首次选校 | 0 |
| 创建时间关系未知 | 18 |
| 存在旧 `campus` 文本 | 35 |
| 当前卖家学校与旧 campus 冲突候选 | 17 |
| 当前卖家学校和 campus 都没有 | 0 |

候选分类：

| 类别 | 数量 | 处理边界 |
| --- | ---: | --- |
| A 较强证据、可人工抽样 | 0 | 本批没有满足“当前权威学校且商品不早于首次选校”的记录 |
| B 证据不足 | 18 | 必须保持未归属 |
| C 证据冲突 | 4 | 必须人工处理 |
| D 测试数据候选 | 12 | 只能进入人工确认，不能自动删除或迁移 |
| E 已删除/归档候选 | 1 | 保留历史关系 |

强制解释：

- 用户当前学校不能自动等同于历史商品发布学校。
- 17 条商品明确早于卖家首次选校，当前学校尤其不能倒推其发布归属。
- 面交地点不能作为学校证据。
- 买家、收藏者或聊天参与者学校不能决定商品学校。
- 旧自由文本 `campus` 不是权威学校 ID，并且出现 17 条冲突候选。
- 没有可靠证据的商品不能绑定默认学校。
- 任何迁移规则都必须由后续明确批准，并经过人工抽样。

## 8. 正式数据与测试数据边界

按仅用于盘点的标题模式识别：

| 指标 | 数量 |
| --- | ---: |
| 可识别测试商品候选 | 14 |
| 其中软删除候选 | 2 |
| 其中无学校候选 | 12 |
| 相关会话候选 | 8 |
| 相关预约候选 | 12 |
| 无法按测试模式分类的商品 | 23 |

模式只能说明“疑似测试/验收数据”，不能证明可删除。测试候选已经被会话和预约引用，存在明显误删风险。后续人工确认至少要核对数据用途、商品状态、有效预约、会话/消息历史和媒体引用，且不得仅按标题批量删除。

## 9. products 当前索引

真实 `listIndexes` 返回 11 项：

| 索引 | 字段与方向 | 唯一 | 当前用途 | 阶段 18 |
| --- | --- | --- | --- | --- |
| `_id_` | `_id ASC` | 是 | 主键、详情 | 继续使用 |
| `_openid_1` | `_openid ASC` | 否 | 系统字段 | 与市场查询无关 |
| `idx_status_createdAt_id` | `status ASC, createdAt DESC, _id ASC` | 否 | 最新 | 不能覆盖 schoolId 条件 |
| `idx_status_price_asc_createdAt_id` | `status ASC, price ASC, createdAt DESC, _id ASC` | 否 | 价格升序 | 不能覆盖 schoolId 条件 |
| `idx_status_price_desc_createdAt_id` | `status ASC, price DESC, createdAt DESC, _id ASC` | 否 | 价格降序 | 不能覆盖 schoolId 条件 |
| `idx_status_favorite_view_createdAt_id` | `status ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC` | 否 | 综合 | 不能覆盖 schoolId 条件 |
| `idx_status_category_createdAt_id` | `status ASC, categoryId ASC, createdAt DESC, _id ASC` | 否 | 分类最新 | 不能覆盖 schoolId 条件 |
| `idx_status_category_price_asc_createdAt_id` | `status ASC, categoryId ASC, price ASC, createdAt DESC, _id ASC` | 否 | 分类价格升序 | 不能覆盖 schoolId 条件 |
| `idx_status_category_price_desc_createdAt_id` | `status ASC, categoryId ASC, price DESC, createdAt DESC, _id ASC` | 否 | 分类价格降序 | 不能覆盖 schoolId 条件 |
| `idx_status_category_favorite_view_createdAt_id` | `status ASC, categoryId ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC` | 否 | 分类综合 | 不能覆盖 schoolId 条件 |
| `idx_sellerOpenid_status_createdAt_id` | `sellerOpenid ASC, status ASC, createdAt DESC, _id ASC` | 否 | 本人/卖家商品 | 继续用于所有者历史 |

真实现有组合索引均使用 `_id` 收尾，证明当前云数据库允许 `_id` 作为组合索引字段。

阶段 18 候选最小索引以真实查询为准：

```text
schoolId, status, createdAt, _id
schoolId, status, price, createdAt, _id（升/降各一）
schoolId, status, favoriteCount, viewCount, createdAt, _id
```

分类查询可能需要对应增加 `categoryId` 的四项组合。关键词正则能否利用组合索引必须单独实测查询计划，不能仅凭索引名称断言。迁移和灰度期间不得删除现有索引。本轮没有创建任何索引。

## 10. 阶段 18 候选服务端设计

### 10.1 可信学校上下文

候选流程：

```text
cloud.getWXContext()
→ APPID + OPENID 计算确定性用户 ID
→ 读取 users 并核对内部 openid
→ 校验 active、profileCompleted
→ 校验 users.schoolId 格式
→ 读取 schools 权威记录
→ 校验 active + valid + 权威名称
→ 生成仅服务端使用的 marketSchoolContext
```

应抽取阶段 16/17 已使用的学校规范和错误映射为云函数可复用模块，避免 `authUser/createProduct/productQuery` 出现三套分叉规则。客户端不得提交可信 `schoolId`。

### 10.2 用户状态候选规则

- 匿名：保留首页壳，不请求普通市场，展示登录/选校引导；不是网络错误。
- 已登录未选校：保留页面壳，进入现有选校流程。
- 学校不可用：不查询市场，复用现有受控重选。
- 正常用户：只查询服务端解析出的当前学校。
- 商品详情：本阶段候选不修改合法 ID 的现有访问规则。

当前真实实现仍允许匿名调用 `list` 并读取全市场；上述仅为候选，尚未实现。

### 10.3 稳定游标

候选游标应绑定：

```text
version
scopeSchoolId
action
categoryId
normalizedKeywordDigest
sortBy
statuses
最后记录的全部排序字段
最后商品 ID
```

- 推荐服务端签名或使用不可伪造的编码摘要。
- 学校、action、分类、关键词、排序或状态不匹配时拒绝游标。
- 学校变化时清空列表并创建新作用域。
- 非法/过期游标返回稳定参数错误，不回退到全市场。
- 用“完整排序字段 + _id”的 seek 条件替代 `skip`，减少新增和状态变化造成的重复/漏项。

## 11. 阶段 18 方案比较

| 方案 | 安全性 | 用户体验与数据影响 | 工程复杂度 | 索引 | 迁移 | 开关 |
| --- | --- | --- | --- | --- | --- | --- |
| A 严格立即隔离 | 学校边界最直接 | 95.45% 公共商品消失，仅剩 1 条；有效预约商品退出列表 | 中 | 需要 | 不要求，但影响巨大 | 强烈建议 |
| B 先迁移后启用 | 迁移审批充分时较高 | 可保留更多库存，但本批 A 类强证据为 0，自动迁移风险高 | 高 | 需要 | 需要 22B | 建议 |
| C 双轨灰度、默认关闭 | 在不开启时保持现状；可先验证新学校作用域 | 旧市场暂不突变，新校市场可受控验证；需防止开关误放行 | 高 | 需要 | 可分批、非前置全量 | 必须 |

不得将方案 C 理解为“无学校商品在严格校园市场继续可见”。它只允许在正式切换前保留现有市场，并让受控账号/环境验证学校作用域查询。

## 12. 推荐方案

推荐暂不实施严格立即隔离，采用“C 双轨灰度准备 + B 的人工迁移审批”，但本轮不执行：

1. 先处理 1 条有效预约依赖，确保交易关系不因市场切换被破坏。
2. 人工确认 14 条测试候选，不能按标题自动删除。
3. 对 B/C 类历史商品制定人工抽样和明确归属规则；当前没有 A 类可自动迁移候选。
4. 阶段 18 代码、稳定游标和最小索引可以在后续授权后开发，但严格开关默认关闭。
5. 只有当同校 `available/reserved` 库存、预约/会话影响和回滚方案达到用户接受标准后，才考虑切换。

依据是：公共商品 22 条中 21 条无权威学校；当前 active 学校库存仅 1 条 available；有 1 条有效预约、16 条近期会话和 131 条消息依赖无学校商品；现有偏移分页与索引都未包含学校作用域。

## 13. 只读工具

新增：

```text
scripts/phase-22a-school-data-audit.js
scripts/verify-phase-22a.js
```

命令：

```powershell
npm run phase-22a:verify
node scripts/phase-22a-school-data-audit.js --describe-target
node scripts/phase-22a-school-data-audit.js `
  --confirm-target "cloud1***6d8e" `
  --output "<SYSTEM_TEMP>/phase-22a-school-data-audit.json"
```

安全边界：

- 默认 `npm run school-data-audit:dry-run` 不带确认参数会在触库前返回 `TARGET_ENV_CONFIRMATION_REQUIRED`。
- 目标确认只接受当前私有配置生成的精确掩码。
- 数据库命令构造器只允许 `QUERY` 和 `COMMAND/listIndexes`。
- 没有插入、更新、删除、事务或迁移参数。
- 输出只包含聚合、索引和摘要哈希。
- 临时 JSON 保存于系统临时目录，不进入项目和 Git。

## 14. 无写入证明

运行前后：

| 集合 | 运行前 | 运行后 |
| --- | ---: | ---: |
| users | 7 | 7 |
| products | 37 | 37 |
| favorites | 5 | 5 |
| conversations | 16 | 16 |
| messages | 131 | 131 |
| appointments | 19 | 19 |
| productViews | 14 | 14 |
| schools | 2952 | 2952 |

结论：

- 8 个集合计数完全一致。
- 本次读取投影的 8 组 SHA-256 摘要运行前后完全一致。
- 审计脚本未调用写入 API。
- 未执行事务。
- 未部署云函数。
- 未创建、删除或修改索引。
- 未修改权限。
- 未修改学校状态。
- 未修改用户或商品。

证明边界：这能证明脚本没有写入路径，且两次读取之间本次投影未变化；不能排除其他并发主体在未投影字段上发生写入，因此不夸大为云端绝对无任何外部变化。

## 15. 本轮修改文件

- `scripts/phase-22a-school-data-audit.js`
- `scripts/verify-phase-22a.js`
- `docs/phase-22a-school-data-audit.md`
- `package.json`
- 本地被忽略的 `00-项目总交接文档.md`（仅记录重要门禁结论）

本轮未修改小程序业务页面、业务 Service 或业务云函数。

## 16. 明确未执行

- 未实施首页同校查询。
- 未实施搜索同校查询。
- 未修改分页。
- 未修改商品详情。
- 未修改收藏。
- 未修改聊天。
- 未修改预约。
- 未实施学校切换。
- 未执行 22B 迁移。
- 未创建索引。
- 未修改数据库权限。
- 未部署云函数。
- 未创建集合或测试数据。
- 未删除任何数据。
- 未 commit。
- 未 push。
- 未创建或移动标签。

## 17. 等待用户确认

1. 是否接受阶段 18 暂不立即严格启用。
2. 是否先人工核对当前 1 条有效预约所依赖的无学校商品。
3. 是否对 14 条测试数据候选做人工归类；哪些记录仅归档，哪些允许后续清理。
4. 是否允许为 B/C 类商品制定人工归属流程；当前不得自动使用卖家现学校。
5. 是否选择“双轨灰度、严格开关默认关闭”。
6. 是否授权后续创建阶段 18 的最小学校组合索引。
7. 是否授权后续修改并部署 `productQuery`。
8. 是否以及何时启动阶段 18 正式实现。
