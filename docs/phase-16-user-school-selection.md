# 第十六阶段：用户学校归属与首次选择流程

> 实施日期：2026-07-28（Asia/Shanghai）
> 开始基线：`c932cc4fc28dbd5fda6d5ba861c7034621406224`（`phase-15-complete`）
> 当前状态：第十六阶段已完成；源码、云端部署、自动验证和最终人工验收全部通过
> Git 边界：未提交、未推送、未创建 `phase-16-complete`

## 1. 阶段目标与边界

本阶段让已登录且资料完整的用户拥有可信学校归属，并为新用户和缺少学校字段的历史用户提供首次选择流程。

本阶段没有给 `products` 增加 `schoolId`，没有修改商品创建、编辑或公共查询的学校逻辑，没有实现同校市场隔离、跨校详情策略、学校切换、冷却期、历史商品迁移或商品学校索引。其他 2950 所 `pending` 学校保持原状态。

## 2. 开始前真实工程审计

- 认证云函数为 `cloudfunctions/authUser/index.js`，现有 action 为 `login/current/updateProfile`。
- 用户使用 `cloud.getWXContext()` 返回的 `APPID + OPENID` 生成确定性 `_id`，同时保存服务端内部 `openid`；客户端不接收内部身份。
- 新用户创建位于 `login()`，资料更新位于 `updateProfile()`。
- 安全用户摘要原有字段包括公开 ID、昵称、头像、自由文本 `campus`、资料完成状态和安全时间。
- `AuthStore` 位于 `store/auth-store.js`，唯一持久摘要键为 `auth:user-summary`，缓存使用 `wx.getStorageSync/setStorageSync/removeStorageSync`。
- 登录资料页为 `pages/login`；安全回跳使用 `AUTH_TARGETS` 白名单、`AuthGuard` 和带进程内锁的 `NavigationService`。
- 首页原来直接加载公共商品；发布、消息、收藏、本人商品、编辑、聊天和预约等页面复用 `AuthGuard.requireLogin()` 或同等入口。
- `SchoolService` 已提供 `listSchools/searchSchools/getSchoolDetail`，统一调用只返回 active 学校的 `schoolQuery`。
- 开始时没有学校选择页面或同类组件。
- `users` 与 `schools` 的真实权限边界均为客户端不可直接读写，业务访问统一经过云函数。

## 3. 用户字段与状态派生

`users` 首次成功绑定后增加：

```text
schoolId
schoolName
schoolSelectedAt
schoolUpdatedAt
schoolVersion
```

字段规则：

- `schoolId` 必须匹配阶段 15 的确定性 `schools._id`。
- `schoolName` 由服务端读取学校标准名称，忽略客户端同名字段。
- 首次绑定写入 `schoolSelectedAt` 和 `schoolUpdatedAt`，`schoolVersion = 1`。
- 同校重试不写数据库，不改变首次时间或版本。
- 原学校不存在、格式异常或不再 active 时允许重新选择；保留首次选择时间，更新学校和更新时间，并递增版本。
- 已绑定其他有效学校时返回 `SCHOOL_ALREADY_SELECTED`，本阶段不提供普通切换。

认证摘要新增：

```text
schoolId
schoolName
schoolSelectedAt
schoolUpdatedAt
schoolVersion
schoolRequired
schoolUnavailable
```

派生规则：

| 记录状态 | `schoolRequired` | `schoolUnavailable` |
| --- | --- | --- |
| 没有 `schoolId` | `true` | `false` |
| 保存字段格式异常 | `true` | `true` |
| 学校不存在 | `true` | `true` |
| 学校不是 `active + officialStatus: valid` | `true` | `true` |
| 学校有效且开放 | `false` | `false` |

学校不可用时不清空历史 `schoolId/schoolName`。有效学校名称在认证响应中以 `schools` 权威记录为准。

## 4. 云端接口

`authUser` 新增：

```text
action: selectSchool
data.schoolId: s_ + 32 位小写十六进制字符
```

服务端流程：

1. 使用 `getWXContext()` 确认当前微信身份并生成当前用户 ID。
2. 在数据库事务中读取当前 `users` 文档。
3. 校验用户存在、未停用且内部 `openid` 与真实身份一致。
4. 读取真实 `schools` 文档并校验 `platformStatus: active`、`officialStatus: valid` 和标准名称。
5. 根据首次绑定、同校幂等、有效学校不可改绑或不可用学校重选规则更新。
6. 只返回安全用户摘要。

相关错误码：

```text
INVALID_SCHOOL_ID
SCHOOL_NOT_FOUND
SCHOOL_NOT_ACTIVE
SCHOOL_ALREADY_SELECTED
USER_NOT_FOUND
USER_DISABLED
AUTH_FAILED
DATABASE_ERROR
INTERNAL_ERROR
```

客户端不能提交或修改其他用户 ID、OPENID、学校名称、角色、状态、创建时间或权限字段。

## 5. 客户端与路由

新增 `pages/school-select/`：

- 初始加载当前开放学校；
- 复用 `SchoolService.listSchools/searchSchools`；
- 350ms 搜索防抖；
- 通过请求版本防止旧响应覆盖新结果；
- 卸载后不再 `setData`；
- 包含加载、错误、空列表、搜索无结果和重试状态；
- 提交前显示学校名称与“当前阶段暂不支持自行切换”的确认框；
- 提交期间禁止搜索、重复选择和重复提交；
- 成功后立即更新 `AuthStore` 与本地摘要并进入原安全目标；
- 强制流程仍保留退出登录入口。

`AuthStore` 新增 `selectingSchool`、`selectSchool()` 和 `isSchoolReady()`。旧缓存没有学校字段时默认视为需要选校，云端恢复结果始终覆盖缓存占位；退出登录会删除完整摘要。

`AuthGuard` 增加：

```text
buildSchoolSelectUrl
requireMarketAccess
navigateAfterSchoolSelection
```

登录回跳的商品 ID 仍只允许原有安全格式。选校页使用 `redirectTo` 优先替换当前页面，导航锁和当前路由判断阻止重复打开；登录后若学校未就绪，先转选校页而不是直接进入原目标。

首页会等待认证恢复后再决定是否加载公共商品：匿名或认证临时失败仍按原规则公开浏览，已登录且资料完整但缺少有效学校的用户会转到选校页且不发起商品列表请求。自定义 TabBar、发布、消息、收藏、本人商品、商品编辑、聊天、预约和商品详情的新收藏/联系等入口统一受学校就绪状态约束。

## 6. 实际修改文件

核心源码：

```text
cloudfunctions/authUser/index.js
services/auth-service.js
store/auth-store.js
services/auth-guard.js
constants/routes.js
custom-tab-bar/index.js
app.json
pages/school-select/index.js
pages/school-select/index.json
pages/school-select/index.wxml
pages/school-select/index.wxss
```

入口适配：

```text
pages/home/index.js
pages/profile/index.js
pages/publish/index.js
pages/messages/index.js
pages/favorites/index.js
pages/my-products/index.js
pages/product-edit/index.js
pages/product-detail/index.js
pages/chat/index.js
pages/appointments/index.js
```

验证与文档：

```text
scripts/verify-school-selection.js
scripts/verify-project.js
package.json
README.md
docs/phase-16-user-school-selection.md
00-项目总交接文档.md
```

## 7. 自动验证

当前结果：

```text
npm run school-selection:verify
School selection verification succeeded: 109 checks passed.

npm run verify
Verification succeeded: 78 checks passed.

npm run schools:verify
School verification passed: 5 groups.

git diff --check
passed
```

阶段 16 专项覆盖历史用户与旧缓存、学校缺失/停用/active 状态、参数类型、pending 与不存在学校拒绝、权威名称、首次字段、同校幂等、有效学校不可改绑、不可用学校重选、真实身份隔离、安全响应、AuthStore 并发与缓存、退出清理、登录/学校守卫、目标保留、重复导航、页面路由和边界检查。

完整验证继续覆盖原登录、商品、媒体、浏览量、收藏、公开主页、聊天富消息、预约、地图地点和阶段 15 学校服务。

## 8. 云端部署

只部署了 `authUser`，没有部署其他函数，也没有修改集合、权限、索引、学校状态或批量数据。

部署后反查：

```text
目标：cloud:cloud1***6d8e
状态：Active
运行时：Nodejs16.13
入口：index.main
超时：10 秒
内存：256 MB
本地/云端 index.js SHA-256：
efa76091d903dd8572b760fb718e968a2a764f3355b9b19bf8457990016f725e
一致：true
```

无微信身份冷启动探针：

```text
current -> AUTH_FAILED
invalidAction -> INVALID_ACTION
InvokeResult -> 0
```

这些探针证明函数可冷启动且新代码已经上线，但不能代替真实微信登录身份的 `current/selectSchool` 验收。

微信开发者工具当前真实登录身份只读与负向联调：

```text
current：OK
profileCompleted：true
schoolRequired：true
schoolUnavailable：false
当前路由：pages/school-select/index?target=home
页面状态：success
开放学校：2
搜索“上海工程”：只返回上海工程技术大学
清空搜索：恢复 2 所
取消选择确认：schoolId 仍为空
pending 学校绑定：SCHOOL_NOT_ACTIVE
不存在学校绑定：SCHOOL_NOT_FOUND
数组 schoolId：INVALID_SCHOOL_ID
负向探针后：schoolRequired 仍为 true，未写入学校字段
控制台错误：0
运行时异常：0
```

初次部署验证没有代替用户在两所 active 学校中做永久选择；后续真实账号选择、恢复和最终人工验收结果见第 9、11 节。

依赖继续为 `wx-server-sdk@4.0.2`。本地生产依赖安装和加载通过；依赖审计仍为既有 `1 moderate / 5 high`，没有执行破坏性的 `npm audit fix --force`。

## 9. 人工验收结果

第十六阶段最终人工验收已通过，确认：

- 真实账号成功选择 active 学校，用户记录正确写入 `schoolId / schoolName / schoolSelectedAt / schoolUpdatedAt / schoolVersion`。
- “我的”页面正确显示权威 `schoolName`，不再错误显示“校园信息待完善”。
- 编辑资料页显示只读学校名称和“已绑定”，不能自由填写或修改学校。
- 修改昵称或头像不会清空或覆盖学校字段。
- 冷启动、热启动均能恢复当前账号学校状态。
- 首页、发布、消息、收藏、本人商品、商品编辑、聊天和预约等受保护入口工作正常。
- 退出登录后本地学校摘要正确清理，再登录可以恢复当前账号的权威学校。
- 控制台没有阻塞错误，最终真机或等价人工测试通过。

以下清单保留为本阶段验收覆盖记录。

### 9.1 历史用户补选

1. 使用尚无 `schoolId` 的真实账号冷启动。
2. 预期首页商品请求前进入“选择你的学校”。
3. 数据库检查：确认选择前用户没有新增学校字段。

### 9.2 学校列表与搜索

1. 初始列表只能看到上海工程技术大学、上海财经大学浙江学院。
2. 分别搜索完整名称和前缀，结果正确。
3. 搜索无结果时显示空态；清除后恢复两校。
4. 网络失败时显示错误态并可重试。
5. `pending` 学校不显示。

### 9.3 选择与数据库

1. 点击正确学校，先取消确认；数据库不得变化。
2. 再次点击并确认；页面显示提交态且只成功一次。
3. 检查 `users` 当前记录：
   - `schoolId` 对应真实 `schools._id`；
   - `schoolName` 与学校标准名称一致；
   - `schoolSelectedAt/schoolUpdatedAt` 存在；
   - `schoolVersion = 1`；
   - 其他用户资料和身份字段未被覆盖。
4. 成功后立即进入原目标，不需要重启。

### 9.4 幂等与不可改绑

1. 使用相同 `schoolId` 重放 `selectSchool`，应成功且不改变首次时间、版本。
2. 已绑定有效学校后请求另一 active 学校，应返回 `SCHOOL_ALREADY_SELECTED`。
3. 篡改为 pending、不存在、对象、数组、空值或超长字符串，分别安全拒绝。

### 9.5 恢复、绕过与退出

1. 冷启动、热启动均恢复学校且不再进入选校页。
2. 返回键、左上角返回、TabBar、发布、消息、收藏、聊天和预约入口不能绕过未选校状态。
3. 选校页退出登录后回到匿名首页，本地缓存不残留上一用户学校。
4. 换另一真实账号登录时只显示该账号自己的学校状态。

### 9.6 回归

检查登录、资料更新、首页、搜索、分类、排序、分页、商品详情、发布与编辑、图片/视频、地图选点、收藏、消息、文本/语音/图片/位置/商品消息、预约、系统消息、未读、商品状态和退出登录。

## 10. 已知限制与后续边界

- 第十六阶段源码、部署、自动验证和人工验收均已完成。
- 匿名用户继续按既有规则浏览公开商品；已登录但学校未完成的用户被强制进入选校流程。
- 本阶段没有独立学校变更审计集合。只有原学校不可用时允许重新选择，并通过保留首次时间和递增 `schoolVersion` 维持基本审计语义。
- 第十七阶段才能给新商品绑定发布时学校；现有商品仍没有 `schoolId`。
- 首页同校隔离、跨校详情、新关系权限、学校切换和存量迁移仍属于阶段 18—22。
- `authUser` 的 `wx-server-sdk` 依赖树仍有历史传递依赖告警；本阶段未执行破坏性强制升级，不影响功能验收。

## 11. `73.md` 学校名称 UI 联动修复

用户完成真实账号学校选择并确认 `schoolId/schoolName` 可保存、恢复后，发现“我的”页和编辑资料页仍沿用历史 `campus`。根因是 Phase 16 已完成权威数据层改造，但两个旧视图未切换展示和编辑字段。

本轮完成：

- “我的”资料卡使用 `schoolName > campus > 校园信息待完善`；`campus` 只保留历史兼容展示。
- 页面订阅 AuthStore，并在 `onShow` 后重新应用最新摘要；选校返回无需重启。
- 编辑资料页把校园输入改为单行省略的只读区域，显示“已绑定”及不可自行修改说明。
- 学校为空时显示“尚未选择学校”，并提供复用 AuthGuard 的选校入口。
- 登录和资料更新客户端载荷只保留昵称、头像，不再发送 `campus` 或学校字段。
- `authUser/login` 对新用户只初始化空 `campus`，对历史用户不覆盖；`updateProfile` 只写昵称、头像、资料完成状态和更新时间。
- 自动验证覆盖伪造 `campus`、全部学校字段、权威学校摘要保留、旧缓存、退出清理、只读布局和长校名省略。

验证与部署结果：

```text
npm run school-selection:verify：126 项通过
npm run verify：78 项通过
npm run schools:verify：5 组通过
JavaScript 语法：83 个文件通过
git diff --check：通过
authUser：Active / Available / Nodejs16.13 / index.main / 10 秒 / 256 MB
云端与本地 index.js SHA-256：
43c1ac6d9a06d39fe093a1b9e8b1fd583d88c21e4d22f483ebe79ef429fe163b
```

没有实现学校切换、商品学校字段、同校隔离、schools 修改或 campus 批量迁移。用户已确认学校名称 UI 联动、资料更新、冷/热启动恢复、退出清理、再登录恢复和最终人工测试全部通过。
