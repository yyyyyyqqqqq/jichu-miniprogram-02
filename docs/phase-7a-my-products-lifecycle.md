# 第七阶段 A：我的发布与商品生命周期管理

更新时间：2026-07-18

项目：即出——校园闲置物品线下面交微信小程序

云环境：`cloud1-d9gpdpv6p2db56d8e`

## 1. 功能范围

本阶段实现登录用户查看和管理自己发布的商品：

- 按在售、已下架、已售出筛选；
- 下拉刷新和分页加载；
- 在售商品下架；
- 在售商品标记已售；
- 已下架商品重新上架；
- 服务端所有权校验、条件更新和幂等重试。

本阶段不实现商品编辑、删除、图片替换、收藏、聊天、订单、支付或物流。

第六阶段的双微信身份跨用户删除图片拒绝测试仍延期。该项和本阶段双身份越权操作测试都必须在发布前补测，当前不得宣称全部安全验收完成或完整具备上线条件。

## 2. 页面入口

页面已经注册：

```text
pages/my-products/index
```

入口链路：

```text
个人中心
→ 我的发布
→ AuthGuard
→ 未登录时进入登录页
→ 登录成功后按白名单返回我的发布
```

页面复用现有 `AuthStore`、`AuthGuard`、`NavigationService`、空态和加载态组件。

## 3. 数据字段与兼容状态

`createProduct` 当前写入的主要字段：

```text
_id
sellerId
sellerOpenid
title
description
price
images
coverImage
status = available
viewCount
favoriteCount
createdAt
updatedAt
```

本阶段复用现有状态，不迁移或重写已有商品：

```text
available  在售
offline    已下架
sold       已售出
deleted    软删除预留，本阶段不使用
```

状态操作新增或维护：

```text
offlineAt
soldAt
relistedAt
updatedAt
```

`createdAt` 永不被状态操作覆盖。

## 4. 我的发布查询

查询链路：

```text
pages/my-products
→ MyProductsService.getMyProducts()
→ productQuery(action = myProducts)
→ cloud.getWXContext().OPENID
→ products.where({ sellerOpenid, status })
```

客户端只传：

```text
status
page
pageSize
```

客户端不传 `sellerOpenid`、`ownerOpenid`、`openid` 或其他身份字段。`productQuery` 从云函数上下文取得真实 OPENID，并将其写入数据库查询条件。

返回继续使用显式安全字段映射，不返回：

```text
sellerOpenid
publishRequestId
内部权限字段
调试字段
```

分页沿用现有页码方案：

- 默认每页 6 条；
- 最大每页 20 条；
- 最大页码 100；
- `createdAt DESC, _id ASC`；
- 返回 `list / total / page / pageSize / hasMore`。

## 5. 商品状态管理云函数

云函数：

```text
cloudfunctions/manageProduct
```

调用参数仅允许：

```text
action
productId
```

支持 action：

```text
takeOffline
relist
markSold
```

调用链路：

```text
页面确认弹窗
→ MyProductsService.manageProduct()
→ manageProduct
→ cloud.getWXContext().OPENID
→ 查询目标商品
→ product.sellerOpenid === 当前 OPENID
→ 旧状态条件更新
→ 返回安全状态结果
```

云函数不读取客户端传入的卖家身份或目标状态。目标状态完全由 action 决定。

## 6. 状态机

允许：

```text
available → offline   takeOffline
available → sold      markSold
offline   → available relist
```

禁止：

```text
sold → available
sold → offline
offline → sold
```

时间字段策略：

- `takeOffline`：写入 `offlineAt` 和 `updatedAt`；
- `markSold`：写入 `soldAt` 和 `updatedAt`；
- `relist`：将 `offlineAt` 清为 `null`，写入 `relistedAt` 和 `updatedAt`。

公开列表不再返回已售商品，但已售商品详情继续可访问并显示“已出”状态。下架商品的公开列表和详情均不可访问。

## 7. 并发与幂等

云函数更新条件同时包含：

```text
_id
sellerOpenid
允许的旧 status
```

更新数量为 0 时重新查询，区分：

- 商品不存在；
- 非本人商品；
- 状态已被其他请求改变；
- 同一操作已经完成。

如果商品已处于目标状态并存在该 action 对应的服务端时间标记，返回幂等成功：

```text
reused = true
```

这使弱网重试不会重复产生状态副作用。页面侧同时使用 `isManaging` 和单例操作 Promise 阻止重复点击。

## 8. 错误码

```text
INVALID_ACTION
INVALID_PARAMS
UNAUTHORIZED
PRODUCT_NOT_FOUND
PRODUCT_FORBIDDEN
INVALID_STATUS_TRANSITION
DATABASE_ERROR
INTERNAL_ERROR
```

客户端服务层将云函数、网络、超时和无效响应统一映射为用户可恢复错误，不展示底层堆栈。

## 9. 数据库索引

现有 8 个公开商品索引不包含 `sellerOpenid`，不能覆盖本人商品查询。

已在云开发控制台手工创建并由项目操作者确认：

```text
索引名称：idx_sellerOpenid_status_createdAt_id
sellerOpenid ASC
status ASC
createdAt DESC
_id ASC
```

使用查询：

```text
当前 OPENID + 单个商品状态 + 创建时间倒序分页
```

微信开发者工具 CLI 当前不提供数据库索引查询接口，因此本次索引存在性以云开发控制台人工核对记录为准。不要删除或修改现有 8 个公开查询索引。

## 10. 自动验证

执行：

```powershell
node scripts/verify-project.js
node --check cloudfunctions/productQuery/index.js
node --check cloudfunctions/manageProduct/index.js
node --check services/my-products-service.js
node --check pages/my-products/index.js
git diff --check
```

当前自动验证结果：

```text
38 checks passed
```

新增覆盖：

- 我的发布页面注册、登录守卫、空态、错误态、刷新和分页；
- 页面不直接访问云数据库或云函数；
- 客户端服务不发送身份字段；
- 本人商品查询和其他用户商品隔离；
- 查询响应不返回 `sellerOpenid`；
- 服务端 getWXContext 和所有权校验；
- `available → offline`；
- `offline → available`；
- `available → sold`；
- 已售商品禁止恢复；
- 重复请求幂等；
- 非本人商品拒绝；
- 商品不存在、参数缺失和身份缺失；
- 生产 seed 入口继续关闭。

自动测试使用内存数据库模拟，不向正式云数据库写入垃圾测试数据。

## 11. 人工验收

2026-07-18 已完成并通过：

- “我的发布”在售、已下架、已售出三个状态分类；
- 在售商品下架；
- 已下架商品重新上架；
- 在售商品标记已售；
- 首页商品可见性随状态变化；
- 防重复点击和确认弹窗；
- 登录守卫及登录后返回；
- 微信开发者工具控制台无报错。

双账号商品状态越权测试仍延期，必须在发布前与第六阶段跨用户图片删除拒绝测试一并补测。

### A. 我的发布列表

1. 在控制台创建第 9 节索引并等待生效。
2. 登录账号 A。
3. 从个人中心进入“我的发布”。
4. 确认只显示账号 A 发布的商品。
5. 切换在售、已下架、已售出。
6. 下拉刷新。
7. 准备超过 6 条同状态商品后验证分页和无更多状态。

### B. 下架

1. 对在售商品点击“下架”。
2. 取消一次确认弹窗，确认状态没有变化。
3. 再次操作并确认。
4. 商品从在售列表消失并进入已下架列表。
5. 首页不再展示。
6. 公开详情返回商品不存在或已下架。

### C. 重新上架

1. 在已下架列表点击“重新上架”并确认。
2. 商品进入在售列表。
3. 首页刷新后重新可见。
4. 数据库中 `offlineAt` 为 `null`，`relistedAt` 和 `updatedAt` 已更新。

### D. 标记已售

1. 对在售商品点击“标记已售”。
2. 取消一次确认弹窗，确认状态没有变化。
3. 再次操作并确认。
4. 商品进入已售出列表。
5. 首页不再展示。
6. 原商品详情仍可打开并显示“已出”。
7. 已售商品没有恢复按钮。

### E. 登录和异常

1. 未登录打开“我的发布”，确认进入登录页。
2. 登录成功后确认返回“我的发布”。
3. 快速重复点击操作按钮，确认只发起一次状态请求。
4. 断网后操作，确认按钮恢复并可重试。
5. 下拉刷新失败时确认已有列表保留。

### F. 双身份越权

1. 账号 A 准备一个在售商品并记录 productId。
2. 使用账号 B 调用 `manageProduct` 操作账号 A 的 productId。
3. 确认返回 `PRODUCT_FORBIDDEN`。
4. 确认商品状态未改变。

若暂时没有第二个微信身份，本节明确延期，发布前必须与第六阶段跨用户图片删除拒绝测试一并补测。

## 12. 当前部署状态

已部署到：

```text
cloud1-d9gpdpv6p2db56d8e
```

真实查询结果：

```text
productQuery  Active / Nodejs16.13 / 10 秒
manageProduct Active / Nodejs16.13 / 10 秒
```

两个云函数的云端下载包均与本地 `index.js`、`package.json`、`package-lock.json` SHA-256 一致。

开发者工具实际打开：

```text
pages/my-products/index
```

结果：

- 路由正常；
- 当前登录用户的真实在售商品成功显示；
- 真实只读查询返回 2 条当前账号在售商品，`hasMore = false`；
- 真实查询响应未发现 `sellerOpenid` 或 `ownerOpenid`；
- 页面 exception 为 0；
- console error 为 0；
- `productQuery.myProducts` 无效状态 smoke test 返回 `INVALID_PARAMS`；
- `manageProduct.takeOffline` 缺少 productId 的无写入 smoke test 返回 `INVALID_PARAMS`。

页面截图：

```text
phase7a-my-products.png
```

第 9 节专用组合索引已在云开发控制台创建并由项目操作者人工确认。有效列表当前可以返回数据；`manageProduct` 云端超时已调整为 10 秒。

## 13. 已知限制与延期项

- 双身份商品状态越权测试尚需人工执行；
- 第六阶段跨用户图片删除拒绝测试仍延期；
- 云函数平台运行时和依赖风险沿用第六阶段记录；
- 本阶段不提供商品编辑、删除或已售恢复；
- 未完成以上发布前补测时，不得宣称完整具备上线条件。

## 14. 回滚方式

如果部署后出现阻断问题：

1. 停止人工状态操作测试；
2. 保留数据库现有商品和状态，不执行批量回写；
3. 将 `productQuery` 部署回稳定提交 `c16f6a34761fa7ad4f92229c5186e93fe3d534f6` 对应版本；
4. 暂停调用 `manageProduct`，保留云函数日志和错误时间；
5. 重新运行第六阶段公开读取、详情和发布回归；
6. 修复后重新部署并再次检查所有权、状态迁移和索引。

回滚不得删除现有 8 个公开索引、用户商品数据或云存储图片。
