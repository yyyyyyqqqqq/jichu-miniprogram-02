# 第十七阶段：新发布商品绑定发布者学校

> 实施日期：2026-07-29（Asia/Shanghai）
> 开始基线：`7e95f85f4288a7102e5fe624752084e4d8330988`（`phase-16-complete`）
> 当前状态：第十七阶段已完成；源码、云端部署、自动验证和最终人工验收全部通过
> Git 收尾：本次提交将创建并推送 annotated tag `phase-17-complete`

## 1. 阶段目标

本阶段只让新发布商品在创建时绑定发布者当时的有效学校。商品学校由 `createProduct` 使用真实微信身份、权威用户记录和 `schools` 记录计算，客户端不能选择或伪造。普通商品编辑和状态变化不能修改学校，历史无学校商品继续兼容。

本阶段没有实现首页、搜索、分类、排序或分页的同校过滤，没有限制跨校详情、收藏、会话、聊天或预约，没有实现学校切换，没有迁移或推断历史商品学校，也没有创建同校查询索引。

## 2. 开始前真实工程审计

### 2.1 商品创建

- 商品创建云函数为 `cloudfunctions/createProduct/index.js`，没有 action 分发；入口是 `exports.main`。
- 客户端链路为 `pages/publish → ProductPublishService.publishProduct → createProduct`。
- 发布请求只有 `requestId` 和白名单商品对象；商品对象包含标题、描述、数值价格、分类、成色、结构化地图地点、图片和可选视频。
- `createProduct` 使用 `cloud.getWXContext()` 的 `APPID + OPENID` 生成确定性用户 ID，再查询 `users`。
- 卖家 ID、卖家 OPENID、卖家名称、头像、状态、计数、版本和服务端时间原本已经由服务端构造，不信任客户端同名字段。
- 商品 ID 由用户 ID 与 `requestId` 的 SHA-256 摘要确定，重复请求复用同一文档。
- 开始时只校验用户存在与 `status === active`，尚未校验 `profileCompleted`、用户学校或权威学校状态。

### 2.2 商品编辑与状态

- 商品管理云函数为 `cloudfunctions/manageProduct/index.js`。
- `updateProduct` 使用 `ALLOWED_UPDATE_FIELDS`、所有权校验、`version`、`mutationId` 和数据库事务。
- 更新白名单只包含标题、描述、价格、分类、成色、地点、图片与视频，不包含任何学校字段。
- 客户端提交额外字段会返回 `INVALID_PRODUCT_FIELD`，不会被对象展开覆盖。
- 下架、重新上架和标记售出的事务更新对象只包含状态、版本和服务端时间字段。
- 历史商品编辑使用现有文档上的可信字段，不会从当前用户记录补字段。

### 2.3 商品查询与客户端模型

- `productQuery` 提供 `list / detail / myProducts`，统一通过 `toPublicProduct` 和 `toMyProduct` 做安全白名单映射。
- 首页、搜索、分类和排序共用 `list`；详情使用 `detail`；本人商品使用 `myProducts`。
- 客户端 `ProductService.normalizeProduct` 统一处理列表、搜索、详情和其他商品展示所需的基础模型。
- 开始时商品输出没有学校摘要；历史缺字段不会触发业务错误，但客户端也没有稳定空值。
- 商品卡片不需要在本阶段全面改造；详情页适合增加一行轻量学校展示。

### 2.4 认证、学校与权限

- 第十六阶段用户字段为 `schoolId / schoolName / schoolSelectedAt / schoolUpdatedAt / schoolVersion`。
- 权威学校有效条件为 `platformStatus === active`、`officialStatus === valid` 且名称非空。
- `AuthStore.isSchoolReady()` 和 `AuthGuard` 已保护发布入口，但它们只是客户端流程控制，不能替代服务端校验。
- `products`、`users` 与 `schools` 均保持客户端不可直接写入；正式业务访问通过云函数。
- 开始时没有可跨云函数直接复用的公共服务端学校模块；阶段 17 在 `createProduct` 内复用与 `authUser` 相同的 ID、状态和名称规范，不引入新依赖或跨包复制体系。

### 2.5 验证体系

- 全项目入口是 `npm run verify`，覆盖 JSON、JavaScript、WXML、依赖、服务层与云函数动态 harness。
- 学校数据入口是 `npm run schools:verify`。
- 用户首次选校入口是 `npm run school-selection:verify`。
- 本阶段新增独立 `npm run product-school-binding:verify`，并接入完整 `npm run verify`。

## 3. 商品学校字段与语义

新发布商品增加：

```text
schoolId
schoolName
```

- `schoolId` 是发布者当前 `users.schoolId` 对应的稳定 `schools._id`。
- `schoolName` 是创建时从权威学校记录读取的标准名称快照。
- 两项字段只在创建时写入；用户未来学校变化不会自动改变旧商品。
- 不增加 `schoolBoundAt`：现有可信 `createdAt` 与学校绑定发生在同一次商品创建写入中，能够准确表达绑定时间，单独字段没有额外审计价值。
- 不增加 `publisherSchoolVersion`：当前阶段没有学校切换或基于用户学校版本的并发策略，增加该字段只会形成没有消费者的冗余数据。
- `campus` 继续只作为历史卖家展示字段，不作为商品学校关联、地点或权威来源。

## 4. 创建时服务端绑定

`createProduct` 的真实流程为：

```text
校验 requestId
→ cloud.getWXContext() 获取 APPID / OPENID
→ 计算确定性 userId
→ 查询 users 并核对内部 openid
→ 校验用户 active
→ 校验 profileCompleted、有效昵称和头像
→ 查询确定性 productId 是否已经存在
→ 已存在则按首次成功写入结果幂等返回，不回填历史商品
→ 校验 users.schoolId 存在且格式有效
→ 查询 schools 权威记录
→ 校验 active + valid + 标准名称
→ 校验商品、媒体和地图地点
→ 使用服务端白名单构造商品
→ 写入权威 schoolId / schoolName
```

当前错误码：

| 场景 | 错误码 |
| --- | --- |
| 微信云身份缺失 | `AUTH_CONTEXT_MISSING` |
| 用户不存在或身份不匹配 | `USER_NOT_FOUND` |
| 用户被停用 | `USER_DISABLED` |
| 资料未完成 | `PROFILE_INCOMPLETE` |
| 用户没有学校 | `SCHOOL_SELECTION_REQUIRED` |
| 学校 ID 异常、不存在、pending、inactive 或官方无效 | `SCHOOL_UNAVAILABLE` |

错误响应只包含稳定业务码与普通用户文案，不输出 OPENID、数据库异常、学校管理字段或堆栈。

## 5. 幂等与并发

- 重复请求继续使用原确定性商品 ID，只产生一个商品文档。
- 首次成功写入胜出；客户端以后使用相同 `requestId` 提交不同学校字段也只返回原商品。
- 阶段 17 将已存在商品检查放在学校校验之前，确保升级前结果未知的历史发布重试不会因为当前学校状态而失败，也不会给旧商品补学校。
- 新创建前会重新读取用户和学校，不依赖 AuthStore 缓存。
- 学校平台状态由受控运营工具修改；创建函数读取学校后到单文档写入之间仍存在极短管理状态竞争窗口。本阶段不为这一低概率管理并发大规模重构事务，阶段 23 可结合权限与性能加固再次评估。

## 6. 商品编辑不可修改

- `manageProduct` 的更新白名单没有 `schoolId / schoolName / schoolBoundAt / publisherSchoolVersion`。
- 客户端显式提交学校字段会收到 `INVALID_PRODUCT_FIELD`。
- 普通标题、描述、价格、分类、成色、媒体和地点编辑只更新已有白名单字段。
- 下架、重新上架、售出和软删除不包含学校字段。
- 历史无学校商品编辑后仍保持没有学校字段，不会读取卖家当前学校进行补齐。

`manageProduct` 既有实现已经满足上述边界，本阶段不修改也不重新部署该云函数。

## 7. 商品查询与历史兼容

`productQuery` 的安全商品摘要增加：

```text
schoolId: String
schoolName: String
```

- 新商品返回创建时快照。
- 历史商品统一返回空字符串，不返回 `undefined`。
- 不返回 `officialStatus / platformStatus / authority / sourceRow` 等学校管理字段。
- `ProductService` 同步规范化两项字段。
- 商品详情仅在 `product.schoolName` 非空时展示“发布校园”；历史商品不显示这一行。
- 首页、搜索、分类、排序、分页、详情、收藏、我的商品、聊天商品卡片、预约与系统消息继续沿用原行为。
- 本阶段不改造消息或预约内既有商品快照；后续阶段可按真实展示需求统一处理。

## 8. 客户端发布页

- 发布页从 `AuthStore.getCurrentUser().schoolName` 读取只读学校名称。
- 表单顶部显示“发布校园”，不可点击、不可切换，长名称单行省略。
- 创建请求仍只提交商品字段与媒体，不提交 `schoolId / schoolName`。
- `PROFILE_INCOMPLETE / SCHOOL_SELECTION_REQUIRED / SCHOOL_UNAVAILABLE` 有独立普通用户文案。
- 收到资料或学校错误后强制刷新当前用户云端摘要，再复用 `AuthGuard` 进入资料完善或既有学校选择流程。
- 服务端仍是最终授权来源；本地学校提示或缓存不能绕过创建校验。

## 9. 自动验证

本阶段专项动态与静态覆盖：

- 无身份、无用户、停用用户和资料未完成。
- 未选学校、异常 ID、不存在、pending、inactive 和官方无效学校。
- active + valid 学校允许创建。
- 服务端写入权威学校 ID 与名称，忽略伪造学校、卖家和 campus 字段。
- 安全响应不泄露学校管理字段或内部身份。
- 重复请求幂等，历史结果未知重试不触发学校回填。
- 普通编辑、伪造编辑、状态变化与历史商品编辑。
- 新旧商品查询学校摘要和空值兼容。
- 首页与搜索没有学校过滤；收藏、消息、预约权限未改变。
- 没有学校切换、历史迁移或第十八阶段内容。

完成实现后的本地结果：

```text
npm run product-school-binding:verify
Product school binding verification succeeded: 51 checks passed.

npm run school-selection:verify
School selection verification succeeded: 126 checks passed.

npm run verify
Verification succeeded: 79 checks passed.

npm run schools:verify
School verification passed: 5 groups.

JavaScript syntax：86 / 86 files passed
JSON.parse：67 / 67 files passed
git diff --check：通过
```

`npm run verify` 同时覆盖全部 JSON 解析、JavaScript 语法、WXML 静态结构、资源、相对依赖、敏感 API/依赖、各业务服务和云函数动态验证。最终公开候选扫描中真实 AppID、真实云环境 ID和本机绝对路径命中均为 0；被跟踪的依赖、临时目录、原始高校 XLS、本机私有配置和总交接文档均为 0。`docs/` 中只有这一份 Phase 17 文档。

## 10. 云端部署

实际只部署：

```text
createProduct
productQuery
```

- `createProduct` 修改商品写入和学校资格校验。
- `productQuery` 修改安全商品输出。
- `manageProduct`、收藏、消息、预约、认证和学校查询函数均未修改，不部署。
- 不创建集合、不修改权限或索引、不修改学校状态、不批量写入历史商品。

部署前后目标均由被忽略的本机私有配置确定，报告只保留掩码 `cloud:cloud1***6d8e`。最终反查：

| 云函数 | 状态 | 运行时 | 入口 | 超时 | 内存 | 本地/云端 `index.js` SHA-256 |
| --- | --- | --- | --- | ---: | ---: | --- |
| `createProduct` | Active | Nodejs16.13 | `index.main` | 10 秒 | 256 MB | `4cc99bb406b6cb8277d817571ce1c564a79a03dca19c8b8f8f49a37efd7fe35d`，一致 |
| `productQuery` | Active | Nodejs16.13 | `index.main` | 10 秒 | 256 MB | `72647f0e49b8218f7b070a0f922069af17cc6eda24a54726223c5d5db316509c`，一致 |

无微信身份冷启动探针：

```text
createProduct -> AUTH_CONTEXT_MISSING
productQuery 非法 action -> INVALID_ACTION
```

两项探针均 `InvokeResult = 0`，证明函数依赖可加载且新代码已经生效。部署没有修改函数运行时、入口、超时或内存。

## 11. 数据库与真实账号验证

已使用微信开发者工具当前真实身份和正常云函数链路完成受控验证：

- `authUser/current` 确认资料完整且绑定 active 学校。
- 复用本人一个可编辑商品的既有媒体与结构化地点，只创建 1 条阶段 17 测试商品，没有上传新媒体。
- 创建请求显式附带伪造 `schoolId / schoolName / sellerId / sellerName / status`；最终商品仍绑定真实用户和权威学校。
- `productQuery/detail` 返回的学校摘要与认证用户学校一致。
- 携带伪造学校字段的编辑返回 `INVALID_PRODUCT_FIELD`。
- 普通编辑成功后学校不变；下架并重新上架后学校不变。
- 找到一条本人历史无学校商品，使用原字段执行一次同内容编辑；编辑后查询仍稳定返回空学校摘要，没有自动补学校。
- 测试商品最终通过 `manageProduct/softDelete` 软删除，没有物理删除数据库文档；复用媒体仍由原商品引用，既有清理逻辑不会盲删。
- 开发者工具自动化过程记录 0 个红色控制台错误、0 个运行时异常。

随后使用管理端只读投影核对软删除后的测试文档，未输出 OPENID 或完整媒体字段：

```text
记录存在：是
schoolId 与真实用户学校一致：是
schoolName 与 schools 权威名称一致：是
sellerId 与真实安全用户 ID 一致：是
createdAt 存在：是
最终 status：deleted
最终 version 与业务响应一致：是
```

微信小程序客户端直接读取 `products` 的实际探针继续被拒绝；本阶段没有修改集合权限。没有批量更新、迁移或推断其他历史商品。

## 12. 最终人工验收结果

用户已经明确确认阶段 17 最终人工 UI 验收全部通过，实际结果如下。

### 12.1 正常发布与展示

- 发布页显示正确且只读的学校名称。
- 正常账号能够成功发布，商品详情正确显示发布校园。
- 学校名称与结构化面交地点各自展示，没有概念或字段混淆。

### 12.2 编辑、状态与历史兼容

- 普通编辑后学校字段保持不变。
- 下架、重新上架和其他商品状态变化后学校字段保持不变。
- 历史无学校商品不显示空白校园行。
- 历史无学校商品编辑不会自动补学校。

### 12.3 既有业务回归与阶段边界

- 首页和搜索仍保持未按学校隔离的阶段 17 行为。
- 收藏、聊天、富消息、预约和系统消息正常。
- 最终人工 UI 测试全部通过。

## 13. 已知限制与下一阶段边界

- 阶段 17 只建立新商品可信学校数据，不提供完整市场隔离。
- 历史商品仍没有学校归属，不能推断或自动补齐。
- 首页、搜索、分类、排序和分页尚未按当前学校过滤。
- 跨校详情、收藏、会话和预约仍沿用原规则。
- 学校切换、冷却期与历史关系保留尚未实现。
- 阶段 18 的同校公共市场查询必须先通过阶段 22A 存量统计门禁，再按已审计的稳定游标和最小组合索引实施。
- 公众平台兼容性、体验版与最终发布材料仍不属于本阶段完成结论。

## 14. Git 状态

阶段 17 的开发、部署、自动验证、真实账号验证和最终人工验收均已完成。本次 Git 收尾将执行：

```text
创建阶段提交
普通推送 main
创建并推送 annotated tag phase-17-complete
phase-16-complete 未移动
phase-15-complete 未移动
```

最终提交、远端同步和标签实际结果以收尾报告及 Git 远端反查为准。阶段 17 只维护本文件，不创建第二份完成文档。
