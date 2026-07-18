# 第六阶段安全加固与发布准备

更新时间：2026-07-18

项目：即出——校园闲置物品线下面交微信小程序

云环境：`cloud1-d9gpdpv6p2db56d8e`

## 1. 使用边界

本阶段只处理安全、异常、测试和发布准备，不新增收藏、聊天、消息、订单、支付、商品管理或新业务页面。

当前发布定位：

- 校园闲置物品信息展示和线下面交；
- 不提供在线支付、担保交易、购物车、物流或资金结算；
- 商品文字和图片属于用户生成内容；
- 微信身份只用于登录、会话恢复、卖家归属和权限校验。

本文件记录源码、自动化验证和已获得的人工验收结论。数据库权限、云存储权限、商品组合索引、云函数部署及主要登录、读取和发布流程均已确认；此前延期的跨微信身份删除他人图片拒绝测试已在第七阶段补测通过。当前规划范围内的核心安全人工验收已经完成，但弱网、兼容性、体验版和微信官方审核仍属于独立发布前工作。

## 2. 审计范围

已检查：

- `app.js` 云环境初始化；
- `authUser`、`productQuery`、`createProduct`；
- AuthService、AuthStore、AuthGuard 和安全导航；
- ProductService、首页、商品详情；
- ProductPublishService 和发布页；
- 登录页、个人中心、自定义 TabBar；
- `users` 和 `products` 的访问边界；
- 商品图片选择、上传、重试和清理；
- 日志、缓存、公开返回字段和敏感配置；
- 四个云函数的依赖锁文件、npm audit 和云端运行时；
- 商品查询、分页、排序和索引需求；
- 体验版与微信审核所需材料。

## 3. 风险与处理结果

### P0

未发现可直接导致账号或全量数据失控的已确认源码问题。

### P1

#### 生产商品查询函数暴露测试数据写入口

- 位置：`cloudfunctions/productQuery/index.js`
- 触发条件：云端误将 `PRODUCT_SEED_ENABLED` 设置为 `true`，调用者提交固定确认字符串。
- 影响：任意调用者可能覆盖固定测试商品文档。
- 修复：生产云函数仅保留 `list` 和 `detail`；删除 `seed` action 和随函数部署的种子文件。
- 状态：源码已修复并部署到 `cloud1-d9gpdpv6p2db56d8e`，云函数状态为 `Active`。
- 验证：自动测试和真实云端调用均确认 `seed` 返回 `INVALID_ACTION`；云端下载包与本地源码哈希一致，且不包含 `seed-products.js`。

#### 数据库和云存储权限

- 位置：云开发控制台。
- 触发条件：集合或存储仍允许客户端公开写入或任意登录用户写入。
- 影响：可能绕过云函数修改身份、商品或删除他人图片。
- 修复：按第 5、6 节设置数据库和云存储最小权限。
- 状态：已人工确认 `users`、`products` 均为所有用户不可读写；云存储为所有用户可读、仅创建者可读写。
- 验证：真实图片上传和公开读取已通过；第二个微信身份删除第一个用户图片时被云存储规则拒绝，原图片保持存在。该补测结论由项目操作者于 2026-07-18 人工确认，文档不记录完整 OPENID 或 fileID。

### P2

#### 云文件路径校验过宽

- 原位置：`createProduct` 的路径子串匹配，以及客户端仅按 `cloud://` 过滤清理目标。
- 影响：可能引用不属于规范商品目录的云文件，或扩大孤儿文件清理范围。
- 修复：严格解析 `cloud://环境.桶/路径`，要求路径精确为 `products/{安全用户ID}/{YYYYMMDD}/{安全文件名.允许扩展名}`；客户端清理再次按当前用户目录过滤。
- 状态：源码已修复，`createProduct` 已部署并处于 `Active`。
- 验证：自动测试覆盖嵌套伪造目录、其他用户目录和非法扩展名。

#### 图片类型与空文件防御不足

- 原位置：发布页和 ProductPublishService。
- 影响：未知扩展名会被改名为 `.jpg`，无效或非图片文件可能进入上传流程。
- 修复：拒绝无效大小和不允许扩展名；保留 `chooseMedia` 的图片类型限制；上传前通过 `wx.getImageInfo` 验证文件能够作为图片解码。
- 状态：客户端源码已修复。
- 剩余边界：客户端校验不是服务端内容审核。云存储规则仍需限制目录、大小、扩展名；恶意内容和伪装文件需要后续内容安全能力或人工治理。

#### 查询页码无界

- 原位置：`productQuery`。
- 影响：恶意超大页码可能产生昂贵的数据库 `skip`。
- 修复：页码最大 100，页大小最大 20。
- 状态：源码已修复，`productQuery` 已部署并处于 `Active`。

#### 登录回跳失败可能永久锁定

- 原位置：`pages/login/index.js`。
- 影响：导航失败后按钮保持返回中状态。
- 修复：等待安全导航结果；失败时恢复 `isReturning` 并提示重试。
- 状态：已修复并有静态验证。

#### 云函数超时过短

- 最终只读查询结果：`authUser`、`productQuery`、`createProduct`、`manageProduct` 均为 `Active / 10 秒 / Nodejs16.13`。
- 影响：冷启动、组合查询或多次数据库操作可能在平台侧先超时。
- 处理：客户端认证和商品查询超时提高到 15 秒；发布保存保持 15 秒，图片上传 30 秒。
- 状态：四个业务云函数的云端超时均已调整为 10 秒。完整弱网和发布前兼容性回归仍需在独立发布流程中执行。

#### SDK 传递依赖和旧运行时

- 四个云函数：`wx-server-sdk@4.0.2`。
- 实际依赖链：`@cloudbase/node-sdk@3.17.2`、`@cloudbase/database@1.4.3`、`axios@0.27.2`、`lodash.set@4.3.2`、`lodash.unset@4.5.2`。
- 每个锁文件审计结果：1 moderate、5 high、0 critical。
- npm 当前稳定版仍为 4.0.2；`npm audit fix --force` 建议降级到 2.5.3，属于不安全破坏性变更。
- 当前缓解：云函数接口参数受限、不接受外部 URL、底层错误不返回客户端、数据库和存储应由最小权限隔离。
- 待办：关注官方稳定 SDK；不要强制降级。控制台若支持更高 Node.js 运行时，应在独立维护窗口升级、重新安装依赖、部署并完整回归。

### P3

#### 正则搜索扩展性

当前关键词最多 40 字符、5 个词元，但正则搜索不能使用普通索引。当前数据量很小，可接受；数据明显增长或查询耗时持续升高时，应评估受控全文检索，而不是继续扩大正则字段和词元数量。

#### 发布材料缺失

服务类目、主体资质、隐私保护指引、用户协议、隐私政策、内容规范、违规商品说明、联系方式和审核说明必须由项目主体确认，源码无法代替这些材料。

## 4. 身份、隐私和日志

### 登录与用户

- 客户端使用 `wx.cloud.callFunction`，不传可信 OPENID、角色或状态。
- `authUser` 使用 `cloud.getWXContext()` 获取 `OPENID / APPID`。
- 用户 `_id` 为 `u_ + SHA256(APPID:OPENID)` 前 32 个十六进制字符。
- 新用户角色和状态由云函数写为 `user / active`。
- `createProduct` 重新从云上下文生成用户 ID，并查询真实 `users` 文档；只有 `status === "active"` 才能发布。
- 客户端缓存仅含 `id / nickname / avatarUrl / campus / profileCompleted`，不含 OPENID、角色、状态、Token 或密钥。
- 退出登录删除安全摘要并使本地状态匿名化；公开浏览不被阻断。

### 商品公开字段

`productQuery` 使用显式字段映射返回公开商品。返回值不包含：

```text
sellerOpenid
publishRequestId
用户完整数据库记录
```

`sellerOpenid` 仅保存在服务端商品记录中用于内部归属和审计。如果未来不再需要，应通过独立数据迁移移除；当前不得破坏已验收数据兼容性。

### 日志

运行时代码只保留：

- 云函数 action 和脱敏错误 code；
- 孤儿文件清理失败数量；
- 不包含完整异常对象、请求对象、用户对象、商品对象、OPENID、临时图片路径或完整 fileID。

仓库中未发现 AppSecret、Access Token、密码、测试账号或硬编码 OPENID。AppID 和云环境 ID 属于项目公开配置，不是 AppSecret。

## 5. 数据库权限

官方说明：CloudBase 数据库安全规则只控制客户端访问；控制台和服务端仍可访问。配置入口为“云开发平台 → 文档型数据库 → 集合管理 → 权限管理/安全规则”：

<https://docs.cloudbase.net/database/security-rules>

本项目所有数据库访问均经云函数完成，因此建议：

当前确认结果（2026-07-18）：

- `users`：已设置为所有用户不可读写；
- `products`：已设置为所有用户不可读写；
- 登录、商品公开读取和商品发布仍可通过云函数正常完成；
- 商品查询客户端数据已确认不包含 `sellerOpenid`。

### users

```json
{
  "read": false,
  "write": false
}
```

判定标准：

- 客户端不能列出或读取任意用户记录；
- 客户端不能创建或更新用户；
- 客户端不能修改 `openid / role / status`；
- `authUser` 和 `createProduct` 服务端访问仍正常；
- 商品公开读取不返回 `sellerOpenid`。

### products

```json
{
  "read": false,
  "write": false
}
```

判定标准：

- 客户端直接 `wx.cloud.database()` 读取、创建、更新、删除均被拒绝；
- `productQuery` 仍能公开返回 `available / reserved / sold`；
- `draft / offline / deleted` 的列表和详情均不可公开读取；
- `createProduct` 仍能使用服务端 SDK 创建商品；
- 客户端不能修改卖家、状态、计数或时间。

不要为了未来商品编辑、下架或删除提前开放写权限。

## 6. 云存储权限

官方说明：云存储安全规则只限制客户端；服务端和控制台仍有完整权限。配置入口为“云开发平台 → 云存储 → 权限设置 → 自定义安全规则”：

<https://docs.cloudbase.net/storage/security-rules>

当前商品图片需要公开展示，但上传和删除只能由文件创建者执行。可按控制台实际规则语法核对以下最小策略：

```json
{
  "read": "/^products\\//.test(resource.path)",
  "write": "auth != null && auth.loginType == 'WECHAT' && resource.openid == auth.openid && /^products\\//.test(resource.path) && resource.size > 0 && resource.size <= 10485760 && (/\\.jpg$/.test(resource.path) || /\\.jpeg$/.test(resource.path) || /\\.png$/.test(resource.path) || /\\.gif$/.test(resource.path) || /\\.webp$/.test(resource.path))"
}
```

保存前在规则模拟器或测试环境验证创建和删除语义。判定标准：

- 未登录用户不能上传或删除；
- 登录用户可以上传自己的 `products/` 图片；
- 用户不能删除另一微信身份创建的文件；
- 超过 10MB、非允许扩展名、非 `products/` 路径写入被拒绝；
- 商品图片可被首页和详情页读取；
- 修改规则后等待平台生效，再做真机回归。

当前确认结果（2026-07-18）：

- 已设置为“所有用户可读，仅创建者可读写”；
- 当前用户选择、上传和公开读取商品图片已经验收通过；
- 跨微信身份删除他人图片时，云存储拒绝操作且原图片保留；
- 权限规则和跨账号拒绝结果依据项目操作者的云开发控制台人工确认，CLI 无法独立读取该规则。

## 7. 云函数检查与部署

### 源码状态

- `authUser`：可信身份、幂等用户文档、安全用户返回、禁用状态处理。
- `productQuery`：只读 `list/detail`、公开状态过滤、公开字段映射、页码和页大小上限、稳定错误结构。
- `createProduct`：可信身份、真实用户、严格参数、确定性商品 ID、幂等、服务端卖家/状态/计数/时间、严格图片目录。

### 部署结果

本阶段修改了：

```text
cloudfunctions/productQuery
cloudfunctions/createProduct
```

`productQuery` 和 `createProduct` 的第六阶段源码已部署到：

```text
cloud1-d9gpdpv6p2db56d8e
```

当前最终只读查询结果：

```text
authUser      Active / 10 秒 / Nodejs16.13
productQuery  Active / 10 秒 / Nodejs16.13
createProduct Active / 10 秒 / Nodejs16.13
manageProduct Active / 10 秒 / Nodejs16.13
```

四个云函数的云端下载包与对应本地正式文件完成核对；`authUser`、`createProduct`、`productQuery` 和 `manageProduct` 的 `index.js`、`package.json`、`package-lock.json` 共 12 项 SHA-256 全部一致，云端包实际包含 `wx-server-sdk@4.0.2`。真实调用 `productQuery/seed` 返回 `INVALID_ACTION`，没有重新初始化测试数据。

### 超时

当前已在云开发控制台将：

```text
authUser
productQuery
createProduct
manageProduct
```

超时调整为 10 秒并完成状态复核。冷启动、弱网和重复发布仍应纳入每次正式发布前回归。

## 8. 索引与性能

官方索引说明：

<https://docs.cloudbase.net/database/data-index>

`products` 的查询模式：

- 条件：`status in [available, reserved, sold]`
- 可选条件：`categoryId`
- 综合排序：`favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC`
- 最新排序：`createdAt DESC, _id ASC`
- 价格升序：`price ASC, createdAt DESC, _id ASC`
- 价格降序：`price DESC, createdAt DESC, _id ASC`
- 详情：`_id + status`，并限制 1 条

建议核对以下组合索引：

```text
status ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC
status ASC, createdAt DESC, _id ASC
status ASC, price ASC, createdAt DESC, _id ASC
status ASC, price DESC, createdAt DESC, _id ASC
```

分类查询需要在 `status` 后增加 `categoryId ASC`，分别对应上述四种排序。不要盲目重复创建；先查看现有索引和真实缺索引错误。

当前已有 9 个业务组合索引。以下 8 个用于公开商品查询：

```text
idx_status_createdAt_id
idx_status_price_asc_createdAt_id
idx_status_price_desc_createdAt_id
idx_status_favorite_view_createdAt_id
idx_status_category_createdAt_id
idx_status_category_price_asc_createdAt_id
idx_status_category_price_desc_createdAt_id
idx_status_category_favorite_view_createdAt_id
```

第 9 个用于“我的发布”：

```text
idx_sellerOpenid_status_createdAt_id
```

9 个索引的存在性依据项目操作者在云开发控制台的人工确认；当前 CLI 无法独立列出数据库索引。

首页综合、最新、价格升降序及分类查询已完成主要验证。

性能边界：

- 页大小默认 6、最大 20；
- 页码最大 100，避免无界 skip；
- 首页使用请求版本防止旧结果覆盖；
- 搜索 300ms 防抖；
- 上拉加载具备重复请求锁和去重；
- 详情仅查询 1 条；
- 图片最多 6 张，列表卡片只使用封面；
- 每页 `count + get` 在大数据量下仍有成本，应通过云函数耗时监控评估；
- 正则关键词查询不能命中普通索引，数据增长后需要独立检索方案。

## 9. 客户端异常处理

- 认证、商品查询、商品保存和图片上传均有客户端超时。
- 首页用 `requestVersion` 和 `isPageActive` 防止旧请求或页面卸载后 setData。
- 下拉刷新在 `finally` 中停止。
- 分页失败保留已有列表和页码，并允许单独重试。
- 发布页用 `isSubmitting` 防止重复提交，Loading 在 `finally` 中关闭。
- 页面卸载关闭发布 Loading；上传完成后检测页面状态并清理本次孤儿文件。
- 发布结果未知时保留原请求 ID 和已上传文件，安全重试不重复上传或重复写入。
- 登录回跳失败恢复按钮，不显示底层异常堆栈。
- 云端禁用、用户不存在或认证上下文失效会清理本地登录并引导重新登录。

## 10. 自动化与静态检查

执行：

```powershell
node scripts/verify-project.js
node --check cloudfunctions/authUser/index.js
node --check cloudfunctions/productQuery/index.js
node --check cloudfunctions/createProduct/index.js
node --check services/product-publish-service.js
git diff --check
```

当前自动验证结果：

```text
35 checks passed
```

新增覆盖：

- 生产种子 action 已关闭；
- productQuery 真实模块公开状态、公开字段、查询限幅和隐藏详情；
- sellerOpenid 不返回客户端；
- 字符串、Infinity 等非法价格；
- 图片数量、空文件、非法扩展名和解码检查；
- 严格用户图片目录和跨用户清理拒绝；
- 伪造卖家、状态、计数和时间覆盖；
- 用户不存在和用户禁用；
- 幂等发布；
- Loading、刷新和登录回跳清理；
- 运行时日志无敏感负载；
- 客户端无直接商品数据库写入。

## 11. 微信开发者工具检查

本阶段源码完成后已实际打开：

```text
pages/login/index
pages/home/index
pages/product-detail/index?id=product-001
pages/publish/index
pages/profile/index
```

实际结果：

- 五个请求路由均打开到目标页面；
- 编译和页面重启成功；
- exception：0；
- console error：0；
- 登录、首页、详情、发布和个人中心截图视觉检查正常；
- 首页商品标签、自定义 TabBar 和发布表单无明显回归。

截图保存在当前 Codex 可视化目录，文件名为：

```text
phase6-login.png
phase6-home.png
phase6-detail.png
phase6-publish.png
phase6-profile.png
```

## 12. 完整人工回归

截至 2026-07-18，已经确认：

- `users`、`products` 客户端读写权限均关闭；
- 云存储为所有用户可读、仅创建者可读写；
- 9 个业务组合索引已经创建；
- `authUser`、`productQuery`、`createProduct`、`manageProduct` 已部署并处于 `Active`；
- `seed` 返回 `INVALID_ACTION`；
- 登录、商品读取、商品发布、图片上传、重复提交和重启持久化等主要流程通过；
- 商品查询客户端数据不包含 `sellerOpenid`；
- 跨微信身份删除他人图片被拒绝，原图片保留。

以下清单继续作为完整发布回归口径；已完成的核心安全验收不替代弱网、兼容性、体验版和官方审核流程。

### A. 云端安全

1. 确认环境为 `cloud1-d9gpdpv6p2db56d8e`。
2. 确认四个云函数均 `Active`。
3. 确认 `productQuery` 和 `createProduct` 已部署本阶段源码。
4. 调用 `productQuery` 的 `seed` action，确认返回 `INVALID_ACTION`，且数据库没有变化。
5. 按第 5 节确认 `users` 客户端读写全部拒绝。
6. 按第 5 节确认 `products` 客户端读写全部拒绝。
7. 按第 6 节确认存储仅允许创建者写入/删除商品图片。
8. 核对 9 个业务索引和四个云函数超时。

### B. 登录

9. 清空缓存后首次登录，确认只创建一条用户记录。
10. 退出后再次登录，确认用户 `_id` 不变。
11. 完全关闭并重启，确认会话恢复。
12. 退出登录，确认安全摘要清理且匿名浏览正常。
13. 未登录点击发布，确认进入登录页；登录后返回发布页。

### C. 商品读取

14. 首页加载成功，测试下拉刷新和上拉分页。
15. 测试分类、综合、最新、价格升序、价格降序和关键词。
16. 打开公开商品详情；确认下架/草稿/删除商品不能公开打开。
17. 在调试器或网络响应中确认商品返回不含 `sellerOpenid`。

### D. 商品发布与存储

18. 选择图片、预览、删除并发布；确认云文件位于当前用户目录。
19. 尝试无效格式、空文件或超过 10MB 文件，确认不能进入发布。
20. 快速连续点击发布，确认只产生一条商品。
21. 弱网或中断保存后恢复，确认 Loading 结束并可用原请求安全重试。
22. 发布成功后打开详情、返回首页按最新刷新，并在完全重启后再次确认商品存在。
23. 检查商品卖家、价格、状态、计数和时间均由云端正确生成。
24. 用另一微信测试身份尝试删除前一用户的图片，确认权限拒绝。2026-07-18 已人工验收通过，原图片保持存在。

### E. 页面与导航

25. 检查登录页、首页、详情、发布页、个人中心和自定义 TabBar。
26. 模拟一次导航失败或快速点击，确认按钮不会永久禁用或重复跳转。
27. 模拟网络失败，确认首页、详情、登录和发布均显示友好错误且可恢复。

跨用户删除拒绝补测已经通过，第六阶段规划范围内的核心安全人工验收已完成；这不代表已经完成弱网、兼容性、体验版或微信官方审核。

## 13. 体验版上传步骤

1. 运行第 10 节全部检查并确保 `git diff --check` 通过。
2. 确认云函数已部署、权限规则生效、索引无报错、超时已调整。
3. 在微信开发者工具选择“上传”。
4. 使用未占用的版本号，项目备注写明“第六阶段安全加固与发布准备”。
5. 登录微信公众平台，进入版本管理，将刚上传的开发版本设为体验版。
6. 配置体验成员，使用至少两个不同微信身份执行第 12 节回归。
7. 保存测试记录、失败截图、函数日志时间和对应商品 ID。
8. 所有阻塞项关闭后再提交审核，不要把“上传成功”当作“审核通过”。

## 14. 微信审核准备清单

项目主体必须真实确认，不能由代码或本文代填：

- 小程序名称、头像、简介与实际功能一致；
- 主体类型、备案状态和服务类目适用于校园二手信息/线下面交；
- 隐私保护指引已声明微信身份、用户资料、商品文字、相册/相机图片、云存储用途和保存期限；
- 用户协议和隐私政策有真实主体名称、联系方式、删除/更正/投诉渠道；
- 内容规范和违规商品清单可被用户看到；
- 明确禁止违法、危险、侵权、虚假、成人、烟酒药品等不适合交易的内容；
- 明确平台不提供支付、担保、物流，线下面交需核验物品并注意人身和财产安全；
- 有用户生成内容的人工处置流程和联系人；
- 审核人员无需特殊数据即可浏览首页和详情；
- 登录和发布审核路径写清楚；
- 如需要测试身份，提供受控测试方式，不在仓库写入账号密码；
- 审核说明中不要声称尚未获得的资质、类目、备案或审核结果。

隐私保护指引需按微信公众平台当前检测结果和实际 API 使用逐项填写，尤其是图片选择/上传。提交审核前应在平台重新扫描并核对。

## 15. 当前已知风险

仍存在：

1. 云端仍为 Nodejs16.13；
2. 官方 SDK 的 1 moderate + 5 high 传递依赖风险无兼容稳定修复；
3. 用户生成商品文字和图片没有自动内容审核系统；
4. 服务类目、隐私、协议、联系方式和主体材料尚未确认；
5. 完整弱网、兼容性、体验版和正式发布回归尚未完成。

## 16. 不在本阶段解决

- 商品编辑、删除、下架和“我的发布”；
- 收藏、浏览记录；
- 私聊、消息、通知；
- 预约、订单、支付、物流；
- 举报后台、管理后台和复杂内容审核后台；
- 搜索推荐算法和大规模全文检索；
- 大规模 UI 或架构重构。

## 17. Git 边界

第六阶段正式代码提交为 `c16f6a34761fa7ad4f92229c5186e93fe3d534f6`。此前延期的跨用户图片删除拒绝测试已在后续阶段补测通过，因此可以补建 `phase-6-security-release-readiness` 注释标签并指向该提交。补建标签不得修改历史，也不得把交接文档纳入正式提交。
