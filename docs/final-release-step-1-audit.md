# Final Release Step 1 — Full Project Read-Only Audit

- 审计日期：2026-08-25（Asia/Shanghai）
- 审计范围：当前 `main`、客户端、全部 production 云函数、production 数据库/索引/ACL、学校 XLS/JSON、现有自动验证与依赖安全
- 审计原则：只读；未导入学校、未删除商品、未修改 production 数据/ACL/索引/云函数/maintenance、未发布客户端、未实现反馈、未提交或推送 Git
- 最终结论：**NOT READY — BLOCKERS FOUND**

> 本结论针对“正式提交微信审核/发布”的发布门禁。Step 2 应先处理本文列出的数据清理范围与依赖安全门禁，不能直接进入发布。

## A. Release baseline

| 项目 | 审计结果 |
| --- | --- |
| Branch | `main` |
| HEAD / `origin/main` | `b4242a7ae17c094753605d06b6444daf172ce28d`，完全一致 |
| Ahead / behind | `0 / 0` |
| 最新 UX hotfix | `b4242a7` — `fix: simplify chat delete and recall interactions` |
| `phase-25-complete` | annotated tag object `f0d5fd7...`，peeled commit `4967995d1ca20f0fef8050b91864721dddafbab5` |
| Phase 25 commit | `4967995` — `feat: complete phase 25 message lifecycle rollout` |
| AppID | `wx5e54***418c`（来自被 Git 忽略的 private config） |
| Active cloud | `[ENV] PRODUCTION`，`cloud1***6d8e` |
| Production / staging | 两个目标 ID 明确不同，active target 与 production 一致 |
| 客户端基础库 | tracked `project.config.json` 为 `3.7.3`；本机 private override 为 `3.16.2` |
| Production 云函数 | 12/12 `Active`、12/12 `Available`、handler 均为 `index.main` |
| 审计后状态 | 仅新增本报告；无业务代码或 production 状态修改 |

## B. Git state

- 审计开始时工作区 clean，无 staged、modified 或 untracked 文件。
- `HEAD == origin/main`，`git rev-list --left-right --count HEAD...origin/main` 为 `0 0`。
- `git diff --check` 通过。
- private cloud target、secret 文件和 `project.private.config.json` 均被 `.gitignore` 覆盖；tracked config 只保留 placeholder/example。
- tracked `project.config.json` 的 AppID 为 placeholder，真实 AppID 依赖本机 private config。隔离正确，但构建可复现性依赖发布机 private 配置；正式提交前应再次执行 production preflight。

## C. Production environment

Production preflight 结果：

```text
[ENV] PRODUCTION
environmentId cloud1***6d8e
appId wx5e54***418c
write false
activeTargetMatches true
targetsDistinct true
```

- production/staging 目标明确隔离，当前 active target 是 production。
- 本轮只使用 `QUERY`、collection/index/ACL/function detail 等只读 API；没有调用 production 业务写 action。
- 12 个函数均为 10 秒 timeout、256 MB memory、512 MB disk、dependency install 开启、public network 为 `ENABLE`。
- 远端 12 个函数 `index.js` SHA-256 均与当前本地文件一致；Phase 25 四函数的完整哈希也与封存记录一致。
- production diagnostic 环境角色未设置；message diagnostic 仅允许 `staging/development`，生产不会返回诊断 UI 数据。
- 环境变量值未输出。11 个函数为无变量空指纹 `4f53cda18c2b...`；`productQuery` 仅记录到变量键 `PRODUCT_QUERY_CURSOR_HMAC_SECRET`、`PRODUCT_SEED_ENABLED`，脱敏指纹 `506c789e01ed...`。现有测试确认 seed action 已禁用。

## D. Full feature matrix

所有业务集合 ACL 均为 `ADMINONLY`，客户端经 service 调用云函数，不直接读写数据库。

| Feature / flow | Client page / module | Service | Cloud function | Collection / storage | 权限与结论 |
| --- | --- | --- | --- | --- | --- |
| 冷启动、session restore | `app.js`, `store/auth-store.js` | `auth-service`, `cloud-service` | `authUser.current` | `users` | 服务端 OPENID；失败不阻塞启动，但顶层 silent catch 降低可观测性 |
| 登录、资料确认 | `pages/login`, `pages/profile-edit` | `auth-service`, `avatar-service` | `authUser.login/updateProfile` | `users`, storage | 服务端身份、字段白名单；头像路径按用户隔离 |
| 首页、商品列表、搜索、分类、排序 | `pages/home`, product card/search/category components | `product-service` | `productQuery.list` | `products`, `users`, `schools` | school-scoped seek cursor；有对应复合索引 |
| 学校选择 | `pages/school-select` | `school-service` | `schoolQuery.list/search/detail`; `authUser.selectSchool` | `schools`, `users` | active+valid 过滤；当前客户端只消费首 20 条，未消费 cursor |
| 学校切换、7 天 cooldown | `pages/school-select`, profile | `auth-service`, `auth-guard` | `authUser.updateSchool` | `users`, `schools` | transaction + server clock；商品学校不随用户迁移 |
| 商品详情 | `pages/product-detail` | `product-service` | `productQuery.detail` | `products`, `users`, `schools` | 跨校只读，关系创建受服务端 school 边界限制 |
| 发布商品 | `pages/publish` | `product-form-service`, `product-publish-service` | `createProduct` | `users`, `schools`, `products`, storage | 服务端取 OPENID/APPID，requestId 幂等，上传失败有清理策略 |
| 编辑、下架、重新上架、软删除 | `pages/product-edit`, `pages/my-products` | `product-edit-service`, `my-products-service` | `manageProduct` | `products`, `schools`, storage | seller ownership、version、mutationId、transaction |
| 收藏 | `pages/product-detail`, `pages/favorites` | `favorite-service` | `favoriteProduct` | `favorites`, `products`, `users` | deterministic relation、transaction、跨校/本人商品限制 |
| 卖家主页 | `pages/user-profile` | `public-user-service` | `userQuery.publicProfile/publicProducts` | `users`, `products`, `schools` | public user ID 与响应白名单；列表仍使用 page/skip |
| 消息列表、会话摘要、未读 | `pages/messages` | `message-service` | `messageQuery.listConversations`; `messageAction.markConversationRead/hideConversation` | `conversations`, `messages`, `users`, `products`, `systemConfig` | participant scoped；cursor + alias resolution |
| 聊天、文本/图片/语音/位置/商品 | `pages/chat`, `pages/location-picker`, `pages/chat-product-picker` | `message-service`, `chat-media-service`, `location-service` | `messageAction.sendMessage`; `messageQuery.listMessages` | `messages`, `conversations`, `products`, `users`, storage | server sender、deterministic message ID、clientMessageId unique |
| delete-for-me / recall | `pages/chat` | `message-service` | `messageAction.deleteMessageForMe/recallMessage` | `messages`, `conversations`, `systemConfig` | participant/owner 限制，服务端时间，原 payload 投影剥离 |
| forward | `pages/message-forward` | `message-service` | `messageAction.forwardMessage` | `messages`, `conversations` | 从服务端安全源复制，不信任客户端原消息体 |
| hide conversation / new activity restore | `pages/messages`, `pages/chat` | `message-service` | `messageAction.hideConversation`; `messageQuery` | `conversations`, `messages` | activity snapshot + bounded exact-conflict retry |
| 预约创建/状态流转/列表/详情 | `pages/appointment-create`, `appointment-detail`, `appointments`, chat | `appointment-service` | `appointmentAction`, `appointmentQuery` | `appointments`, `conversations`, `messages`, `products`, `users`, `systemConfig` | participant、seller-only completion、唯一 activeKey、幂等键 |
| 我的、退出登录 | `pages/profile` | `auth-guard`, `auth-store` | `authUser.current`；logout 为本地 session 清理 | `users` | 显式 logout flag，冷启动恢复已覆盖 |
| 空状态、loading、网络错误 | 全页面 + `empty-state`, `loading-state` | service error mapping | 各查询函数 | — | 主要页面均有 loading/empty/error/retry；轮询错误当前静默保留旧数据 |

未发现“页面存在但无后端链路”的主流程。主要缺口是全国学校场景下客户端没有学校列表 cursor/province 浏览，以及反馈功能尚未存在（本轮按要求不实施）。

## E. Cloud function audit

### Production inventory

| Function | Runtime | Package size | Direct dependencies | Env keys | Remote = local | 主要风险 |
| --- | --- | ---: | --- | --- | --- | --- |
| `appointmentAction` | Nodejs18.15 | 7,444,434 B | `wx-server-sdk@4.0.2`, `ws@8.21.3` | 0 | yes | transaction hotspot；状态流转/系统消息多文档 |
| `appointmentQuery` | Nodejs18.15 | 7,436,779 B | same | 0 | yes | 每页最多 30，逐项 user+product enrichment |
| `authUser` | Nodejs16.13 | 7,391,140 B | `wx-server-sdk@4.0.2` | 0 | yes | Node 16 生命周期；用户/学校 transaction |
| `createProduct` | Nodejs16.13 | 7,434,013 B | SDK + `ws` | 0 | yes | Node 16；发布幂等与上传结果一致性 |
| `favoriteProduct` | Nodejs18.15 | 7,436,333 B | SDK + `ws` | 0 | yes | 商品 favoriteCount 热点；列表串行 N+1 |
| `manageProduct` | Nodejs16.13 | 7,439,162 B | SDK + `ws` | 0 | yes | Node 16；媒体清理是 transaction 后补偿 |
| `messageAction` | Nodejs18.15 | 7,453,683 B | SDK + `ws` | 0 | yes | 单会话 transaction 热点；bounded retry 已有 |
| `messageQuery` | Nodejs18.15 | 7,442,947 B | SDK + `ws` | 0 | yes | hidden 过滤最多 8 轮；会话 enrichment N+1 |
| `productQuery` | Nodejs16.13 | 7,439,704 B | SDK + `ws` | 2 | yes | Node 16；legacy 分支仍有 count+skip |
| `productViewAction` | Nodejs18.15 | 7,433,884 B | SDK + `ws` | 0 | yes | product viewCount 热点；无自动清理 trigger |
| `schoolQuery` | Nodejs18.15 | 7,434,264 B | SDK + `ws` | 0 | yes | server cursor 安全；prefix regex 依赖索引/查询计划 |
| `userQuery` | Nodejs18.15 | 7,433,059 B | SDK + `ws` | 0 | yes | public products count+skip，深页退化 |

共同配置：handler `index.main`、timeout 10 秒、memory 256 MB、dependency install `TRUE`、public network `ENABLE`、无 trigger。11 个函数声明了 `ws@8.21.3`，源码没有直接 `require('ws')`；现有验证把它视为运行时兼容依赖，不能未经 staging 验证直接移除。

### Static findings

- 没有无限循环；重试均有显式上限。Phase 25 hide/send race 为精确冲突、有限轮次重试。
- 写动作普遍使用 deterministic ID、request/mutation/idempotency key 或 transaction；未发现客户端身份字段被直接信任。
- `messageQuery.listConversations` 最多执行 8 轮双分支扫描来跳过隐藏会话；大量隐藏记录时单请求读放大。
- `favoriteProduct.listMyFavorites` 对最多 20 条关系串行读取 product，是明确的 N+1。
- `messageQuery` 与 `appointmentQuery` 对列表每项并发读取 user+product，页大小 30 时可形成约 60 次附加 point read。
- `userQuery.publicProducts`、favorite 列表和 legacy product 分支使用 page/skip，最大 offset 约 2,000；当前规模可用，大规模下会退化。
- 7.39–7.45 MB 远端包与统一依赖安装会增加冷启动面，历史低并发观测最大 2.33 秒；不能由此推导 capacity/QPS。
- 7 个函数带 `__test`/`_test` 本地导出，但 production handler 仍固定 `index.main`；unknown action 会被拒绝，未发现可从业务 action 进入测试入口。

## F. Database / index audit

快照时间：2026-08-25 19:21–19:22 CST。所有集合 ACL 均为 `ADMINONLY`。

| Collection | Count | Indexes | 主要 query path |
| --- | ---: | --- | --- |
| `users` | 8 | `_id_`(unique), `_openid_1` | deterministic user ID / OPENID |
| `products` | 72 | 20 个；含 status/category/price/favorite+view/createdAt，及 schoolId+status 系列和 seller+school+status | 首页 school-scoped seek cursor、卖家商品、状态管理 |
| `favorites` | 7 | 4 个；含 `userOpenid+productId` unique、`userOpenid+createdAt+_id` | 收藏状态/我的收藏 |
| `conversations` | 26 | 8 个；含 participant pair unique、product+participants unique、A/B+status+lastMessageAt | 消息列表、pair canonical、历史 alias |
| `messages` | 201 | 4 个；含 `conversationId+createdAt+_id`、`conversationId+senderOpenid+clientMessageId` unique | 聊天历史、发送幂等 |
| `appointments` | 23 | 11 个；含 buyer/seller/status/isDeleted、product pair active unique、initiator idempotency unique | 我的预约、状态流转、活动预约 |
| `productViews` | 27 | `_id_`, `_openid_1`, `cleanupAfter` | 观看窗口/后续清理 |
| `schools` | 2,952 | 5 个；officialCode unique、platformStatus+nameNormalized、platformStatus+province+nameNormalized | active list、prefix search、province filter |
| `systemConfig` | 1 | `_id_`(unique), `_openid_1` | maintenance / lifecycle availability by fixed ID |

Storage ACL 为 `READONLY`，无 custom rule；客户端上传通过云存储 API 的用户隔离路径，数据库写入仍由云函数授权。

## G. Data integrity

Fresh production read-only gates：

- Phase 25：6 个 active canonical conversation + 20 个 merged alias；pair key、alias target、schema、participant 均无异常。
- 201 条 message：orphan、非 participant sender、非法 type、recalled/delete-for-me malformed、system appointment mismatch 全部为 0。
- 23 条 appointment：conversation missing、非 active canonical、participant mismatch、product missing 全部为 0。
- active conversation latest summary 的 missing/mismatch/type/time/sender 异常全部为 0；unread 精确值无法仅靠静态快照完全证明。
- 当前 lifecycle 数据：4 条 recalled、4 条 delete-for-me、0 个 hidden conversation；最小安全 rollback floor 已强制。
- users、products、favorites/productViews pair 均无重复主键/关系；所检查 timestamp 字段 malformed 计数均为 0。
- 20 个 merged alias 的 legacy `productId` 已不存在，但 20/20 有 product snapshot fallback；active canonical 此项为 0，属于已知迁移历史而非当前 orphan blocker。
- 16 个 legacy product 没有 schoolId；它们均不在公开 available 集合（3 offline、11 sold、2 deleted），但仍有历史引用。
- **高风险数据缺陷：上海工程技术大学有 13 个 `available` product 的 `sellerId/sellerOpenid` 都无法解析到当前 `users`。`messageAction.createOrGetConversation` 明确要求 seller user 存在，因此这些商品可浏览但无法建立交易会话。**
- 其余主要关系 orphan 均为 0；两轮 Phase 22A 投影快照 hash/count 一致，证明审计自身未写数据。

## H. Product cleanup readiness

### Current product inventory

- 总数 72：available 32、offline 25、sold 12、deleted 3、reserved/draft 0。
- 有权威 schoolId 的商品 56；无 schoolId 的 legacy 商品 16。

| School | Exact schoolId | Products | Status | Existing references |
| --- | --- | ---: | --- | --- |
| 上海财经大学浙江学院 | `s_2639dd0d2bb01fb6a317e43e771a6f30` | 10 | available 2, offline 8 | favorites 0；conversations 1；direct product messages 2 / any context-card messages 10；appointments 1；views 3 |
| 上海工程技术大学 | `s_e5ca127017371b84bec8b1a67137b898` | 46 | available 30, offline 14, sold 1, deleted 1 | favorites 6；conversations 2；direct product messages 20 / any context-card messages 81；appointments 8；views 17 |
| 无 schoolId（legacy） | — | 16 | offline 3, sold 11, deleted 2 | favorites 1；conversations 3；related messages 54；appointments 14；views 7 |

两个 active school 的 56 个商品合计被 6 条 favorite relation、3 个 active conversation、90 条去重后的 message（direct/context/card 任一引用）、9 个 appointment、20 个 productView 引用。直接 hard delete 会造成 dangling relationship 或依赖 snapshot 的降级。

### Scope blocker

“清理两所大学商品”只会命中 56 条，**不会**使 `products` collection 变为 0；还会留下 16 条 no-school legacy product。Step 2 必须由 owner 明确授权目标是：

1. 公开市场 0 件（推荐）：将 32 个 available 商品受控 offline/soft-delete，保留被会话、消息、预约引用的历史 product/tombstone；或
2. 两所 active school 归属商品 0 件：选择性处理 56 条，明确接受 collection 仍有 16 条；或
3. 物理 collection 0 条：必须先设计 archive/tombstone 与全部引用迁移，不能直接 bulk hard delete。

### Recommended strategy

推荐 **selective cleanup + archive/offline**，不推荐直接 hard delete。必须遵守：

```text
snapshot
→ dry-run
→ expected delete/mutation count
→ relationship audit
→ explicit owner authorization
→ execute
→ post-delete audit
```

Step 2 dry-run 至少要把 72、56、16、32 四个计数分别列出；13 个无有效 seller 的 available fixture/legacy 商品必须进入清理范围。若 owner 坚持物理 0，需在 staging 验证 conversation/message/appointment 展示及历史详情后再批准 production 迁移。

## I. School source comparison

### XLS source

| Property | Result |
| --- | --- |
| Path | `list of universities.xls` |
| Exists / size | yes / 464,896 B |
| Format / encoding model | OLE Compound File / Excel 97-2003 BIFF；签名 `D0CF11E0A1B11AE1`；文本经 XLS parser 读取后做 Unicode NFKC |
| SHA-256 | `a0ceb41a15f335c0adfb2d0239137b879b1c58d1b57a322d3e1794866de7d09c` |
| Workbook | 1 sheet：`全国普通高等学校名单`；2,986 rows × 7 columns；header row 3；data rows 5–2,986 |
| Records | 2,952；31 个省级 section；expected/observed 数全部一致 |
| Fields | 序号、学校名称、学校标识码、主管部门、所在地、办学层次、备注；province 来自 section heading |
| Quality | excluded 0；formula 0；comment 0；duplicate ID/code/name 0；normalization error 0；missing required 0；P0/P1 0 |
| Distribution | 本科 1,412；专科 1,540；31 个省级地区 |

仓库 `scripts/schools/core.js` 记录该文件为教育部 2026 年附件原始来源（source version `截至2026年6月17日`），并保存 source page/download 元数据。本轮按要求未联网替换数据。

### Normalized JSON

| Property | Result |
| --- | --- |
| Path | `data/schools/generated/schools.normalized.json` |
| Exists / size | yes / 1,494,193 B |
| Encoding | UTF-8 JSON，无解析异常 |
| Records | 2,952 |
| Fields | `_id`, `officialCode`, `name`, `nameNormalized`, `province`, `city`, `educationLevel`, `authority`, `officialStatus`, `platformStatus`, `dataSource`, `sourceYear`, `sourceVersion`, `sourceRow`, `remark` |
| Deterministic ID | `s_` + SHA-256(`MOE:<officialCode>`) 前 32 hex |
| Quality | duplicate ID/code/name 0；empty required 0；malformed 0；normalization errors 0 |
| Normalized checksum | `cf69adbecbeda6d7de3150a8fc19616bd09c2d9cdc2d0fac5e90d55ae2a2fcd3` |

XLS 重新解析/规范化后的数组与 JSON stable JSON **逐条完全相等**：missing 0、extra 0、different 0。production 2,952 条学校的 14 个官方字段也与 JSON 逐条一致；production 仅在运营字段上把 2 所设为 active、2,950 所保持 pending。

**RECOMMENDED SCHOOL SOURCE：保留 XLS 作为不可变官方原始来源，使用经过仓库解析、校验、可复现生成的 `schools.normalized.json` 作为未来导入输入。** 不应手工编辑 JSON，也不应绕过 checksum/validation 直接导入 XLS。

## J. Nationwide school rollout readiness

Backend evidence is mostly safe：

- production 已有 2,952 个 school document，官方字段与 normalized JSON 一致；只开放 2 active。
- `schoolQuery` 只返回 active+valid，pageSize 最大 20，采用 `nameNormalized + _id` cursor，不会一次返回全国数据。
- search 为 name prefix 或 10 位 official code；可选 province filter。
- 已有 `platformStatus+nameNormalized+_id` 和 `platformStatus+province+nameNormalized+_id` 复合索引。
- product、favorite、新 conversation、新 appointment 都以服务端 authoritative user school 校验；学校切换 cooldown 为 server transaction；历史 relation 通过 snapshot/cross-school read-only 适配。

Client blocker for nationwide activation：

- `pages/school-select` 固定请求 20 条，丢弃 `nextCursor/hasMore`，没有 `onReachBottom` 或 province browser。全国 active 后，未搜索用户只能看到首 20 所；搜索是 prefix，不是任意 substring。
- 客户端当前没有一次下载 2,952 条，也没有全量 `setData` 或 O(n²) 全国扫描，因此**内存路径是安全的**；但可发现性/可选性不完整。

Step 3 推荐架构：server-side cursor pagination + prefix/code search + province/city filter；客户端仅保留当前页/有限分页窗口，debounce 并取消 stale response，绝不长期 setData 全国数组。应在 staging 将 2,952 所全部 active 的副本上验证低端机、首屏、分页、搜索、7 天 cooldown 和跨校历史关系。

## K. Client performance

### Findings

- 首页 pageSize 6、cursor load-more、300 ms search debounce、stale request version 和重复 ID merge 均存在；未发现一次加载全部商品。
- 学校页只 setData 20 条，规模安全，但缺分页功能。
- chat 每 8 秒重新拉 20 条最新消息，并随后调用 mark-read 和 active appointment refresh；每轮会重新 merge/sort 并把完整已加载 message window `setData`。
- chat timer、recorder listeners、audio context、search/return/success timers 在 hide/unload 路径均有清理；未发现确定的 listener/timer leak。
- 商品/聊天图片选择使用 `compressed`，单商品最多 6 图、单聊天选择最多 9 图，单图上限 10 MB；商品视频上限 50 MB/60 秒。
- 列表和聊天的 `<image>` 均未启用 `lazy-load`；消息历史、收藏/卖家页和图片型聊天增长后会增加解码、内存和网络负担。
- chat 为 35 个 `setData` call site，且 message array 全量更新；首页 16 个。数量本身不是 bug，但 chat 是 JS bridge 优化首选。
- tracked mock 数据未被任何生产入口 require；`mock/index.js`、`mock/products.js`、`utils/async.js` 在静态 require graph 中不可达，属于低优先级 dead code。
- `app.js` 和 auth-store 有预期的 fire-and-forget silent catch；不会形成 unhandled rejection，但生产缺少隐私安全的启动失败 telemetry。

### Existing performance evidence

2026-08-09 的 production 只读低并发观测：18 个 case、每 case 5 次 warm、concurrency 2、90 个 warm samples；case p50 的中位数 456 ms，最大观测 2,330 ms，errors/console errors/exceptions 均为 0。它不是强制 cold start，也不是 Phase 25 后的容量压测，不能据此推导承载用户数。

## L. Backend scalability

| Area | Risk | Assessment |
| --- | --- | --- |
| Chat polling | high | 每个打开 chat 约每 8 秒产生 message query + mark-read transaction + appointment query；并发增长时读/transaction 放大 |
| Message/appointment list enrichment | medium-high | 每页逐项 user+product point reads，最大页可能产生约 60 个附加 reads |
| Favorite list | medium-high | 最多 20 个 product 串行 N+1，延迟随页大小线性增加 |
| Conversation hidden scan | medium | 最多 8 轮双分支读，隐藏记录密集时读放大 |
| Product/favorite/view counters | medium | 同一热门 product document 是 favoriteCount/viewCount transaction 热点 |
| School query | low-medium | cursor + compound index 正确；全国 active 后仍需 staging explain/latency 验证 prefix regex |
| Legacy skip pagination | medium | user products/favorites/legacy product path 在深页退化，当前上限约 2,000 offset |
| productViews retention | medium | 有 cleanupAfter index，但无 scheduled trigger；27 条当前无 expired，规模增长后需受控清理 |
| Function package/runtime | medium | 7.4 MB 包；4 个函数仍为 Nodejs16.13；runtime/依赖升级需 staging 回归 |

**需要实际压力测试或平台配额数据才能量化。** 本轮没有在 production 做压力测试，也不提供未经证据的 QPS/用户数。

## M. Concurrency risks

| Scenario | Coverage class | Current control / remaining risk |
| --- | --- | --- |
| 多用户首页刷新/搜索 | C | cursor/index 已有；真实 cache/配额/冷启动只应 staging 压测 |
| 多用户发布 | B/C | deterministic requestId、防重复；上传+DB partial outcome 需 staging fault test |
| 同时收藏 | A/B | transaction + deterministic favorite ID；热门 product counter hotspot 待 staging load |
| 双方同时聊天 | A | deterministic message ID、transaction、bounded retry；本轮 120 次重复 interleaving 通过 |
| 同时 mark read | A/B | transaction 幂等；但 polling 导致大量无变化 transaction read |
| hide/send race | A | cases A–F、retry exhaustion、outcome unknown、new activity restore 已自动覆盖 |
| recall/delete-for-me/forward | A | ownership、alias、privacy/idempotency 自动覆盖 |
| appointment create/update | A/B | active unique、idempotency、seller-only completion；product/appointment 热点需 staging load |
| school query | B/C | 本地/静态 cursor 已覆盖；全国 active 的真实查询计划/延迟需 staging |

A = 已有自动 race coverage；B = 可安全本地模拟；C = 只能在 staging 压测；D = 不应在 production 压测。本轮没有执行 D 类生产压力操作。

## N. Security

已确认：

- 9 个业务/系统集合均为 `ADMINONLY`；敏感集合无客户端直读。
- OPENID/APPID 来自 `cloud.getWXContext()`；seller/sender/participant/school 等客户端伪造字段不会成为 authority。
- product ownership、conversation participant、appointment participant、recall sender、delete-for-me participant、school active/valid 均由服务端校验。
- storage 为 `READONLY`；项目既有证据确认其语义为所有用户可读、仅创建者/管理员可写。上传路径使用不可枚举 token 且聊天 fileID 只经 participant 接口返回，但“持有 fileID 即可读”仍是 medium privacy residual risk，需继续配合隐私说明、内容治理与路径审计。
- production diagnostic role unset，debug diagnostic UI 仅 develop/staging；unknown action 拒绝。
- 扫描 380 个 tracked 文件：private key 0、credential assignment 0。6 个高熵命中均为 example placeholder 或测试/操作 ID，不是凭据；未输出其值。
- private secrets/targets 与 `project.private.config.json` 均未 tracked。

### Security release blocker

Root `@e965/xlsx` dependency audit 为 0 vulnerability；但三种云函数 dependency layout 的 `npm audit --omit=dev` 均报告同一组 **5 high + 1 moderate**：涉及 direct `wx-server-sdk@4.0.2` 及其 pinned `@cloudbase/node-sdk@3.17.2`、`@cloudbase/database@1.4.3`、`axios@0.27.2`、`lodash.set@4.3.2`、`lodash.unset@4.5.2`。

`wx-server-sdk@4.0.2` 已是 registry 当前最新版，且它固定 node SDK 3.17.2；`npm audit fix` 建议降级到 2.5.3，属于 semver-major/功能回退方案，**不能直接执行**。虽然本项目没有直接调用 axios/任意 URL，且输入做了严格校验，但当前无法仅凭静态审计排除 SDK 内部路径的可利用性。正式发布前必须完成 CloudBase/vendor advisory 核实、可利用性分析、风险接受或安全升级，并在 staging 回归 12 个函数。

## O. Feedback architecture recommendation

当前项目：无反馈页面、无 `feedback` collection、无反馈云函数、无 SMTP/nodemailer/第三方邮件服务、无应用级 HTTP 邮件调用、无已配置邮件 secret 管理流程。

推荐未来链路：

```text
我的 → 反馈页面
→ feedback cloud function
→ server-side auth / validation / rate limit
→ feedback collection 持久化（先落库）
→ secure email provider / SMTP server-side delivery
→ delivery status / retry / dead-letter audit
→ owner-configured feedback address
```

设计要求：

- 不把邮箱密码、SMTP authorization code、API secret 写入客户端、Git 或可返回给客户端的 env。
- 建议要求登录，由服务端记录 hashed/controlled identity reference、schoolId、app version、system/device 摘要、server timestamp；正文设置合理最小/最大字数。
- 以 openid/user + device/risk signal 做速率限制、重复内容去重、spam/敏感内容治理。
- 先写 DB 再发邮件；邮件失败只更新 delivery state 并重试，不能丢失反馈。
- collection 设 `ADMINONLY`，客户端只拿到 feedback ID 和安全状态，不返回内部错误/邮件配置。
- 明示隐私用途与收集字段；设备信息最小化，不收集无必要的用户隐私。

## P. Automated verification

本轮执行结果：

- Phase 25 lifecycle 67、hide/send race 899（含 120 次重复 interleaving）、diagnostics 69、rollback 35、project verify 81：全部通过。
- Phase 24 core 88、auth flow 71、login transaction 35、pair conversation 52：全部通过。
- Schools verify 5 groups、school selection 128、product-school binding 51、Phase 22A 6 groups、Phase 22 42：全部通过。
- Phase 18 market/change/logout/auth 214、migration/final readiness/22B 70：全部通过。
- Phase 19/20/21 共 191：全部通过。
- Phase 23 production hardening 133：全部通过。
- 可计数的 checks/assertions/scenarios 合计 2,226，另有 11 个 grouped checks；无失败。
- Fresh production Phase 23 config/ACL/index/function audit gate passed；Fresh Phase 25 data integrity gate passed；Fresh Phase 22A no-write gate passed。
- 2026-08-09 production security probes：18 个 forged identity/invalid action probe 全部按预期拒绝，before/after projection 一致；本轮因未配置 DevTools automator 且避免额外 production 调用，没有重跑动态 probes。
- `git diff --check` passed；secret pattern scan 没有真实凭据命中。
- Dependency audit：root passed；cloud functions failed security gate（5 high、1 moderate），因此自动验证总状态不能写成全绿。

## Q. Bugs found

| Severity | Finding | Impact / evidence |
| --- | --- | --- |
| blocker | Cloud function dependency security gate unresolved | 12 个函数共享被 audit 报告的 5 high + 1 moderate 依赖树；无安全的自动修复路径 |
| blocker | 13 个 available 商品缺少有效 seller user | 均在上海工程技术大学；可浏览但 `createOrGetConversation` 返回 `PRODUCT_SELLER_UNAVAILABLE` |
| high | 商品清理目标范围不一致 | 两所学校仅 56 条，collection 还有 16 条 no-school；未经明确 scope 无法承诺清理后为 0 |
| high (Step 3) | 学校选择客户端不消费 cursor | 全国 active 后默认只能浏览首 20 条；必须搜索 prefix 才能找到其余学校 |
| medium | chat 固定 8 秒轮询并串联 3 类请求 | 高在线 chat 数下造成云函数、transaction、setData 放大 |
| medium | list enrichment / favorite N+1 | message/appointment 最多约 60 附加 point reads；favorite 20 个串行读 |
| medium | productViews 无自动 retention trigger | 当前 27、expired 0；长期增长会积累 |
| medium | 4 个 production 函数仍为 Nodejs16.13 | 已 EOL 的语言运行时世代，需结合 CloudBase 支持矩阵 staging 升级 |
| medium | storage `READONLY` 的全局可读语义 | 依赖不可枚举 fileID 与 participant 返回边界；不是任意写，但仍有隐私暴露面 |
| medium-low | 列表/聊天图片无 lazy-load | 低端机、长聊天、更多商品时增加解码和内存压力 |
| low | 启动/轮询有 intentional silent catch | 防止 unhandled rejection，但生产可观测性不足 |
| informational | tracked mock 与 `utils/async.js` 不可达 | 不进入生产包主链路，可在后续小改中清理，不应阻塞当前 Step 2 |

## R. Performance optimization candidates

| Candidate | Expected benefit | Regression risk | Files affected | Verification needed |
| --- | --- | --- | --- | --- |
| chat delta/push + visibility-aware exponential backoff，拆分 appointment refresh/mark-read | 大幅降低常驻 chat 请求、transaction、setData | high | `pages/chat`, `services/message-service`, message/appointment functions | foreground/background、断网恢复、未读、hide/send、recall 全回归；staging load |
| 批量 enrichment / snapshot-first DTO | 降低 conversation/appointment/favorite N+1 和尾延迟 | medium-high | `messageQuery`, `appointmentQuery`, `favoriteProduct`, `userQuery` | 隐私白名单、顺序、deleted product fallback、索引与 query limit |
| school cursor/province UI | 全国学校可发现性完整，仍维持小 payload | medium | `pages/school-select`, `school-service`, `schoolQuery` | 2,952 active staging、低端机、搜索/分页/stale response |
| image `lazy-load`、缩略图/尺寸策略 | 降低首屏网络、解码、内存 | medium | product/list/chat/profile WXML；publish/chat media services | 真机 iOS/Android、预览、失败 placeholder、清晰度 |
| chat message window + path-level incremental `setData` | 降低 JS bridge 与数组排序成本 | high | `pages/chat` | earlier history、poll merge、pending retry、recall/delete/forward/race |
| scheduled productViews cleanup | 控制 collection 长期规模 | low-medium | new controlled cleanup job/trigger + existing index | dry-run、batch cap、retention policy、no product count drift |
| Node 18+ runtime normalization / package trim | 降低生命周期和潜在冷启动风险 | medium-high | 12 function configs/package locks | vendor compatibility、all 2,226+ regression checks、staging smoke/load |
| privacy-safe startup telemetry | 提高 cloud init/session restore 故障可观测性 | medium | `app.js`, `auth-store`, cloud error mapping | 不记录 OPENID/payload/secret，采样与失败降级 |

本轮没有实施任何候选。

## S. Release blockers

正式提交微信审核前必须关闭：

1. **依赖安全 blocker**：完成 CloudBase SDK advisory/可利用性核实，给出 vendor 修复、兼容升级或书面风险接受；不得按 npm 建议盲目降级。
2. **无效在售商品 blocker**：清理/下架 13 个无有效 seller 的 available 商品，并验证 public available 中 seller identity 完整率为 100%。
3. **商品 0 件 scope gate**：owner 明确是 public 0、两校归属 0，还是 physical collection 0；记录 expected count 与历史关系处置。

全国学校开放前另有独立 Step 3 blocker：客户端必须消费 cursor 或提供 province/search 完整浏览，并在 staging 以 2,952 active 数据验证。

## T. Recommended execution order

1. 冻结当前 baseline；保留本报告与 fresh aggregate snapshot，不部署。
2. Owner 明确 Step 2 商品清理语义与授权范围（32 / 56 / 72），先生成零写 dry-run manifest。
3. 同步进行 CloudBase SDK dependency advisory/升级调查；禁止 `npm audit fix --force` 或自动降级。
4. 在 staging 演练 selective offline/archive、关系保持、seller integrity 与 post-audit；若要求 physical 0，先实现 tombstone/archive 与引用迁移方案。
5. 经 owner 明确授权后才进入 production 受控清理窗口；执行 snapshot → dry-run → count check → relationship audit → execute → post-audit。
6. 完成依赖修复/风险接受并在 staging 回归全部函数、race、security probe、性能基线。
7. Step 3 完成学校 selector cursor/province 架构，再考虑把 2,950 pending schools 分批 active；不得全量下载到客户端。
8. 最后实现 feedback（先落库后邮件），再做最终 production read-only audit、真机 smoke、微信审核提交。

## Final status

**NOT READY — BLOCKERS FOUND**

当前 stable main、production 函数/ACL/索引与核心消息预约一致性均可靠；但依赖安全门禁和 13 个不可交易的 available 商品不能在正式发布前忽略。Step 2 应以“关闭 blocker 的受控整改/清理”开始，而不是直接发布。
