# 第八阶段：真实收藏系统与用户公开主页

更新时间：2026-07-19
云环境：`cloud1-d9gpdpv6p2db56d8e`

## 1. 范围与原始状态

本阶段实现商品收藏、取消收藏、收藏状态与数量、“我的收藏”、用户公开主页、用户公开在售商品分页，以及商品详情到卖家主页的安全跳转。不实现聊天、消息、预约、地图、订单、支付、关注、评价、信用分、推荐或管理后台。

开发前，详情页已有收藏按钮和 `favoriteCount` 展示，但按钮只是占位；`pages/favorites`、`pages/user-profile` 和个人中心入口已存在，但两个页面均为占位。工程没有 `favorites` 集合、收藏服务或收藏云函数。

`users._id` 由云端按 `u_ + SHA-256(APPID:OPENID)` 生成，稳定、不含也不等于完整 OPENID。商品内部保存 `sellerOpenid` 和 `sellerId`，公开响应不返回 `sellerOpenid`。公开列表只显示 `available/reserved`，公开详情允许 `available/reserved/sold`，“我的发布”排除 `deleted`。

## 2. 收藏数据模型

集合：

```text
favorites
```

字段：

```text
_id
userOpenid
productId
createdAt
updatedAt
```

收藏文档 `_id` 由服务端计算：

```text
f_ + SHA-256(userOpenid:productId)
```

确定性 `_id` 在主键层保证同一用户与商品只有一条关系。`userOpenid` 只由 `cloud.getWXContext().OPENID` 获取，不接受客户端身份字段，也不返回客户端。客户端不得直接读写 `favorites`。

## 3. 收藏云函数、幂等与计数

新增 `cloudfunctions/favoriteProduct`，Action 为：

```text
getFavoriteStatus
addFavorite
removeFavorite
listMyFavorites
```

客户端统一通过 `services/favorite-service.js` 调用；服务层负责参数、15 秒超时、稳定错误映射、响应规范化和分页边界。

`addFavorite` 在同一数据库事务中读取商品和确定性关系。关系已存在时幂等返回；不存在时创建关系并将安全标准化后的 `favoriteCount` 加 1。

`removeFavorite` 在同一事务中读取关系。关系不存在时幂等返回；存在时删除关系，并在商品仍存在时更新为 `Math.max(0, count - 1)`。旧商品缺失或带非法 `favoriteCount` 时按 0 处理，不批量修改生产数据。

确定性关系 ID、数据库事务和幂等返回共同处理快速点击、双页面、双设备和超时重试。操作成功后通过 `AppStore.markFavoritesChanged()` 使收藏列表和商品数据失效，页面重新进入仍以云端状态为准。

## 4. 商品状态规则

```text
available 允许新增收藏、查询状态和取消收藏
offline   不允许新增；已有关系保留、列表显示“已下架”、允许取消
sold      不允许新增；已有关系保留、列表显示“已出”、允许取消
deleted   不允许收藏；“我的收藏”不返回
```

自己的商品返回 `CANNOT_FAVORITE_OWN_PRODUCT`，详情页不显示收藏按钮。未登录点击收藏先进入登录页，登录后只返回详情，不自动产生收藏。

## 5. 我的收藏

查询链路：

```text
pages/favorites
-> FavoriteService.listMyFavorites
-> favoriteProduct/listMyFavorites
-> 当前调用者 OPENID
-> favorites 按 createdAt 倒序分页
-> products 安全字段映射
```

页面支持首次加载、下拉刷新、上拉分页、空态、整页错误、加载更多错误、重试、状态提示、取消收藏和防重复请求。

`offline` 商品不进入公开详情，因此列表点击时给出明确下架提示；`sold` 商品可进入现有已售详情；`deleted` 商品直接隐藏。

收藏关系关联到已删除商品后不会展示。当前 `total/hasMore` 基于收藏关系分页；若一页含已删除关系，该页可见条数可能少于 `pageSize`，这是无跨集合联表能力下的已知限制。

## 6. publicUserId 与旧用户兼容

本项目采用现有安全 `users._id` 作为 `publicUserId`：

```text
u_ + SHA-256(APPID:OPENID) 前 32 位
```

它只在云端生成，不包含也不等于 OPENID，固定长度、不可逆且稳定；已有用户和商品均已保存该 ID。因此本阶段不新增会产生并发补齐问题的第二个标识，也不需要迁移旧用户。

客户端只把 `publicUserId` 作为页面参数；服务端把它映射到 `users` 文档后，才使用内部 OPENID 查询商品。

## 7. 用户公开主页

新增 `cloudfunctions/userQuery`：

```text
publicProfile
publicProducts
```

公开资料白名单：

```text
publicUserId
nickname
avatarUrl
campus
bio
joinDate
activeProductCount
```

缺少昵称、校园或简介时使用安全默认值。响应不含 OPENID、角色、账户状态、登录时间、联系方式或其他内部字段。

公开商品链路：

```text
publicUserId
-> users._id
-> 服务端内部 openid
-> products(sellerOpenid + status=available)
-> 安全商品字段白名单
```

公开主页支持资料加载、在售商品分页、下拉刷新、上拉加载、空态、错误重试和详情跳转。不会显示下架、已售或已删除商品，也不提供关注、评价、举报或私信占位。

商品公开响应使用 `sellerPublicUserId`，跳转 URL 为：

```text
/pages/user-profile/index?userId=<publicUserId>
```

URL 不包含 OPENID。

## 8. 安全与错误

- 收藏和用户主页页面不直接访问数据库。
- 收藏身份只来自 `getWXContext()`。
- 客户端收藏请求只发送 action、productId 或分页参数。
- 收藏关系、公开资料和公开商品响应不返回 `userOpenid/sellerOpenid`。
- 公开资料严格白名单，公开主页只查询 `available`。
- 商品详情继续排除 `deleted`。
- 收藏失败日志只记录固定执行步骤、错误名称、平台错误码和归类原因，不记录请求、用户、商品、关系、文件或身份载荷。
- 没有新增 seed、debug 或 Mock 写库入口。
- 未修改数据库客户端权限、云存储权限、云环境或运行时。

主要收藏错误码：

```text
UNAUTHORIZED
INVALID_PARAMS
PRODUCT_NOT_FOUND
PRODUCT_NOT_FAVORITABLE
CANNOT_FAVORITE_OWN_PRODUCT
FAVORITE_FAILED
UNFAVORITE_FAILED
DATABASE_ERROR
INTERNAL_ERROR
INVALID_ACTION
```

公开主页错误码：

```text
INVALID_PARAMS
USER_NOT_FOUND
PUBLIC_PROFILE_UNAVAILABLE
DATABASE_ERROR
INTERNAL_ERROR
INVALID_ACTION
```

客户端不会展示数据库条件、云环境、关系 ID、fileID 或身份信息。

## 9. 集合权限与索引

已在 CloudBase 控制台确认 `favorites` 集合存在，客户端读写权限均为拒绝。

建议索引：

| 索引名 | 集合 | 唯一 | 字段顺序 | 使用场景 | 阻塞性 |
| --- | --- | --- | --- | --- | --- |
| `idx_userOpenid_productId_unique` | `favorites` | 是 | `userOpenid ASC, productId ASC` | 关系唯一性的第二道防线 | 已创建 |
| `idx_userOpenid_createdAt_id` | `favorites` | 否 | `userOpenid ASC, createdAt DESC, _id DESC` | “我的收藏”稳定分页 | 已创建，函数查询方向已对齐 |

用户公开 ID 使用 `users._id` 主键，不需要 `publicUserId` 二级索引。公开商品复用现有：

```text
idx_sellerOpenid_status_createdAt_id
sellerOpenid ASC
status ASC
createdAt DESC
_id ASC
```

不得删除或重建现有 9 个业务索引。

## 10. 自动验证

```powershell
node scripts/verify-project.js
```

结果：

```text
Verification succeeded: 45 checks passed.
```

原有 40 项全部保留，新增覆盖收藏身份边界、事务、确定性关系、重复收藏和取消、计数下限、本人商品、各商品状态、不存在商品、缺失计数、并发收藏、收藏分页与隐私，以及公开用户 ID、资料白名单、默认资料、用户不存在、仅在售商品、响应隐私和新云函数的 `ws` 生产依赖锁定。

测试使用内存隔离 CloudBase mock，没有向正式数据库写入垃圾数据。

全量 JavaScript 语法检查结果：

```text
JavaScript syntax passed: 47 files
```

`git diff --check` 通过。微信开发者工具 CLI 成功打开项目并完成编译启动，没有返回编译失败。

## 11. 部署与线上只读核验

实际部署：

| 云函数 | 结果 | 运行时 | 超时 |
| --- | --- | --- | ---: |
| `favoriteProduct` | Active | Nodejs18.15 | 10 秒 |
| `userQuery` | Active | Nodejs18.15 | 10 秒 |
| `productQuery` | Active | Nodejs16.13 | 10 秒 |

两个新函数由平台按当前默认运行时创建；没有修改四个既有函数的运行时。两个新函数当前均已调整为 10 秒。

人工验收首次执行 `addFavorite` 时，两个新函数的线上启动日志均出现缺少 `ws` 的警告，收藏写入随后返回安全的 `DATABASE_ERROR`。依赖检查确认业务代码没有直接 `require('ws')`；依赖链为 `wx-server-sdk -> @cloudbase/node-sdk -> @cloudbase/app`，其中 `@cloudbase/app` 把 `ws ^8.18.0` 声明为可选 peer，原清单和锁文件未解析 `node_modules/ws`，因此云端生产安装可稳定复现该缺失。

`favoriteProduct` 和有相同线上日志证据的 `userQuery` 现均把 `ws` 显式声明为生产依赖，锁文件解析到 `8.21.1`。最终收尾的非写入冷启动探测又确认 `productQuery` 存在同一依赖链警告，因此在有真实日志证据后对它执行相同最小修复，没有升级其运行时或改动业务逻辑。三个函数均使用开发者工具 `--remote-npm-install` 部署，线上函数信息显示 `InstallDependency=TRUE`。下载后的云端包确认存在相应生产依赖；三个函数的 `index.js/package.json/package-lock.json` 共 9 个正式文件 SHA-256 与本地逐一一致。最终非写入探测均返回稳定 `INVALID_ACTION`，日志不再出现缺少 `ws` 的警告。

收藏列表查询原先以 `_id ASC` 收尾，与已创建的 `_id DESC` 复合索引不一致；现已改为 DESC 并随 `favoriteProduct` 最终版本部署。这个问题不解释首次 `addFavorite` 写入失败，但会影响后续“我的收藏”分页。

依赖修复后的真实复测把失败阶段定位到 `add.read_relation`。当前 `wx-server-sdk 4.0.2` 在事务内按 `_id` 读取不存在文档时，会抛出 `Error`，`errCode` 为 `-1`，错误消息形态为 `document.get:fail document with _id ... does not exist`；原缺失文档判断只识别连续的 `document does not exist`，因此第一次收藏的正常“关系不存在”被误判为数据库故障。事务内 `where` 不受支持，所以最终保留确定性关系 `_id`，只把 SDK 这一明确缺失签名作为正常分支，其他同为 `errCode=-1` 的读取错误继续抛出并返回安全 `DATABASE_ERROR`。

该修复同时覆盖首次收藏、取消不存在关系和未收藏状态查询。确定性 `_id`、同一事务内创建关系与更新商品计数、事务冲突自动重试，以及唯一索引兜底共同保持并发幂等。`favoriteProduct` 已再次通过 `--remote-npm-install` 部署；最终线上 `index.js/package.json/package-lock.json` SHA-256 与本地一致，线上包仍包含 `ws@8.21.1`。

非破坏性线上结果：

- `productQuery/list` 返回真实公开商品，响应包含 `sellerPublicUserId` 且不含 `sellerOpenid`；
- `userQuery/publicProfile` 返回公开资料白名单和真实在售数量；
- `userQuery/publicProducts` 只返回该用户 `available` 商品，不含内部 OPENID；
- `favoriteProduct` 非法 action 返回稳定 `INVALID_ACTION`；
- 没有执行真实收藏、取消收藏或其他生产写入。

部署与调用期间出现过腾讯云 TLS 临时失败，安全重试后成功。首次 `productQuery` 调用曾在部署传播窗口返回依赖未就绪，随后函数保持 Active 且真实列表调用恢复正常。

## 12. 人工验收结论

2026-07-19，第八阶段当前开发范围人工验收完成。

### 12.1 单账号可执行范围：通过

- 真实首次收藏可创建一条关系并把 `favoriteCount` 增加 1；
- 重新进入详情后收藏状态保持；
- 快速重复点击不会重复创建关系或重复增加计数；
- 取消收藏正常，重复操作不会使计数小于 0；
- “我的收藏”可展示真实收藏，取消后列表正确更新；
- 关系记录与商品 `favoriteCount` 保持一致；
- 详情页收藏状态、数量、登录守卫、防重复点击和缓存失效正常；
- 公开商品包含 `sellerPublicUserId`，不返回 `sellerOpenid`；
- 公开响应未发现 OPENID 泄漏；
- 非法或不存在的 `publicUserId` 进入安全错误态；
- 首页、详情、登录和发布等主要流程未发现明显回退；
- 云函数日志不再出现 `ws` 缺失警告，正常收藏不再返回 `DATABASE_ERROR`。

阶段结论：

> 第八阶段单账号可执行范围验收通过；双账号、跨用户权限、真实公开主页及多人并发测试延期至项目最终联合验收。

### 12.2 延期至项目最终联合验收

以下项目受当前开发阶段双账号登录条件限制，本阶段没有虚假标记为通过，且不阻塞第八阶段收尾：

1. 账号 B 收藏账号 A 发布的商品；
2. 本人商品与他人商品的收藏权限差异；
3. 双账号公开卖家主页访问；
4. 双账号越权调用；
5. 多用户同时收藏同一商品的并发计数；
6. 用户之间收藏数据隔离；
7. `offline`、`sold` 状态下跨用户收藏与取消；
8. 卖家公开主页真实展示；
9. 多真实用户公开资料白名单验证；
10. 双账号安全与权限综合验收。

## 13. 已知风险和限制

- `wx-server-sdk` 依赖链当前 `npm audit` 报告 1 个 moderate、5 个 high；强制修复会引入不兼容 SDK 变更，本阶段不为消除告警执行 `npm audit fix --force`，后续应独立评估升级。
- 双账号、跨用户权限、多人并发和真实公开卖家主页尚待项目最终联合验收。
- 弱网、兼容性、体验版和微信审核材料仍需在正式发布流程验证。
- 已删除商品的收藏关系不会自动物理清理；列表会安全隐藏。
- 一页关系中含已删除商品时，可见条数可能少于页大小。
- 收藏计数没有独立后台对账任务；正常路径依靠事务、确定性关系和唯一索引保持一致。
- 四个既有函数的 Nodejs16.13 运行时不在本阶段升级。

## 14. 回滚方案

1. 先停止详情和个人中心收藏入口。
2. 回滚详情、收藏页、公开主页、服务、配置和 `productQuery` 字段映射。
3. 下线 `favoriteProduct/userQuery` 前确认旧客户端不再调用。
4. 不批量删除 `favorites` 或修改商品计数。
5. 如需数据清理，先完成关系与 `favoriteCount` 对账并单独授权。

集合和索引可以保留，不影响旧客户端。

## 15. Git 收尾和下一阶段边界

阶段提交信息：

```text
feat: complete phase 8 favorites and public profiles
```

阶段标签：

```text
phase-8-complete
```

标签应指向包含本文件的第八阶段提交；实际提交哈希和推送结果记录在最终收尾报告中。交接文档 `04.md`–`23.md`、`node_modules`、本地缓存、构建产物和 IDE 私有文件不属于阶段提交。

第八阶段当前开发范围收尾后，可单独规划真实消息与聊天。不要把预约、地图、订单、支付或管理后台混入收藏收尾。
