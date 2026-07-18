# 第七阶段 B：商品编辑、软删除与图片生命周期管理

更新时间：2026-07-18

项目：即出——校园闲置物品线下面交微信小程序

云环境：`cloud1-d9gpdpv6p2db56d8e`

## 1. 功能范围

本阶段实现：

- 当前登录用户加载自己商品的可编辑数据；
- 编辑在售或已下架商品；
- 保留旧图片、移除旧图片和上传新图片；
- 整数 `version` 乐观并发控制；
- 在售、已下架和已售商品软删除；
- 数据库成功后的服务端图片引用检查与清理；
- 图片清理失败状态记录和所有者重试。

本阶段不实现物理删除、回收站、已售恢复、图片排序、收藏持久化、聊天、订单、支付、物流或管理后台。

2026-07-18 已完成本阶段功能、图片生命周期和双账号安全人工验收。当前规划范围内的核心功能与安全验收已经完成，但不代表已经通过微信官方审核或正式发布上线。

## 2. 编辑页面与入口

新增独立页面：

```text
pages/product-edit/index
```

选择独立编辑页，而不是让发布页承担 create/edit 双模式。发布流程已有发布请求幂等、结果未知重试和成功跳转状态机；编辑流程还需要所有者数据加载、version 冲突、旧图/新图区分和未保存提示。分开页面可以避免两个状态机互相干扰。

共享能力放在：

```text
services/product-form-service.js
services/product-publish-service.js
```

发布和编辑复用表单字段转换、图片选择、预览、校验、解码、上传路径和上传实现。

“我的发布”入口规则：

- `available`：编辑、下架、标记已售、删除；
- `offline`：编辑、重新上架、删除；
- `sold`：禁止编辑，只允许删除。

## 3. 服务端接口

不新增重复写云函数，扩展现有：

```text
cloudfunctions/manageProduct
```

新增 action：

```text
getEditableProduct
updateProduct
softDelete
retryImageCleanup
```

保留第七阶段 A：

```text
takeOffline
relist
markSold
```

所有 action 均使用 `cloud.getWXContext().OPENID`，不接受客户端身份字段。

## 4. 字段白名单

编辑请求仅允许：

```text
title
description
price
categoryId
categoryName（值不可信，服务端重新计算）
condition
location
images
```

服务端根据真实分类配置重新生成：

```text
categoryName
coverImage
coverLabel
coverTone
distanceText
tags
originalPrice
```

未知字段和系统字段返回 `INVALID_PRODUCT_FIELD`。编辑接口不能修改 `_id`、卖家身份、状态、时间、计数、version、删除字段或清理状态。

## 5. 商品状态限制

允许编辑：

```text
available
offline
```

禁止编辑：

```text
sold
deleted
reserved
draft
```

允许软删除：

```text
available
offline
sold
```

已删除商品不能再编辑、上下架或标记已售。

## 6. version 并发控制

新商品由 `createProduct` 写入：

```text
version: 1
```

以下成功操作均在数据库事务内写入 `version + 1`：

- 编辑；
- 下架；
- 重新上架；
- 标记已售；
- 软删除。

编辑和软删除请求携带：

```text
productId
expectedVersion
mutationId
```

服务端事务内读取商品、验证所有权/状态/version，再更新同一文档。版本不一致返回：

```text
PRODUCT_VERSION_CONFLICT
```

用户提示：

```text
商品信息已在其他页面发生变化，请刷新后重新编辑。
```

CloudBase 官方文档说明数据库事务仅支持服务端，具备 ACID，并且当前事务内只支持 `doc` 单文档操作：

```text
https://docs.cloudbase.net/database/transaction
```

## 7. 旧商品 version 兼容

历史商品可能没有 `version`。服务端读取时将缺失或无效 version 视为 `1`。

第一次成功编辑、状态变更或软删除在事务锁保护下写入 `2`。因此旧商品不会因为缺字段而查询失败，也不会使用无并发保护的普通条件更新。

## 8. 编辑数据获取

链路：

```text
product-edit
→ ProductEditService.getEditableProduct(productId)
→ manageProduct(getEditableProduct)
→ getWXContext().OPENID
→ 查询商品
→ 所有权、deleted 和可编辑状态校验
→ 返回白名单字段 + images + version
```

不复用公开详情作为编辑数据来源。响应不返回 `sellerOpenid`、清理任务字段、发布请求 ID 或其他系统字段。

## 9. 图片上传流程

页面将图片区分为：

```text
existing：数据库已有 cloud:// fileID
local：当前设备新选择的临时图片
```

保存顺序：

1. 校验表单和图片总数；
2. 解码并上传本次本地新图；
3. 生成 `finalImages = 保留旧图 + 新上传 fileID`；
4. 调用 `updateProduct`；
5. 数据库事务成功后由服务端清理被移除旧图。

本阶段不新增图片排序，最终顺序与页面当前顺序一致。

## 10. 图片差异计算

客户端只提交最终 `images`，不提交可信 `filesToDelete`。

服务端事务内使用数据库旧值计算：

```text
removedOldImages = unique(oldImages) - set(finalImages)
```

集合语义会去重，覆盖：

- 保留全部旧图；
- 删除部分旧图；
- 新增图片；
- 全部替换；
- 只修改文字。

最终图片必须 1–6 张，且每个 fileID 必须位于当前商品 `sellerId` 对应的安全目录。

## 11. 新图片失败回滚

明确业务失败（字段错误、无权限、版本冲突、数据库拒绝）：

- 客户端只回滚本次操作刚上传的新 fileID；
- 回滚仍按当前安全用户目录过滤；
- 不删除任何旧商品图片。

网络或超时导致结果未知：

- 不立即删除新图，避免数据库已经成功引用却被客户端误删；
- 保留原 `mutationId` 和已上传 fileID；
- 表单锁定并允许安全重试；
- 服务端通过 `lastMutationId/lastMutationType` 返回幂等成功。

## 12. 数据库与云存储操作顺序

顺序固定为：

```text
数据库事务提交
→ 图片引用检查
→ cloud.deleteFile
→ 写入清理结果
```

禁止先删旧图再写数据库。云存储删除不在数据库事务内，因此不能宣称“数据库更新 + 文件删除”原子完成。

## 13. 图片引用检查

服务端对每个待清理 fileID 执行数组包含查询：

```js
products.where({
  images: db.command.all([fileID])
}).limit(100)
```

保守规则：

- 当前商品后来重新引用该图时不删除；
- 任意其他商品仍引用时不删除，包括已删除商品；
- 查询失败、索引错误或结果不确定时不删除；
- 保留引用被视为无需清理；
- 不向客户端返回引用商品 ID 或所有者。

该策略优先避免误删，代价是可能暂时保留不再需要的文件。

## 14. 软删除字段

软删除事务写入：

```text
status: deleted
deletedAt: serverDate
deletedBy: owner
deleteReason: user_deleted
updatedAt: serverDate
version: version + 1
imageCleanupStatus: pending | completed | partial_failed
imageCleanupFiles: 待重试 fileID（仅服务端可见）
imageCleanupFailedCount
imageCleanupUpdatedAt
```

数据库文档始终保留，不调用 `remove()`。

## 15. 幂等策略

编辑使用 `mutationId`：

- 同一 mutation 已提交时返回当前 version 和 `reused: true`；
- 不重复递增 version；
- 不重复写业务字段；
- 清理仍处于 pending 时可以继续尝试。

软删除：

- 已是 `deleted` 时返回幂等成功；
- 不重复写 deletedAt 或递增 version；
- 若仍有待清理图片，会再次尝试清理。

## 16. 图片清理失败处理

删除失败不回滚已经成功的编辑或软删除。

结果写入：

```text
imageCleanupStatus: partial_failed
imageCleanupFiles: 仅失败项
imageCleanupFailedCount
```

客户端只接收：

```text
cleanupPending
cleanupFailedCount
```

不接收完整 fileID。所有者可通过 `retryImageCleanup(productId)` 重试。

## 17. 原子性与最终一致性

原子操作：

- 所有权读取；
- 状态与 version 校验；
- 商品字段更新或软删除；
- version 递增和清理任务登记。

以上在同一数据库事务中完成。

最终一致操作：

- 云存储引用检查；
- 云文件删除；
- 清理状态更新。

图片删除失败时业务仍成功，文件可能暂时成为孤儿；清理任务可追踪和重试。

## 18. 错误码

```text
INVALID_ACTION
INVALID_PARAMS
UNAUTHORIZED
PRODUCT_NOT_FOUND
PRODUCT_FORBIDDEN
PRODUCT_DELETED
PRODUCT_NOT_EDITABLE
PRODUCT_VERSION_CONFLICT
INVALID_PRODUCT_FIELD
INVALID_IMAGE_LIST
INVALID_STATUS_TRANSITION
UPDATE_FAILED
DELETE_FAILED
IMAGE_CLEANUP_PARTIAL_FAILED
DATABASE_ERROR
INTERNAL_ERROR
```

客户端另统一处理网络、超时、云环境未就绪和无效响应。

## 19. 查询链路适配

公开列表只允许：

```text
available
reserved
```

普通详情只允许：

```text
available
reserved
sold
```

“我的发布”正常分类只允许：

```text
available
offline
sold
```

因此 `deleted` 不会进入首页、普通详情或“我的发布”三个分类。公开映射继续不返回 `sellerOpenid`、version 或清理任务。

## 20. 数据库索引

本阶段不要求新增组合索引，也不修改现有 9 个组合索引。

编辑、状态和软删除事务均按 `_id` 单文档读取。图片引用检查按单个 fileID 使用 `images` 数组包含查询，不组合排序。

如果真实云环境要求数组字段专用索引或查询失败，当前实现会保守地不删除文件并记录 `partial_failed`，不会为了省存储而冒险误删。应先根据真实错误确认平台索引要求，再决定是否人工创建索引。

## 21. 自动验证

运行：

```powershell
node scripts/verify-project.js
```

当前本地结果：

```text
40 checks passed
```

覆盖：

- 编辑页注册、登录守卫、加载/错误/重复提交；
- 页面不直接访问数据库、云函数、上传或删除 API；
- 客户端不发送身份、状态或可信删除列表；
- 所有者数据加载与跨所有者拒绝；
- 字段白名单和伪造状态拒绝；
- version 冲突和旧商品兼容；
- 状态操作同步递增 version；
- 保留、删除、添加和全部替换图片；
- 更新失败回滚新图；
- 结果未知不误删新图；
- 数据库成功后才清理旧图；
- 清理失败不回滚数据库；
- 引用图片不删除；
- 软删除、重复软删除和 deleted 查询隔离；
- 原有登录、读取、发布和状态管理回归。

自动测试使用内存数据库和云 API 模拟，不写正式数据库。

## 22. 人工验收

2026-07-18 以下 A—G 项均已由项目操作者人工验收通过。记录只保留结论，不写入完整 OPENID、商品 ID 或 fileID。

### A. 编辑文字

1. 账号 A 发布测试商品。
2. 从“我的发布”进入编辑。
3. 修改标题、描述、价格、分类、成色和地点。
4. 保存并检查“我的发布”、首页和详情。
5. 再次进入编辑页确认回填。

### B. 编辑图片

1. 保留部分旧图。
2. 删除一张旧图。
3. 添加一张新图。
4. 保存并核对图片顺序、数据库 `images` 和页面展示。
5. 查看旧图是否删除或清理状态是否完成。

### C. 失败回滚

1. 上传新图后模拟明确保存失败。
2. 确认旧数据仍可使用。
3. 确认新上传图片被回滚。
4. 模拟超时，确认页面进入“结果待确认”，不会误删可能已引用的新图。

### D. 并发冲突

1. 同时打开两个编辑页面。
2. 页面 1 保存。
3. 页面 2 用旧 version 保存。
4. 确认页面 2 返回 `PRODUCT_VERSION_CONFLICT`。

### E. 软删除

1. 分别对在售、已下架、已售商品验证删除。
2. 取消一次二次确认。
3. 确认删除后列表、首页和详情不可见。
4. 确认数据库记录仍在且 status 为 deleted。
5. 核对 deletedAt、updatedAt、version 和清理状态。
6. 重复请求确认幂等。

### F. 登录与重复操作

1. 未登录打开编辑 URL。
2. 登录后返回同一商品编辑页。
3. 连续点击保存和删除，确认只产生一次有效变更。
4. 确认 Loading 最终关闭且控制台无错误。

### G. 双账号越权

账号 B 对账号 A 商品执行：

1. `getEditableProduct`；
2. `updateProduct`；
3. `softDelete`。

均应返回 `PRODUCT_FORBIDDEN`，商品与图片保持不变。

实际结果：账号 B 获取、编辑、软删除或变更账号 A 商品状态时均返回 `PRODUCT_FORBIDDEN`，账号 A 商品与状态保持不变。

## 23. 安全补测结果

此前延期项已全部通过：

1. 跨账号商品获取和编辑被拒绝；
2. 跨账号商品软删除被拒绝；
3. 跨账号商品状态操作被拒绝；
4. 跨账号云存储图片删除被拒绝，原图片保留；
5. 编辑移除的旧图片完成真实云存储清理，保留图片未被误删。

以上结论来自用户完成的人工验收。当前 CLI 无法独立读取数据库和云存储安全规则，因此权限规则本身以云开发控制台人工确认记录为准。

## 24. 已知限制

- 图片排序未实现；
- 已售商品禁止编辑；
- 不提供 deleted 回收站或恢复；
- 图片引用查询和云文件删除不是数据库事务的一部分；
- 引用查询失败时会保守保留文件，可能暂时占用存储；
- 结果未知后若又发生另一项并发变更，可能需要人工核对孤儿图片；
- Nodejs16.13 和 SDK 传递依赖风险继续沿用第六阶段记录；
- 完整弱网、兼容性、体验版和正式发布审核回归尚未完成。

## 25. 本次发布与核验结果

2026-07-18 最终云端状态：

| 云函数 | 云端状态 | 运行时 | 超时 |
| --- | --- | --- | --- |
| `createProduct` | Active | Nodejs16.13 | 10 秒 |
| `productQuery` | Active | Nodejs16.13 | 10 秒 |
| `manageProduct` | Active | Nodejs16.13 | 10 秒 |

阶段 7B 初次使用仅代码更新后，真实回归发现云端包缺少 `wx-server-sdk`。最终已使用带远程 npm 安装的完整部署方式重新部署三个函数。下载核验确认三个函数的 `index.js`、`package.json`、`package-lock.json` 与本地 SHA-256 一致，云端包均实际包含 `wx-server-sdk@4.0.2`。

本地发布前回归：

- `node scripts/verify-project.js`：40 项通过；
- 43 个 JavaScript 文件通过 `node --check`；
- `git diff --check` 通过；
- 微信开发者工具 CLI 成功打开项目并完成编译；
- 首页、详情、“我的发布”和编辑页真实只读回归通过；
- 商品文字与图片编辑、version 冲突、软删除、真实图片清理及双账号安全测试均人工通过；
- Console error 和页面 exception 均为 0。

## 26. 回滚方案

若部署后出现阻断：

1. 停止真实编辑和删除验收；
2. 不物理删除任何商品文档；
3. 将 `createProduct`、`productQuery`、`manageProduct` 部署回稳定提交 `458637af700d8c137ccd5aa395d2281370dd308f`；
4. 保留已写入的 version、deleted 和清理状态，不批量回写；
5. 重新验证公开读取、发布和第七阶段 A 状态管理；
6. 根据清理任务状态人工核对云文件，不执行批量删除；
7. 修复后重新部署并再次完成并发、软删除和图片生命周期验收。
