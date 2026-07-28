# 第十四阶段：多学校校园市场现状审计与架构设计

> 审计日期：2026-07-28（Asia/Shanghai）
> 审计基线：`2ca64122c864e980e0d74cfe07c1aa84bcb3085f`（`post-phase-13-location-ui-polish`）
> 阶段性质：只读工程审计、架构设计和本地验证
> 事实优先级：真实源码与 Git > 本文 > 历史阶段文档

## 1. 阶段结论

第十四阶段完成了真实工程、用户认证、商品、公共查询、分页、索引、收藏、消息、预约、路由、缓存和测试体系的审计，并形成了阶段 15—25 可直接执行的设计基线。

本阶段没有修改业务代码，没有创建 `schools` 集合，没有下载或导入高校数据，没有部署云函数，没有修改数据库或云存储权限，没有创建、删除或重建索引，没有读取或写入正式用户、商品及其他生产数据，也没有提前实现学校选择或 `schoolId` 业务。

没有发现阻止架构设计的现有代码缺陷。可以进入第十五阶段，但第十五阶段开始前仍需确认本文第 18 节的进入条件，并在任何云端写操作前单独核对权限与目标环境。

## 2. 当前工程基线

### 2.1 Git 与工程

| 项目 | 审计结果 |
| --- | --- |
| 项目根目录 | 当前 Git 仓库根目录 |
| 分支 | `main` |
| HEAD | `2ca64122c864e980e0d74cfe07c1aa84bcb3085f` |
| 远端关系 | `main...origin/main` 为 `0 ahead / 0 behind` |
| 开始时工作区 | 公开 Git 工作区和索引干净 |
| 私有资料 | 编号文档、本机 AppID 配置和本机云环境配置均由 `.gitignore` 忽略 |
| 技术栈 | 微信原生小程序、JavaScript、WXML、WXSS、JSON、Node.js 云函数、微信云开发 |

公开 `project.config.json` 和 `config/cloud.js` 只保存占位符。本机私有配置文件存在且被忽略；本文不读取或重复其真实值。未发现需要在本阶段修改 `.gitignore` 的安全问题。

### 2.2 主要目录

```text
assets/             聊天图标等静态资源
cloudfunctions/     11 个 Node.js 云函数
components/         5 个公共组件
config/             云环境公开配置与私有配置示例
constants/          路由、商品、分类和预约常量
custom-tab-bar/     自定义三入口 TabBar 和中间发布按钮
docs/               阶段 4—13 正式文档
mock/               仅用于本地验证的商品 fixture
pages/              16 个小程序页面
scripts/            本地完整性和业务边界验证
services/           客户端业务服务层
store/              认证状态和轻量版本状态
utils/              格式化与异步工具
```

云函数清单：

```text
appointmentAction / appointmentQuery
authUser
createProduct / manageProduct / productQuery / productViewAction
favoriteProduct
messageAction / messageQuery
userQuery
```

页面清单：

```text
home / messages / profile
login / publish
product-detail / product-edit / my-products
favorites / user-profile
chat / chat-product-picker
location-picker
appointment-create / appointment-detail / appointments
```

组件清单：

```text
category-tabs / empty-state / loading-state / product-card / search-bar
```

测试入口为 `npm run verify`，实际执行 `scripts/verify-project.js`；它还调用预约、商品地点和浏览计数专项脚本，使用本地 mock/harness，不连接正式云数据库。

## 3. 当前真实架构

### 3.1 用户身份、登录与资料

```text
App.onLaunch
→ AppStore.initialize()
→ CloudService.ensureCloudReady()
→ AuthStore.bootstrap()
→ AuthService.getCurrentUser()
→ authUser/current
→ cloud.getWXContext()
→ users
```

`AuthStore` 当前状态为：

```text
idle / restoring / anonymous / authenticated / error
```

当前 `isLoggedIn()` 的真实含义是：

```text
status === authenticated
&& user 存在
&& profileCompleted === true
```

系统已经区分“尚未恢复身份”“匿名或没有用户记录”“有用户记录但资料未完成”“资料完成”，但没有学校选择状态。`bootstrapPromise`、`loginPromise`、`profilePromise` 和 `operationVersion` 分别提供初始化复用、重复提交互斥和过期结果隔离。

用户由 `authUser/login` 使用 `APPID:OPENID` 摘要生成的确定性 `_id` 创建或复用；资料由 `authUser/updateProfile` 更新。客户端不直接访问 `users`，也不接收 `openid`。

登录回跳使用 `AUTH_TARGETS` 白名单，允许携带受格式限制的商品 ID。`NavigationService` 提供进程内导航锁，并封装 `navigateTo`、`redirectTo`、`switchTab` 和 `navigateBack`。

### 3.2 本地认证缓存

当前唯一持久认证缓存键为：

```text
auth:user-summary
```

只保存：

```text
id / nickname / avatarUrl / campus / profileCompleted
```

缓存只提供启动占位，`authUser/current` 会重新校准。退出登录会清除该键。项目没有持久化商品列表、分页游标、收藏列表或消息列表；这些数据主要保存在页面实例内存中。

### 3.3 商品创建与生命周期

```text
publish
→ ProductPublishService
→ 云存储上传
→ createProduct
→ getWXContext + users
→ products 确定性幂等写入
```

客户端提交标题、描述、价格、分类、成色、结构化地图地点、图片、可选视频和发布请求 ID。`createProduct` 重新校验媒体归属与地点，并由服务端生成卖家、状态、版本、计数和时间字段。

`manageProduct` 使用真实 OPENID 校验 `sellerOpenid`，通过字段白名单、数据库事务、`version` 和 `mutationId` 完成编辑、状态迁移、软删除和媒体清理。当前编辑白名单不含任何学校字段，适合作为未来“商品学校不可编辑”的现成安全基础。

当前商品状态：

```text
draft / available / reserved / offline / sold / deleted
```

普通管理迁移：

```text
available → offline
offline → available
available → sold
available|offline|sold → deleted
```

预约事务另维护 `available ↔ reserved → sold`。项目没有商品复制、恢复已删除商品或“重新发布为新商品”功能；`relist` 只是原文档从 `offline` 回到 `available`。

### 3.4 商品查询

```text
Page
→ ProductService / MyProductsService / PublicUserService
→ productQuery / userQuery
→ products
```

公共列表当前按 `available/reserved` 查询；详情允许 `available/reserved/sold`；用户公开主页展示 `available/reserved`；“我的发布”按所有者展示 `available/reserved/offline/sold`。

必须纠正一个容易误解的历史概括：公共商品、“我的发布”、收藏和用户公开商品当前使用的是页码与 `skip/limit`，不是游标分页。消息、聊天商品选择和预约才使用多字段游标。

### 3.5 收藏

`favorites` 只保存确定性关系 ID、`userOpenid`、`productId` 和时间，不保存商品快照或学校字段。收藏创建/取消与 `products.favoriteCount` 在同一事务内更新。

“我的收藏”先按收藏关系 `createdAt DESC, _id DESC` 做页码偏移，再逐条读取实时商品；`available/reserved/offline/sold` 可以展示，`deleted` 或缺失商品被跳过。这个结构适合保留跨校历史，学校标签应来自权威商品，不应复制到收藏关系。

### 3.6 消息、聊天和预约

会话由 `productId + 排序后的双方 OPENID` 生成确定性 ID。所有会话、消息、富消息商品选择和标记已读操作都重新校验当前 OPENID 是否为参与者。

会话和消息使用：

```text
lastMessageAt DESC + _id DESC
createdAt DESC + _id DESC
```

稳定游标。会话保存商品快照，商品富消息也保存服务端生成的可信快照。快照当前没有学校字段。

新会话允许商品状态为 `available/reserved`；已存在会话在商品未删除时可继续。聊天商品选择只允许会话双方的 `available/reserved/sold` 商品，并使用 `createdAt DESC + _id ASC` 游标。

预约查询和写入继续以会话参与者、买家、卖家和商品所有权为安全核心。学校切换不得替代或削弱这些权限。

### 3.7 全局状态

`AppStore` 只有：

```text
initializedAt
productsVersion
favoritesVersion
```

页面使用 `requestVersion` 丢弃过期请求，并通过 `productsVersion`/`favoritesVersion` 触发刷新。未来需要增加市场作用域与学校版本，但不能把本地值当成服务端权限依据。

## 4. 多学校功能影响范围

| 模块 | 当前实现 | 需要改动 | 主要风险 | 阶段 |
| --- | --- | --- | --- | --- |
| `authUser` | 返回身份、资料完成状态 | 返回学校状态；提供受控选校/切换 action 或独立学校 action | 把缓存学校当权威、停用学校未处理 | 16、20 |
| `AuthStore` | 认证与资料两层状态 | 增加 `schoolState/currentSchool/schoolVersion` | 导航循环、旧缓存误判 | 16 |
| `AuthGuard` | 白名单登录回跳 | 升级为身份、资料、学校分层访问守卫 | 历史页面被错误拦截 | 16、19 |
| 首页 | 匿名直接查询全市场 | 未选校只显示引导；已选校查询当前学校 | 全市场默认放行、切校旧响应覆盖 | 18、24 |
| 发布 | 只要求资料完成 | 展示只读学校；云端绑定当前学校 | 客户端伪造、停用学校发布 | 17 |
| 商品编辑 | 字段白名单不含学校 | 返回学校只读展示；继续禁止更新学校 | 误把切校同步到旧商品 | 17、21 |
| 商品状态 | 原文档状态迁移 | 所有状态保留原 `schoolId` | relist 时误改学校 | 17 |
| 公共列表/搜索 | `status/category/regex/sort + skip` | 服务端加入当前学校；升级或严格绑定分页作用域 | 跨校列表、分页串校、索引膨胀 | 18、23 |
| 商品详情/分享 | ID + 公开状态即可读取 | 统一跨校只读策略和操作限制 | ID 绕过列表隔离 | 19 |
| 用户公开主页 | 展示卖家全部公开商品 | 商品列表默认限制到查看者当前学校 | 从主页横向浏览其他市场 | 18、21 |
| 收藏 | 关系保留、实时回读商品 | 默认保留全部历史并显示学校 | 错误删除跨校收藏 | 21 |
| 新会话/预约 | 商品状态和参与者校验 | 新建关系增加同校/跨校策略校验 | 分享链接绕过学校边界 | 19、21、23 |
| 历史会话/消息/预约 | 参与者可访问 | 保持权限；快照和页面补学校标签 | 按当前学校过滤导致历史丢失 | 21 |
| 我的发布 | 所有者 + 状态 | 继续展示所有学校历史，显示标签 | 只按当前学校过滤 | 21 |
| 商品浏览计数 | 登录买家按商品去重 | 服从详情可见策略，无需复制学校字段 | 跨校详情禁用后仍计数 | 19、23 |
| `schools` 基础服务 | 不存在 | 官方数据、查询、状态校验、只读公开响应 | 数据源污染、导入接口暴露 | 15 |
| 存量数据 | 用户和商品无 `schoolId` | 统计、分类、dry-run、幂等迁移 | 严格查询后旧商品全部消失 | 22A、22B |
| UI | `campus/location` 容易被误认为学校 | 明确区分学校、校区自由文本和面交点 | 文案混淆、长校名布局 | 24 |

## 5. 用户数据模型设计

### 5.1 当前字段

| 字段 | 类型 | 来源与权限 | 用途 |
| --- | --- | --- | --- |
| `_id` | String | 服务端确定性生成 | 安全公开用户 ID |
| `openid` | String | `getWXContext()` | 服务端内部身份与权限 |
| `nickname` | String | 客户端输入、服务端校验 | 展示 |
| `avatarUrl` | String | 客户端上传 fileID、服务端校验目录 | 展示 |
| `campus` | String | 客户端可选自由文本 | 旧校园描述，不是权威学校 |
| `bio` | String | 当前创建为空，安全公开读取 | 简介 |
| `role` | String | 服务端固定为 `user` | 预留角色 |
| `status` | String | 服务端 | `active/disabled` |
| `profileCompleted` | Boolean | 服务端计算 | 昵称与头像完整性 |
| `createdAt/updatedAt/lastLoginAt` | Date | 服务端时间 | 审计与展示 |

### 5.2 首版必须增加

```javascript
{
  schoolId: "s_xxx",
  schoolName: "学校官方名称快照",
  schoolSelectedAt: Date,
  schoolUpdatedAt: Date,
  schoolVersion: 1
}
```

- `schoolId` 引用 `schools._id`，是查询与权限字段。
- `schoolName` 是便于认证摘要和历史展示的冗余快照，不是权威关联。
- `schoolSelectedAt` 首次成功选择后不再覆盖。
- `schoolUpdatedAt` 每次成功选择或切换时更新。
- `schoolVersion` 每次学校变化原子增加，用于缓存失效、并发比较和过期响应隔离。
- 安全响应增加计算字段 `schoolSelected`、`schoolState` 和 `currentSchool`，不返回任何内部同步字段。

服务端必须在事务中根据当前 OPENID 读取当前用户，再读取 `schools` 权威记录，校验 `officialStatus/platformStatus`，并忽略客户端提交的学校名称、开放状态和时间。

### 5.3 可后续增加

```text
schoolChangeAllowedAt / schoolChangeCount
lastSchoolMutationId
独立 userSchoolChanges 审计集合
schoolVerified 及认证详情
campusId / campusName
```

首版暂不增加学生认证、复杂风控、多个学校身份或校区关系。`users.campus` 继续兼容旧自由文本，不能被重命名或复用为 `schoolId`。

### 5.4 状态扩展

推荐统一用户就绪状态：

```text
identityPending
anonymous
profileRequired
schoolRequired
schoolUnavailable
ready
disabled
error
```

本地缓存可以保存安全 `currentSchool` 摘要以减少启动闪烁，但启动和关键写入仍必须由服务端复核。

## 6. 学校数据模型设计

### 6.1 主键推荐

用户和商品引用 `schools._id`，不直接引用学校名称或外部 `officialCode`。

推荐 `_id`：

```text
s_ + SHA-256("MOE:" + normalizedOfficialCode) 的前 32 位
```

理由：

- 导入可重复执行且 ID 稳定；
- 外部标识与平台引用解耦；
- 学校改名不改变内部 ID；
- 合并或获得新官方代码时可保留旧记录并建立新记录，不物理迁移历史引用。

`officialCode` 必须另建唯一索引，作为年度同步匹配键。若官方源发生代码纠错或合并，不覆盖旧 `_id`，由显式映射和状态变更处理。

### 6.2 最小可行字段

```javascript
{
  _id: "s_xxx",
  officialCode: "官方学校标识码",
  name: "官方名称",
  nameNormalized: "规范化搜索名称",
  province: "省级行政区",
  educationLevel: "本科/专科等",
  authority: "主管部门",

  officialStatus: "valid",
  platformStatus: "pending",

  dataSource: "MOE",
  sourceYear: 2026,
  sourceVersion: "明确版本",
  lastSeenAt: Date,

  createdAt: Date,
  updatedAt: Date
}
```

`officialStatus` 表示权威数据状态，`platformStatus` 表示平台运营开放状态，两者职责不同，均需保留。平台状态建议：

```text
active / pending / inactive / merged
```

首版采用“全国高校全部导入、仅明确运营学校 `active`”的安全开放策略。批量导入默认 `pending`，避免错误数据立即成为可选学校。

### 6.3 可选运营与搜索字段

```text
shortName / searchKeywords / formerNames
city / citySource
isHot / sortWeight
logoFileId
mergedIntoSchoolId
```

`shortName`、拼音和 `formerNames` 不作为首批导入阻塞字段。城市若不在官方原始名单中，不得仅凭学校名称猜测；应标记补充来源并允许为空。

第一版搜索推荐：

1. 空关键词按 `platformStatus + province + nameNormalized + _id` 分页；
2. 非空关键词优先做规范化官方名称前缀查询；
3. 精确匹配 `officialCode`；
4. 简称和旧名搜索在有可靠运营数据后增加；
5. 不假设数组包含或未锚定正则可以使用高效索引，阶段 15 必须用真实 CloudBase 查询能力和查询计划验证。

### 6.4 同步与删除规则

官方同步可更新：

```text
name / nameNormalized / province / educationLevel / authority
officialStatus / sourceYear / sourceVersion / lastSeenAt
```

同步不得自动覆盖：

```text
platformStatus / shortName / searchKeywords / isHot / sortWeight
city 的平台补充值 / logoFileId / 合并映射人工结论
```

官方名单中消失、合并或停办的学校只更新状态，不物理删除。只要已被用户、商品、会话快照或迁移记录引用，就必须永久保留可解析记录。

### 6.5 阶段 15 工具结构

当前工程没有管理员身份机制、通用数据导入框架、CI 工作流或公开数据 seed 入口。推荐新增本地离线工具，而不是公开可调用的管理云函数：

```text
data/schools/raw/                 原始官方文件和来源说明
data/schools/generated/           标准化 JSON
reports/schools/                  dry-run 与正式导入报告
scripts/schools/parse-moe.js
scripts/schools/validate.js
scripts/schools/diff.js
scripts/schools/import.js
```

是否跟踪原始文件取决于官方许可和体积；至少跟踪来源 URL、发布日期、校验和和转换版本。凭据只来自本机忽略配置或已认证 CLI 会话，不能进入脚本、报告或 Git。

## 7. 商品数据模型设计

### 7.1 当前模型摘要

当前权威字段包括：

```text
title / description / price / originalPrice
categoryId / categoryName / condition
images / coverImage / video
location / locationDetail / distanceText / tags
sellerId / sellerOpenid / sellerName / sellerAvatar / sellerVerified / campus
publishRequestId / status / version / viewCount / favoriteCount
createdAt / updatedAt / 状态时间
预约保留字段 / mutation 字段 / 媒体清理字段
```

`campus` 是发布时复制的旧用户自由文本，`location` 是面交点名称，`locationDetail` 是结构化地图地点。三者都不是学校主键。

### 7.2 推荐新增

```javascript
{
  schoolId: "s_xxx",
  schoolName: "发布时学校官方名称快照"
}
```

创建规则：

```text
getWXContext()
→ 确定性 users._id
→ 读取 active 用户
→ 读取 user.schoolId
→ 读取 schools._id 并校验可选状态
→ 服务端写入 product.schoolId / schoolName
```

客户端不提交正式 `schoolId`；即使为 UI 诊断携带，也必须忽略而不能作为写入来源。未选校、学校不存在、官方失效或平台未开放时禁止发布。

`schoolName` 推荐保留发布时快照，便于历史收藏、会话、消息和已停用学校展示；权限与查询永远以 `schoolId` 和 `schools` 权威状态为准。

编辑和状态迁移绝对禁止修改学校。所有状态包括 `offline/sold/deleted` 都保留原学校。用户切换学校后仍可通过所有权管理旧商品。

当前没有“复制/重新发布为新商品”。未来如新增：

- 原文档 `relist` 保持原学校；
- 复制为新文档视为新发布，绑定用户当时当前学校；
- 不得用复制动作修改旧商品的 `schoolId`。

### 7.3 老商品

无 `schoolId` 商品默认不进入任何正常校园市场。不要根据卖家后来选择的当前学校自动回填全部历史商品。

首版不强制给所有商品增加 `migrationStatus`。缺少 `schoolId` 本身即可作为未迁移判据；若阶段 22 的运营流程需要逐条认领，再增加受控 `schoolAssignmentStatus` 或独立迁移台账，不能由客户端任意写入。

## 8. 查询、分页、索引与缓存设计

### 8.1 查询入口审计

| 展示入口 | 当前调用与条件 | 当前排序/分页 | 当前索引 | 学校策略 |
| --- | --- | --- | --- | --- |
| 首页综合 | `productQuery/list`；`available/reserved` | 收藏、浏览、时间、`_id`；页码偏移 | `idx_status_favorite_view_createdAt_id` | 必须按当前学校 |
| 首页最新 | 同上 | `createdAt DESC, _id ASC`；页码偏移 | `idx_status_createdAt_id` | 必须按当前学校 |
| 价格升/降 | 同上 | 价格、时间、`_id`；页码偏移 | 两个价格索引 | 必须按当前学校 |
| 分类组合 | 增加 `categoryId` | 四种排序；页码偏移 | 四个分类索引 | 必须按当前学校 |
| 搜索 | 对标题、描述、分类、成色、地点、标签做转义正则 | 复用所选排序和页码偏移 | 组合索引未必能覆盖正则 | 必须按当前学校；需实测计划 |
| 下拉刷新/加载更多 | 重置或增加页码 | `count + skip + limit` | 同上 | 切校必须取消旧请求并归零 |
| 商品详情/分享 | `productQuery/detail`；ID + 公开状态 | 单条 | 系统 `_id` 为主 | 建议跨校只读，禁止新关系 |
| 用户公开主页商品 | `userQuery/publicProducts`；卖家 + 公开状态 | 时间、`_id`；页码偏移 | `idx_sellerOpenid_status_createdAt_id` | 默认只展示查看者当前学校 |
| 我的发布 | `productQuery/myProducts`；本人 + 状态 | 时间、`_id`；页码偏移 | 同上 | 保留所有学校历史 |
| 我的收藏 | 收藏关系页码偏移后逐条回读商品 | 收藏时间、`_id` | 两个 favorites 索引 | 默认保留全部并显示学校 |
| 会话列表/聊天消息 | 参与者条件 | 双字段游标 | 5 个消息索引 | 历史不按当前学校过滤 |
| 聊天商品选择 | 会话参与者的商品 | 时间、`_id` 游标 | 卖家商品索引 | 新分享需遵守会话学校策略 |
| 商品消息卡片 | 服务端快照 | 无列表查询 | 无 | 历史保留学校快照 |
| 预约列表/详情 | 买卖双方或会话参与者 | 更新时间、`_id` 游标 | 8 个预约索引 | 历史不按当前学校过滤 |
| 浏览计数 | 详情成功后按商品 ID | 确定性记录 | `_id` + 清理索引 | 只在详情策略允许时触发 |

项目当前没有商品详情相关推荐、独立热门页、浏览量排序选项或收藏数单独排序选项；“综合”排序同时使用收藏数和浏览量。

### 8.2 公共市场游标推荐

阶段 18 推荐把公共市场从页码偏移升级为稳定游标。每个游标至少绑定：

```text
scopeSchoolId
sortBy
categoryId
keywordDigest
statuses
最后一条记录的全部排序字段
_id
```

不同排序的记录字段：

```text
default:   favoriteCount, viewCount, createdAt, _id
newest:    createdAt, _id
priceAsc:  price, createdAt, _id
priceDesc: price, createdAt, _id
```

`schoolId` 是等值过滤和游标作用域，不是业务排序字段。云函数仍从可信当前用户读取学校，并拒绝或重置与当前学校不一致的游标。切校、分类、关键词或排序变化都必须创建新查询作用域。

如果阶段 18 为控制风险暂时保留 `skip/limit`，也必须做到：

- 服务端每次从用户记录解析学校；
- 请求版本和查询键包含当前学校；
- 响应回显安全 `scopeSchoolId`；
- 页面只接收与当前学校和查询键一致的结果；
- 切校立刻清空列表、总数、页码和加载状态；
- 继续保留最大页码 100 的边界。

### 8.3 当前 products 索引

最近正式文档确认的 9 个业务索引：

```text
idx_status_createdAt_id
idx_status_price_asc_createdAt_id
idx_status_price_desc_createdAt_id
idx_status_favorite_view_createdAt_id
idx_status_category_createdAt_id
idx_status_category_price_asc_createdAt_id
idx_status_category_price_desc_createdAt_id
idx_status_category_favorite_view_createdAt_id
idx_sellerOpenid_status_createdAt_id
```

公开索引以 `status ASC` 开始，分类索引随后为 `categoryId ASC`，再接真实排序字段与 `_id ASC`；本人/公开卖家索引为 `sellerOpenid ASC, status ASC, createdAt DESC, _id ASC`。

### 8.4 推荐新增索引草案

阶段 18 按现有 8 种公共查询对称增加：

```text
schoolId ASC, status ASC, createdAt DESC, _id ASC
schoolId ASC, status ASC, price ASC, createdAt DESC, _id ASC
schoolId ASC, status ASC, price DESC, createdAt DESC, _id ASC
schoolId ASC, status ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC

schoolId ASC, status ASC, categoryId ASC, createdAt DESC, _id ASC
schoolId ASC, status ASC, categoryId ASC, price ASC, createdAt DESC, _id ASC
schoolId ASC, status ASC, categoryId ASC, price DESC, createdAt DESC, _id ASC
schoolId ASC, status ASC, categoryId ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC
```

用户公开主页若按查看者学校过滤，可能另需：

```text
sellerOpenid ASC, schoolId ASC, status ASC, createdAt DESC, _id ASC
```

`schools` 候选索引：

```text
officialCode ASC UNIQUE
platformStatus ASC, nameNormalized ASC, _id ASC
platformStatus ASC, province ASC, nameNormalized ASC, _id ASC
platformStatus ASC, isHot DESC, sortWeight DESC, nameNormalized ASC, _id ASC
```

字段顺序依据是等值作用域在前、真实排序字段随后、`_id` 稳定收尾。搜索正则、数组关键词和游标复合条件是否能复用这些索引，必须在阶段 15/18 通过真实查询错误或查询计划确认，不能仅按名称创建。

旧 8 个公共索引在迁移、灰度和回滚期间保留；确认所有生产查询都带学校且稳定运行后，阶段 23 再评估删除。本人商品、聊天商品选择仍需要现有卖家索引，不能因多学校上线而删除。

### 8.5 缓存隔离

推荐在 `AuthStore` 保存安全 `currentSchool`，在 `AppStore` 增加：

```text
marketScopeSchoolId
marketVersion
```

学校切换成功后：

1. 原子更新认证用户摘要；
2. 增加 `marketVersion` 和 `productsVersion`；
3. 所有商品页面增加 `requestVersion`；
4. 清空首页列表、总数、页码/游标和加载错误；
5. 重新以新学校请求；
6. 任何未来持久商品缓存键必须包含 `schoolId + 查询条件摘要`。

搜索文字历史可以全局保留，但搜索结果缓存必须按学校隔离。未读、聊天和历史收藏缓存不应因切校删除，只需刷新学校标签。

## 9. 页面和路由设计

### 9.1 统一守卫

不建议再创建一套独立登录系统。推荐扩展现有 `AuthStore + AuthGuard` 为统一访问决策：

```text
身份仍在恢复 → 等待同一 bootstrap Promise
匿名/无用户 → login
资料未完成 → login?mode=profile
学校缺失或不可用且目标需要校园市场 → school-select
全部满足 → 目标页
```

新增白名单路由：

```text
/pages/school-select/index
```

学校选择页自身只要求身份与资料，不要求学校，避免循环。登录页成功后若学校缺失，应保留原 `target + productId` 并重定向到选校页；选校成功再使用现有白名单恢复目标。

### 9.2 页面访问建议

| 页面/能力 | 无学校用户 | 理由 |
| --- | --- | --- |
| 首页页面壳、登录、资料、关于 | 允许 | 提供补全入口，但首页不查询正常市场 |
| 学校选择 | 必须允许 | 补全学校 |
| 公共商品列表、搜索、分类 | 禁止查询 | 防止缺字段默认全市场 |
| 发布、新收藏、新会话、新预约 | 禁止 | 都会创建新的校园关系 |
| 消息、聊天、预约历史 | 允许已登录老用户 | 不破坏既有合法关系 |
| 我的发布、历史收藏 | 允许已登录老用户 | 便于处理旧数据和补选 |
| 外部分享详情 | 先完成身份/资料/学校，再执行跨校详情策略 | 避免分享绕过市场规则 |

### 9.3 首次选择与切换

- 新用户：头像和昵称成功后立即进入选校页，选校成功再恢复目标。
- 老用户：启动校准后进入首页壳会看到强引导；首次尝试公共市场或新写操作时强制选校，历史页仍可访问。
- 个人中心：在资料卡下方显示权威学校、状态和修改入口；未来认证状态放在同一区域。
- 首页：顶部显示当前学校，作为市场标识和切换入口。
- 发布页：只读显示“发布至：学校名称”，不能在表单内选择其他学校。
- 切换：服务端成功后再更新本地状态；失败保留原学校和所有页面数据。
- 退出：清除用户和学校摘要、市场作用域及页面版本，不删除历史消息或云端数据。

首版允许切换，默认采用服务端 7 天冷却；首次选择不受冷却限制。确认弹窗必须说明旧商品不迁移、首页会切换、新发布归属新学校。冷却时间应由服务端时间判断，不信任客户端时钟。

## 10. 收藏、消息和历史数据规则

### 10.1 收藏

- 收藏关系全部保留；
- 收藏页首版默认展示全部历史收藏并标注商品学校；
- 可在后续增加“全部/当前学校”筛选，但不能默认隐藏历史；
- 不给 `favorites` 复制 `schoolId`，实时使用商品 `schoolId/schoolName`；
- `deleted` 继续隐藏，缺失商品保持当前安全处理；
- 跨校只读详情允许打开历史收藏，但禁止新增跨校收藏；
- 取消收藏始终允许，避免用户无法清理历史关系。

### 10.2 会话、消息和预约

- 历史会话、消息和预约继续按参与者权限访问；
- 学校字段不能替代参与者校验；
- 会话商品快照、商品富消息快照和预约商品安全响应增加 `schoolId/schoolName`；
- 快照只用于展示和历史兼容，不用于决定权限；
- 新建跨校会话、新预约和聊天中发送新的跨校商品卡片应在阶段 19/21 按详情策略统一限制；
- 商品下架、售出、学校停用或用户切校不删除历史消息。

### 10.3 我的发布与公开主页

- “我的发布”显示所有历史学校商品，卡片标注学校；
- 原发布者可继续管理旧学校商品，编辑不能改变学校；
- 用户公开主页资料仍可访问，但公开商品列表默认限制为查看者当前学校；
- 从跨校历史详情进入卖家主页时，也不能借主页浏览该卖家其他学校市场。

## 11. 存量数据迁移方案

### 11.1 先决原则

严格学校查询启用前必须先完成只读统计和迁移准备。第十四阶段没有读取生产数据，因此现有无学校用户和商品的准确数量仍未知。

迁移不得使用：

```text
用户选了学校 → 自动把其全部历史商品归到该学校
```

### 11.2 老用户

- 不创建新用户文档；
- 下次 `authUser/current` 返回 `schoolRequired`；
- 用户完成资料后主动选择学校；
- 选择前可访问个人资料和合法历史关系，但不能浏览正常市场或创建新校园关系；
- 首次选择只更新当前确定性用户文档；
- 不需要批量猜测用户学校。

### 11.3 老商品分类

| 类型 | 推荐处理 |
| --- | --- |
| 明确测试商品 | 经用户确认后统一绑定专用测试学校，报告列出 ID 摘要和数量 |
| 正式 `available/reserved` | 由发布者逐条确认或管理员依据可靠证据分配；完成前退出公共市场 |
| `offline/sold` | 保留历史访问和管理；可延后归属，但不得进入公共市场 |
| `deleted` | 不恢复、不公开；保留原文档和迁移审计 |
| 已有收藏/会话/预约 | 关系保留，学校不能从关系参与者当前学校反推 |
| 无可靠归属 | 保持 `schoolId` 缺失或 `null`，列入 pending，不进入校园首页 |

### 11.4 dry-run、幂等与回滚

正式迁移工具至少输出：

```text
总用户/商品数
已有 schoolId
缺失 schoolId
按状态、卖家和引用关系分类
计划新增/更新/跳过/冲突/失败
目标学校及证据来源
输入文件校验和与运行版本
```

幂等规则：

- 仅处理仍缺少 `schoolId` 且与 dry-run 版本一致的记录；
- 已有合法学校的记录永不覆盖；
- 每次运行使用确定性迁移批次 ID；
- 记录成功、跳过、冲突和失败；
- 重试只处理未完成项；
- 生产写入分小批次并设置上限。

回滚准备：

- 正式写入前导出只读统计和目标记录备份；
- 保存每条记录原字段是否存在及原值；
- 回滚只撤销本批新增字段，不覆盖迁移后其他业务更新；
- 不物理删除任何用户、商品、学校、收藏、会话或消息；
- 写入后抽样核对公开隔离、历史访问和所有权。

### 11.5 实施顺序调整

原编号把阶段 22 放在严格查询之后，存在“旧商品瞬间全部不可见”的上线风险。保留阶段编号，但增加两个门：

```text
阶段 22A：只读盘点、分类、dry-run 和迁移工具
必须在阶段 18 严格查询生产启用前完成

阶段 22B：正式迁移、异常重试、抽样和收尾
在阶段 18 灰度前后按批准计划执行
```

## 12. 安全风险清单

| 风险 | 当前保护 | 后续措施 | 阶段 | 优先级 |
| --- | --- | --- | --- | --- |
| 客户端伪造 `schoolId` | 创建函数已不信任卖家等字段，但无学校逻辑 | 云端从 users 读取并校验 schools | 17、23 | P0 |
| 直接调用创建商品函数 | 已有 OPENID、用户和字段校验 | 增加学校必选与 active 校验 | 17 | P0 |
| 绕过学校选择读取全市场 | 当前会返回全市场 | 服务端 fail-closed，不接受客户端学校 | 16、18 | P0 |
| 修改他人学校 | 用户更新只基于当前 OPENID | 选校 action 固定当前确定性用户 | 16、20 | P0 |
| 编辑商品改变学校 | 当前白名单无学校 | 永久排除学校字段并加攻击测试 | 17、23 | P0 |
| ID 直接跨校读详情 | 当前公开状态即可读取 | 统一跨校只读响应与操作闸门 | 19 | P0 |
| 分享链接绕过隔离 | 当前直接带商品 ID | 与详情同一服务端策略 | 19 | P0 |
| 新建跨校会话/预约 | 当前只校验状态和参与者 | 新关系创建校验商品学校与用户学校 | 19、21 | P0 |
| 分页游标跨校复用 | 公共列表当前无游标绑定 | 游标绑定可信学校与查询摘要 | 18、23 | P0 |
| 旧学校请求覆盖新页面 | 有页面 requestVersion，无学校版本 | `marketVersion + scopeSchoolId` 双重丢弃 | 18、20 | P0 |
| 老数据缺字段默认放行 | 当前无学校字段 | 缺失即不可进入正常市场 | 18、22 | P0 |
| 停用学校继续发布 | 无 schools | 每次关键写入读取权威状态 | 15、17 | P0 |
| 非参与者聊天越权 | 已有严格参与者校验和真机验收 | 保持原校验，学校只加展示/新关系限制 | 21、23 | P0 |
| 导入接口暴露 | 当前无管理员导入接口 | 使用本地受控工具，不建公开 action | 15、23 | P0 |
| `schools` 被客户端写入 | 集合尚不存在 | `ADMINONLY`，只由后台工具写 | 15、23 | P0 |
| 同步脚本泄露凭据 | 私有文件已有忽略规则 | 使用已认证 CLI/环境，报告脱敏扫描 | 15 | P0 |
| 搜索正则滥用 | 商品搜索有长度/token 上限 | 学校搜索限长、限页、前缀查询、节流 | 15、23 | P1 |
| 学校频繁切换 | 尚无学校 | 服务端冷却、事务和版本控制 | 20、23 | P1 |
| 官方改名/合并导致孤儿引用 | 尚无 schools | 保留旧记录、状态与合并指向 | 15、22 | P1 |
| `schoolName` 快照过期 | 尚无字段 | 权限只看 ID；必要时受控更新展示 | 15、21 | P2 |

正式上线前所有 P0 必须自动化验证，并对 A/B 同校、C 跨校、D 无学校四类真实账号执行关键真机用例。

## 13. 测试矩阵

测试身份：

```text
A：学校 A 卖家
B：学校 A 买家
C：学校 B 用户
D：老账号，无 schoolId
```

| 场景 | 单元/本地 harness | 云函数集成 | 开发者工具 | 多账号真机 |
| --- | --- | --- | --- | --- |
| 官方数据解析、去重、必填、同步差异 | 必须 | 导入 dry-run | 不适用 | 不适用 |
| 学校列表、搜索、分页、停用过滤 | Service + query mock | 必须 | 必须 | 抽样 |
| 新用户选校、重复提交、网络失败 | Store/Guard | 必须 | 必须 | A |
| 老用户 D 补选与重启恢复 | Store/Guard | 必须 | 必须 | D |
| 非法、停用、合并学校 | 必须 | 必须 | 必须 | 抽样 |
| 商品自动绑定，客户端伪造失败 | 必须 | 必须 | 必须 | A/C |
| 切校后旧商品不迁移、新商品归新校 | 必须 | 必须 | 必须 | A |
| A/B 同校可见、C 跨校不可见 | Query harness | 必须 | 必须 | A/B/C |
| 搜索、分类、四种排序学校隔离 | Query harness | 必须 | 必须 | A/C 抽样 |
| 分页游标、切校中途请求、缓存串校 | 并发 harness | 必须 | 必须 | A 切校 |
| 跨校详情与分享只读策略 | 必须 | 必须 | 必须 | A/C |
| 跨校新增收藏/会话/预约被拒绝 | 必须 | 必须 | 必须 | C |
| 历史收藏、会话、消息、预约保留 | 必须 | 必须 | 必须 | A/B/C |
| 非参与者会话读取/发送仍拒绝 | 现有测试扩展 | 必须 | 必须 | C |
| 我的发布显示全部学校且可管理 | 必须 | 必须 | 必须 | A |
| 无学校商品排除、迁移幂等和回滚清单 | 迁移 harness | dry-run + 小批 | 抽样 | 人工核对 |
| App 重启、退出、学校缓存清理 | Store 测试 | 必须 | 必须 | A/D |
| 长校名、小屏、空态、错误态 | 静态/UI 检查 | 不适用 | 必须 | Android+iOS |

自动测试不能替代：

- 教育部来源文件真实性与许可核对；
- 生产 dry-run 报告人工审批；
- 学校开放策略确认；
- 多账号、双学校和分享入口真机验证；
- 微信公众平台隐私与最终发布材料复核。

## 14. 后续阶段计划

| 阶段 | 目标与输出 | 依赖 | 主要风险 | 验收重点 |
| --- | --- | --- | --- | --- |
| 15 | 官方数据解析、标准化、dry-run、`schools`、只读查询服务 | 本文模型和来源核验 | 数据污染、导入接口暴露 | 幂等、状态分离、客户端不可写 |
| 16 | 用户学校字段、首次选校、状态机和守卫 | active 学校查询 | 导航循环、老用户锁死 | 新老用户、恢复、停用学校 |
| 17 | 发布服务端绑定学校、编辑不可变、只读展示 | 用户学校可靠 | 客户端伪造、旧商品误改 | 绑定、幂等、切校后旧商品不变 |
| 22A | 生产只读盘点、迁移工具和 dry-run | 字段与学校数据稳定 | 归属证据不足 | 统计、分类、无写入报告 |
| 18 | 公共查询学校隔离、游标/作用域、索引 | 17 + 22A 上线门 | 旧商品全隐、分页串校 | A/B/C 查询矩阵 |
| 19 | 详情、分享、跨校只读和新关系闸门 | 18 | ID 绕过、历史不可用 | 所有入口一致 |
| 20 | 学校切换、冷却、版本和刷新 | 16—19 | 并发切换、缓存旧数据 | 原商品不迁移、首页即时刷新 |
| 21 | 收藏、消息、聊天、预约、主页和个人中心适配 | 19—20 规则稳定 | 历史关系被过滤 | 历史保留、标签正确、权限不弱化 |
| 22B | 正式迁移、冲突重试、回滚准备和抽样 | 22A 报告获批 | 误归属、不可逆写入 | 幂等、备份、失败可重试 |
| 23 | 权限、攻击、索引、查询计划和性能加固 | 全部服务端逻辑 | 索引膨胀、性能退化 | P0 清零、旧索引退役有证据 |
| 24 | 选校、首页、发布、详情和个人中心 UI | 业务稳定 | 先做 UI 导致返工 | 长校名、状态和错误体验 |
| 25 | 全量自动化、多账号真机、文档、发布收尾 | 15—24 验收 | 覆盖不足、发布声明错误 | 完整矩阵、迁移与发布记录 |

编号仍保留 15—25；只把阶段 22A 作为阶段 18 生产启用前的强制依赖，不把全部改造合并为一次性开发。

## 15. 本阶段实际修改

实际交付文件：

```text
新增 docs/phase-14-multi-school-audit.md
更新 README.md
更新 00-项目总交接文档.md（本地忽略的唯一总交接入口）
```

未修改：

```text
app、pages、components、services、store、cloudfunctions、scripts
project.config.json、config/cloud.js、.gitignore
任何云端集合、函数、权限、索引和正式数据
```

开始审计时公开 Git 工作区干净。本阶段只允许上述文档差异，不创建提交、推送或 `phase-14-complete` 标签；提交和标签等待用户验收与明确指令。

## 16. 验证结果

本阶段已执行以下本地无写入验证：

```text
npm run verify：68 checks passed
JavaScript syntax：69 / 69 files passed
JSON.parse：49 / 49 files passed
Markdown 本地链接：0 个 Markdown 链接目标，82 个 Markdown 文件扫描通过
文档路径引用：13 / 13 存在
尾随空白：README、阶段文档和总交接文档均通过
git diff --check：通过
Git 基线：main 与 origin/main 0 / 0，HEAD 仍为 2ca64122c864e980e0d74cfe07c1aa84bcb3085f
公开工作区差异：M README.md；?? docs/phase-14-multi-school-audit.md
忽略文件差异：00-项目总交接文档.md 已更新，继续由 .gitignore 保护
```

首次独立 JSON 检查曾使用 PowerShell `ConvertFrom-Json`，它因 `package-lock.json` 中合法的空属性名报错；随后改用 Node.js 原生 `JSON.parse`，49 个文件全部通过。该工具差异不是项目 JSON 错误。

以下操作明确未执行：

```text
真实云函数调用或部署
数据库集合、权限和索引查询/修改
正式数据统计或迁移
教育部名单下载与导入
微信开发者工具 preview 或外部上传
```

不执行原因是第十四阶段明确禁止云端和数据操作；真实云端现状继续以最近正式交接证据为参考，后续阶段操作前必须重新只读核对。

## 17. 未决问题与默认推荐

| 问题 | 备选 | 默认推荐与理由 | 确认阶段 |
| --- | --- | --- | --- |
| 学校引用字段 | 名称 / officialCode / 内部 `_id` | 引用内部确定性 `_id`；名称会变，官方代码保留为同步唯一键 | 15 |
| 是否存 `schoolName` | 实时 join / 冗余快照 | 保存快照；历史与列表无需多次 join，权限仍看 ID | 15—17 |
| 未选校能否进首页 | 强制离页 / 首页壳 | 允许首页壳但不查询市场，显示选校引导 | 16、24 |
| 老用户补选触发 | 启动强跳 / 首次市场操作 | 启动显示强引导，公共市场和新写操作强制，历史页可访问 | 16 |
| 跨校详情 | 严格不可见 / 只读 | 允许持有合法 ID 的跨校只读，显示学校和风险；禁止新收藏、会话、预约 | 19 |
| 是否允许切校 | 禁止 / 允许 | 允许，服务端确认与冷却，历史不迁移 | 20 |
| 切校冷却 | 无 / 7 天 / 30 天 | 首版 7 天；避免滥用且比 30 天更可恢复 | 20 |
| 收藏页范围 | 当前学校 / 全部历史 | 默认全部历史并标学校，可后加筛选 | 21 |
| 跨校聊天历史 | 隐藏 / 保留 | 保留，权限继续按参与者 | 21 |
| 我的发布范围 | 当前学校 / 全部 | 全部历史并标学校，所有者继续管理 | 21 |
| 无 schoolId 老商品 | 归卖家当前校 / 默认测试校 / pending | pending 且退出公共市场，按证据处理 | 22 |
| 学校停用后的用户 | 自动切校 / 保留并要求重选 | 保留旧引用，阻止新市场/发布并引导重选，历史可访问 | 16、20 |
| 学校开放策略 | 全国 active / 分状态 | 全国导入默认 pending，运营确认后 active | 15 |
| 首版搜索 | 未锚定模糊 / 名称前缀+地区 | 名称规范化前缀、地区分页、官方代码精确；真实查询计划验证后扩展 | 15 |
| campusId | 首版必填 / 可选预留 / 不出现 | 数据设计预留但首版不写入、不要求 | 15、24 |
| 新索引 | 复制全部 / 最小动态 | 8 个学校公共查询索引草案，按真实报错和计划最小创建 | 18、23 |
| 旧索引 | 立即删除 / 全保留 | 迁移与灰度期保留；23 阶段有证据再退役公共旧索引 | 23 |
| 上线阻塞风险 | 允许部分遗留 / P0 清零 | 所有 P0、迁移 dry-run、A/B/C/D 矩阵和缓存串校必须通过 | 25 |

## 18. 下一阶段进入条件

进入第十五阶段前应满足：

1. 用户确认第十四阶段审计结论或明确覆盖其中的默认产品决策；
2. 保持业务代码基线不变，确认本阶段只有文档差异；
3. 明确教育部官方名单的实际年份、官方下载页、文件格式、发布日期和使用说明；
4. 确认首批学校开放策略，默认“全国导入、运营学校 active、其余 pending”；
5. 确认学校内部主键与 `officialCode` 唯一键方案；
6. 确认阶段 15 只做学校数据与查询服务，不提前绑定用户或商品；
7. 云端操作前重新核对目标环境、权限、现有集合和索引，并取得相应授权；
8. 导入前先完成本地解析、校验、重复检测、dry-run 和脱敏报告；
9. 不创建公开可调用的管理员导入 action；
10. 第十四阶段本地验证全部通过，无业务代码或敏感文件混入。
