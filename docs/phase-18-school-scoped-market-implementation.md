# 阶段 18 同校市场双轨实现、默认关闭部署与 legacy 验证

> 日期：2026-07-29
> 稳定基线：`c1cf7a64d47406d490527c1f5f0597f528976508`（`phase-17-complete`）
> 当前状态：第一轮代码和本地逻辑验证、第二轮 8 个索引、HMAC 配置、默认关闭部署及真实 legacy 回归均已完成；真实灰度和正式切换未执行

## 1. 实现范围

本轮在不改变阶段 17 稳定基线和真实数据的前提下，完成：

- `productQuery/list` 的 `legacy_market` / `school_scoped_market` 服务端双轨；
- 默认关闭、空名单的 G4 服务端固定灰度入口；
- 以 `APPID + OPENID` 生成确定性内部用户 ID，并从 `users`、`schools` 解析权威学校；
- 严格模式固定学校与公开状态条件；
- 绑定学校、查询参数、排序、页大小和快照的 HMAC 签名 seek cursor；
- 首页与 ProductService 的双模式响应适配、作用域变化清理、请求竞态保护和引导状态；
- Phase 18 专项验证及项目总验证接入。

## 2. 未实现范围

第一轮没有创建或删除索引，没有修改数据库权限、集合配置或真实数据，没有部署任何云函数。第二轮按 `83.md` 授权，只为 `products` 新增并反查 8 个非唯一复合索引、安全配置 `productQuery` 游标 HMAC 环境变量，并只部署默认关闭版本的 `productQuery`；没有修改数据库权限或业务数据。两轮均未填写真实灰度账号，没有执行阶段 22B、学校切换或正式市场切换。商品详情、`myProducts`、收藏、会话、聊天和预约权限均不在代码修改范围内。

## 3. 双轨架构

服务端内部模式为：

```text
legacy_market
school_scoped_market
```

对外响应模式为：

```text
legacy
schoolScoped
```

单次 `list` 请求只执行其中一条路径，不会并行查询后拼接。旧模式继续使用原 `count + skip + limit`；严格模式不计算总数，以 `pageSize + 1`、`hasMore` 和 `nextCursor` 驱动 seek 分页。

客户端只根据上一份服务端响应决定下一页应携带 `page` 还是 `cursor`。首次请求时客户端尚不知道服务端模式，会发送旧式 `page`；严格服务端忽略该字段并返回 `schoolScoped` 响应，后续页才发送游标。客户端从不提交 `marketMode`、`schoolId` 或灰度身份到云函数。

## 4. 模式决策

决策顺序：

```text
getWXContext
→ APPID / OPENID
→ 确定性内部 userId
→ 服务端总开关
→ strict-for-all 受控测试开关
→ 服务端固定 allowlist
→ legacy_market 或 school_scoped_market
```

业务请求中的 `marketMode`、`schoolId`、`schoolName`、`rolloutEnabled` 和 `allowlistUserId` 不参与决策。严格路径出现任何身份、学校、游标、密钥、查询或索引错误时直接失败，不会调用旧市场。

## 5. 灰度默认值

生产代码默认值：

```js
SCHOOL_SCOPED_MARKET_ENABLED = false
SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL = false
SCHOOL_SCOPED_MARKET_ALLOWLIST = []
```

因此当前所有请求仍走 legacy。测试通过依赖注入开启虚拟严格模式、虚拟用户和测试密钥；不存在公开业务参数测试后门。真实 OPENID、真实内部用户 ID 和生产 HMAC 密钥均未写入仓库。

## 6. 学校上下文

严格模式从 `cloud.getWXContext()` 获取 `APPID / OPENID`，按与阶段 16、17 一致的哈希规则生成内部用户 ID，然后校验：

1. 用户存在；
2. 用户 `status = active`；
3. 用户记录 `openid` 与当前微信身份一致；
4. `profileCompleted = true`，且昵称、头像有效；
5. `schoolId` 格式有效；
6. 学校存在；
7. 学校 `platformStatus = active`；
8. 学校 `officialStatus = valid`；
9. 学校权威名称非空。

成功后只生成服务端 `marketSchoolContext = { userId, schoolId, schoolName }`。稳定错误码包括 `AUTH_REQUIRED`、`USER_NOT_FOUND`、`USER_INACTIVE`、`PROFILE_INCOMPLETE`、`SCHOOL_REQUIRED`、`SCHOOL_INVALID`、`SCHOOL_UNAVAILABLE` 和 `SCHOOL_CONTEXT_MISMATCH`。

## 7. 服务端查询

严格模式固定条件：

```text
schoolId = 服务端权威 schoolId
status IN [available, reserved]
createdAt <= snapshotAt
```

它继续支持已有分类、最多 40 字关键词、最多 5 个搜索词、转义正则、四种排序、1—20 的 `pageSize` 和公开 DTO。历史无学校商品、其他学校商品以及客户端伪造学校均不会进入结果。

严格模式不执行 `count`、`skip` 或全市场前端过滤。查询/索引错误返回失败；没有移除学校条件重试的代码路径。

## 8. 游标协议

游标格式：

```text
base64url(JSON payload) + "." + base64url(HMAC-SHA256)
```

载荷固定字段：

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

关键词不会明文进入游标；摘要为规范化小写关键词 token 与分类边界的 SHA-256。载荷采用精确字段白名单，校验字段类型、学校/商品 ID、ISO 时间、排序值、页大小、状态集合和版本；游标最大 4096 字符、JSON 最大 2048 字节、有效期 24 小时、未来时间容差 5 分钟。

HMAC 密钥仅从 `PRODUCT_QUERY_CURSOR_HMAC_SECRET` 或本地测试依赖注入读取，要求至少 32 字符。签名使用恒定时间比较；生产密钥缺失时严格模式返回 `CURSOR_SECRET_UNAVAILABLE`，不会生成无签名游标或回退 legacy。

## 9. seek 条件

统一以 `_id ASC` 作为最后稳定分界：

- 综合：`favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC`；
- 最新：`createdAt DESC, _id ASC`；
- 价格升序：`price ASC, createdAt DESC, _id ASC`；
- 价格降序：`price DESC, createdAt DESC, _id ASC`。

下一页分别使用词典序 OR 条件：

```text
综合：
favoriteCount < F
OR favoriteCount = F AND viewCount < V
OR favoriteCount = F AND viewCount = V AND createdAt < T
OR favoriteCount = F AND viewCount = V AND createdAt = T AND _id > I

最新：
createdAt < T
OR createdAt = T AND _id > I

价格升序：
price > P
OR price = P AND createdAt < T
OR price = P AND createdAt = T AND _id > I

价格降序：
price < P
OR price = P AND createdAt < T
OR price = P AND createdAt = T AND _id > I
```

本地内存查询桩已验证逻辑和排序结果。第二轮已在真实 `products` 集合创建并反查候选索引，但总开关保持关闭，因此没有让普通用户进入 strict 路径，也没有声称已经验证真实复杂 OR seek、严格复合排序、正则搜索索引选择或跨校隔离。

## 10. 客户端状态

ProductService 统一返回：

```text
list, marketMode, scope, nextCursor, hasMore, page, pageSize, total
```

严格模式的 `page / total` 为 `null`，不会伪造总数；旧模式保留实际值。为支持先部署客户端再部署云函数，旧服务端缺少 `marketMode` 时，仅在同时具备历史 `total + page` 结构且没有 `nextCursor` 时识别为 legacy。

首页新增 `marketMode`、`marketScope`、`nextCursor` 和 `queryScopeKey`。关键词、分类、排序、下拉刷新、登录/用户学校状态、服务端模式或学校作用域变化都会使列表、页码、游标、总数、更多状态和旧请求窗口失效。`requestVersion` 与查询字段/作用域检查共同阻止旧响应拼接，商品 ID 去重仅作为最后保护。

## 11. 匿名和无学校行为

默认总开关关闭时，服务端匿名 `list` 继续走 legacy，不破坏原匿名 API 行为。严格正式模式的页面结构支持以下 fail-closed 状态：

- 匿名：保留首页壳并引导登录；
- 资料未完成：引导完善资料；
- 已登录未选校：引导选校；
- 学校不可用或身份不匹配：引导受控重选/重新登录；
- 正常用户：只显示权威学校市场。

这些状态不会被包装成空市场或网络错误，也不会查询全市场。

## 12. 失败策略

严格路径的身份、用户、学校、HMAC、游标、数据库和索引错误均原样收敛为稳定失败。客户端不发起第二次 legacy 请求；加载更多失败保留当前列表，首屏严格上下文错误转为明确引导。

以下游标不一致统一返回 `INVALID_CURSOR_SCOPE`：版本、签名、模式、学校、action、分类、关键词摘要、排序、状态、页大小、快照、排序值、商品 ID 或字段集合不匹配。非法游标不会回第一页、不会被忽略、不会换学校重建。

## 13. 测试结果

新增 `npm run phase-18:verify`，当前覆盖 91 项，包含：

- 7 类模式决策与客户端伪造隔离；
- 用户和学校上下文成功/失败；
- 两校商品隔离、无学校商品排除；
- 游标 HMAC、篡改、额外字段、查询/学校/页大小绑定与过期；
- 四种 seek 排序、多页无重复、首屏快照边界；
- 密钥缺失、查询错误不回退；
- legacy 匿名、分类、搜索、排序、偏移分页和返回结构；
- ProductService 请求形状、响应规范化、无自动重试；
- 首页作用域状态、筛选/刷新游标清理、竞态与引导静态约束；
- `detail` 与 `myProducts` 路由未改变的回归边界。

最终本地结果：

- `npm run phase-22a:verify`：6 组通过；
- `npm run phase-18-orphan-review:verify`：7 组通过；
- `npm run phase-18-orphan-fix:verify`：8 组通过；
- `npm run phase-18-preflight:verify`：10 组通过；
- `npm run phase-18:verify`：91 项通过；
- `node scripts/verify-product-school-binding.js`：51 项通过；
- `npm run verify`：80 项通过；
- 96 个 JavaScript 语法检查和 67 个 JSON 解析检查通过；
- `market-core` 直接加载、`productQuery` 测试桩加载和 `git diff --check` 通过。

上述整套验证在第二轮部署前、部署后均执行并通过。部署后另完成真实云函数/API 与微信开发者工具回归：匿名和登录 list、四排序两页、分类、关键词、无结果、清空搜索、刷新、加载更多、详情和“我的发布”均保持 legacy；首页运行时未发现新增未处理异常。

## 14. 候选索引清单

以下 8 项均为 `products` 集合的非唯一复合索引，方向必须与查询排序一致：

| # | 名称 | 字段与方向 | 唯一性 | 真实反查状态 |
|---|---|---|---|---|
| 1 | `idx_school_status_createdAt_id` | `schoolId ASC, status ASC, createdAt DESC, _id ASC` | 非唯一 | 已列出、可用 |
| 2 | `idx_school_status_favorite_view_createdAt_id` | `schoolId ASC, status ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC` | 非唯一 | 已列出、可用 |
| 3 | `idx_school_status_price_asc_createdAt_id` | `schoolId ASC, status ASC, price ASC, createdAt DESC, _id ASC` | 非唯一 | 已列出、可用 |
| 4 | `idx_school_status_price_desc_createdAt_id` | `schoolId ASC, status ASC, price DESC, createdAt DESC, _id ASC` | 非唯一 | 已列出、可用 |
| 5 | `idx_school_status_category_createdAt_id` | `schoolId ASC, status ASC, categoryId ASC, createdAt DESC, _id ASC` | 非唯一 | 已列出、可用 |
| 6 | `idx_school_status_category_favorite_view_createdAt_id` | `schoolId ASC, status ASC, categoryId ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC` | 非唯一 | 已列出、可用 |
| 7 | `idx_school_status_category_price_asc_createdAt_id` | `schoolId ASC, status ASC, categoryId ASC, price ASC, createdAt DESC, _id ASC` | 非唯一 | 已列出、可用 |
| 8 | `idx_school_status_category_price_desc_createdAt_id` | `schoolId ASC, status ASC, categoryId ASC, price DESC, createdAt DESC, _id ASC` | 非唯一 | 已列出、可用 |

创建前真实索引数为 11，创建后和部署后独立反查均为 19；8 项名称、字段顺序和方向完全一致，没有同名冲突，原有 11 项索引全部保留。`listIndexes` 只列出已经完成构建并可使用的索引；返回项未设置 `unique: true`，因此均为非唯一。关键词正则与复杂 OR 仍可能影响索引选择，不能仅凭索引存在认定 strict 查询已经完成云端验收。

## 15. 部署清单

第二轮已完成以下部署准备和操作：

1. `products` 8 个候选索引已创建并两次反查；
2. `PRODUCT_QUERY_CURSOR_HMAC_SECRET` 已配置为长度合格的高熵值，密钥未写入仓库或本文；
3. 原 `PRODUCT_SEED_ENABLED` 环境变量被保留；
4. 只部署 `cloudfunctions/productQuery`；
5. 部署后函数为 `Active / Nodejs16.13 / index.main / 10 秒 / 256 MB`，平台修改时间为 `2026-07-29 21:46:43`；
6. 下载的线上 `index.js`、`market-core.js`、`package.json`、`package-lock.json` 与本地逐项哈希一致；
7. `SCHOOL_SCOPED_MARKET_ENABLED=false`、`SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL=false`、`SCHOOL_SCOPED_MARKET_ALLOWLIST=[]`；
8. 未发生 legacy 回归，不需要回滚。

下一轮必须在独立授权后准备第二所学校测试账号/商品、填入一个受控内部用户 ID 并执行 G4。任何 strict 查询失败仍不能以切回全市场作为请求级自动兜底。

## 16. 需要用户授权的操作

以下操作仍需分别授权：

- 接受阶段 18 第一、二轮结果；
- 填入受控灰度账号的确定性内部用户 ID；
- 准备第二所学校的测试账号和商品；
- 执行真实云端 G4 灰度验证；
- 灰度验收后决定是否扩大名单或正式切换；
- 阶段 22B、历史商品学校迁移和后续阶段开发。

## 17. 剩余风险

- 复杂 OR seek、strict 复合排序与正则搜索仍只有逻辑级本地验证，尚无真实微信云数据库 strict 请求结果；
- 8 个复合索引已创建并可用，但尚未通过真实 strict 查询证明具体执行计划、扫描量和延迟；
- HMAC 已安全配置，但尚未通过真实 strict 游标请求验证云端签名、续页、过期和篡改拒绝链路；
- 固定灰度名单为空，未验证真实微信身份到 allowlist 的全链路；
- 第二所学校尚缺真实测试账号或商品；
- 正则搜索的索引利用率、扫描量和延迟尚未验证；
- 微信开发者工具已完成页面状态和交互自动化，但截图接口超时，未完成本轮视觉截图复核；未登录 UI 因当前工具账号为已登录用户而未切换，真机也未执行；
- `wx-server-sdk@4.0.2` 的生产依赖审计仍报告 1 个 moderate、5 个 high 风险，第二轮未擅自升级依赖；
- `snapshotAt` 不是事务快照，分页期间价格、计数、状态或旧商品时间变更仍可能影响排序窗口，客户端继续按商品 ID 去重；
- 固定 24 小时游标有效期和 5 分钟时钟容差需要在云端时钟环境确认；
- 正式切换、历史无学校商品退出普通市场及回滚窗口仍需另行授权和验收。

## 18. 第二轮真实云端与 legacy 回归记录

目标环境公开脱敏为 `cloud1***6d8e`。`products` 权限通过 `DescribeDatabaseACL` 只读反查为 `ADMINONLY`，本轮没有修改集合权限、业务数据或原有索引。HMAC 只记录“存在且长度合格”，不保存值或可逆摘要。

真实匿名 API 回归覆盖：公开 `available/reserved`、旧式 `page + pageSize`、四排序各两页、分类、正向关键词、无结果、清空关键词、详情、匿名 `myProducts` 拒绝和非法 action；全部符合预期。业务参数伪造 `marketMode`、`schoolId`、`schoolName`、`rolloutEnabled` 和 allowlist 身份仍返回 `legacy`，scope 为空且没有 strict 错误。

微信开发者工具使用已有真实登录态完成：首页首次加载、加载更多、刷新、四排序、数字分类、正向/空结果/清空搜索、商品卡片进入详情和“我的发布”；list 与 `myProducts` 的真实云调用均成功，页面 `viewState=success`，控制台新增 warning/error 和运行时异常均为 0。空列表状态已验证；网络错误显示、未登录 UI、视觉截图和真机本轮未执行，不据此声称通过。

本轮没有开启总开关、strict-for-all 或 allowlist，没有修改客户端灰度配置，没有让任何普通真实用户进入 `schoolScoped`，也没有执行阶段 22B、commit、push 或标签操作。

## 19. 第三轮受控修改学校更新（2026-08-01）

第三轮已新增服务端 `authUser/updateSchool`、个人页修改学校入口、change 模式权威学校选择、二次确认、AuthStore 缓存替换和并发/过期结果保护。用户换校只更新本人用户摘要，不修改历史商品；新商品仍由 `createProduct` 根据服务端当前学校绑定。

本轮只部署 `authUser`，线上/本地入口哈希一致。微信开发者工具使用真实登录态完成换校、取消、同校无写入、重启恢复、首页 legacy 重载、A/B 商品归属和 `myProducts` 跨校历史展示；最终准备一件 A 校和一件 B 校明确测试商品。真机未执行。

`SCHOOL_SCOPED_MARKET_ENABLED=false`、strict-for-all 关闭、allowlist 为空；没有执行真实 strict、阶段 22B、权限/索引变更、商品迁校、commit、push 或标签操作。完整设计、脱敏数据和验收记录见 `docs/phase-18-school-change-implementation.md`。下一轮调整为“第十八阶段正式开发第四轮：单账号受控灰度与真实同校/跨校商品隔离验证”，必须取得新授权后才能开始。

## 20. 第四轮单账号受控灰度更新（2026-08-06）

第四轮补齐 A 校 12 件公开 + 1 件 offline、B 校 5 件公开 + 1 件 offline、1 件无学校历史的专用夹具；全部先经真实 `createProduct` 验证服务端权威绑定，再只对精确夹具构造排序和状态边界。总开关已开启，strict-for-all 保持关闭，固定 allowlist 仅 1 个受控内部用户。

只重新部署 `productQuery`，线上/本地入口 SHA-256 为 `e1e71e01e94666815c552b7b7fa4fd9f7b62c095b8a4c0e37a311357f8c9f381`；HMAC 与 `PRODUCT_SEED_ENABLED` 原样保留，19 个索引及 `ADMINONLY` 权限未变。真实 DevTools 完成 A/B 隔离、四排序、关键词/分类多页、游标篡改和跨校拒绝、B→A→B UI 换校、首页刷新、详情、我的发布与重启恢复，无 console error/exception。

最终保留单账号灰度。没有第二微信身份，灰度后的真实匿名/非 allowlist 登录未执行，只完成模式决策与伪造参数自动验证；真机也未执行。完整脱敏记录见 `docs/phase-18-school-scoped-canary-validation.md`。

## 21. 第五轮最终就绪审查（2026-08-07）

用户确认第四轮人工验收通过，但第五轮只读审计证明尚不能正式切换：7 个 active 用户只有 3 个具备有效学校；排除 20 件专用灰度夹具后，28 件公开业务商品只有 8 件具备有效学校，20 件仍不满足 strict，严格就绪率仅 28.5714%。因此继续保持总开关 `true`、strict-for-all `false`、allowlist 1 人，不扩大灰度。

20 件灰度夹具已按精确私密清单收口为全部 offline，未删除、未改学校，重复执行为 0 变更。`myProducts` 继续跨学校返回历史商品，卡片新增商品发布校园或“历史商品：未标校园”提示。真实匿名/非名单身份和真机因没有第二账号/设备明确记为未执行；自动模式决策不能冒充真实身份验收。

当前 `strictForAll=true` 会使匿名请求进入 strict 后因无用户学校而 fail-closed。正式切换前必须明确匿名市场是强制登录还是继续 legacy，并相应调整模式决策。完整门禁、切换/回滚方案、依赖审计和测试记录见 `docs/phase-18-final-readiness-review.md`。第十八阶段未完成，未部署、未提交、未推送、未创建或移动标签。

## 22. 第五轮修复：强制登录与迁移就绪（2026-08-07）

正式产品决策确定为市场强制登录。新增 `MARKET_ACCESS_REQUIRES_AUTH=true` 策略层，在 rollout 模式决策前主动校验微信身份、资料和权威学校；匿名为 `AUTH_REQUIRED`，资料或学校异常 fail-closed。当前非 allowlist 的完整登录用户迁移期仍为 legacy，allowlist 1 人 strict，strict-for-all 继续关闭。

4 个缺学校 active 用户和 20 件缺学校公开业务商品已经按项目所有者授权统一迁移至上海工程技术大学。迁移后 users 为 7/7 就绪，公开业务商品为 28/28 strict-ready。`productQuery` 已重新部署且线上/本地哈希一致；真实 DevTools 在目标学校看到全部 20 件迁移商品，四排序、分页、分类、搜索和重启通过。

回滚计划新增关闭认证市场策略，目标为 false/false/auth-off/空 allowlist。当前可以进入最终切换评审，但本轮仍未扩大灰度、开启 strict-for-all、删除 legacy 或 Git 封版。详见 `docs/phase-18-data-migration-and-auth-market.md`。

## 23. 正式全量切换补记（2026-08-09）

后续最终轮已补齐第二真实账号、双校真机、全量 strict、真实 legacy 回滚及恢复。生产最终配置为 `enabled=true / strictForAll=true / allowlist=[] / accessRequiresAuth=true`，只部署 `productQuery`，线上/本地 SHA-256 为 `3a2b960ce1c59102f470a7161d263a2c86f7089d27bed3a5c2e0c3d3d753cb89`。前文关于“尚未真实 strict”的内容是历史轮次记录，当前结论以 `docs/phase-18-final-cutover.md` 为准。
