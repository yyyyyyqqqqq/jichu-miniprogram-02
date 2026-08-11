# Phase 24 第一轮：UX 审计与关键流程修复

> 执行日期：2026-08-09；最终收尾复核：2026-08-11（Asia/Shanghai）
> 范围：启动路由、发布页地图返回认证竞态、消息学校摘要、全客户端 UX/UI 静态审计、自动化与微信开发者工具验证。
> 状态：Phase 24 第一轮人工验收已通过，正式收尾完成；这不等于 Phase 24 整体完成，第二、第三、第四轮尚未执行。

## 1. 接管基线与边界

| 项目 | 结果 |
| --- | --- |
| branch | `main` |
| HEAD | `77d051bb455123f31cfe54b6f56032b12ea21f26` |
| tag | `phase-23-complete` 指向同一提交 |
| main / origin/main | 启动时 0 ahead / 0 behind |
| 初始工作区 | clean |
| 本轮 Git | 人工验收后纳入第一轮中间稳定提交；不创建 `phase-24-complete` |

本轮没有重构登录模型，没有改变 `profileCompleted`、`authUser`、users/schools 数据模型、Phase 18—21 学校隔离/跨校关系/换校冷却/`schoolVersion` 语义，也没有修改数据库 ACL、云存储 ACL、索引、学校状态或正式业务数据。

`100.md` 已明确授权唯一云端变化：为 `messageQuery` 的安全用户摘要增加权威 `schoolName`，且只允许部署该函数。`appointmentQuery`、`userQuery` 的旧 `campus` 展示语义只记录，不顺带修改或部署。

## 2. 真实架构确认

- `app.js` 在启动时初始化 CloudBase；前台恢复由 `AuthStore.refreshCurrentUser()` 读取 `authUser/current`。
- `AuthStore` 是认证、资料、学校摘要和刷新共享 Promise 的内存真源，同时保存安全用户摘要；`AuthGuard` 根据登录、`profileCompleted`、学校有效性和 target 决定进入登录、选校或目标页。
- `profileCompleted` 当前表示既有资料流程已经完成，不等于“本次页面已经填写昵称/头像”，也不等于学校有效。
- 发布页在 `onShow` 调用 `AuthGuard.requireLogin()`；`wx.chooseLocation` 会令小程序页面隐藏后恢复，但不会按正常语义重建发布页。
- 消息列表、聊天和聊天商品选择器由 `messageQuery` 返回的参与者安全摘要驱动；旧实现只返回旧自由文本 `campus`。
- `app.json` 第一项本来就是首页，17 个注册页面及其 `.js/.json/.wxml/.wxss` 均存在；路由常量、登录/选校 target、tab 导航和公开/私有编译条件都指向存在的页面。

## 3. 三个关键问题

### 3.1 P0：体验版首次进入“页面不存在”

**现象**：体验版入口显示微信“页面不存在”。

**确认根因**：用户提供的原体验版二维码明确写死路径 `pages/index/index`，但当前工程没有该页面；真实首页是 `pages/home/index`。新用户扫描二维码时，微信优先按二维码携带的显式 path 启动，因此在小程序业务代码和登录流程执行前就由微信入口层显示“页面不存在”。当前 Git 基线没有已删除/改名页面残留，也没有代码导航到未注册页面；`project.config.json` 和被忽略的 `project.private.config.json` 中的编译条件也只包含有效的首页和商品详情。

**本轮修复**：在 `app.json` 显式设置 `entryPagePath: pages/home/index`，把普通冷启动/默认启动的代码侧入口固定为存在的首页，不增加宽泛 `reLaunch` 兜底，也不吞掉合法深链。

**平台修正与验证**：体验版二维码已经重新生成为 `pages/home/index`，用户提供的新二维码配置截图与当前源码完全一致，旧 `pages/index/index` 二维码应停止使用。新增静态路由门禁检查全部页面文件、tab 类型、target 和编译条件；开发者工具真实启动的 `launchPath`、`enterPath` 和当前 route 均为 `pages/home/index`；CLI preview 成功。新二维码的真实微信冷启动仍需由体验成员扫码确认，配置截图本身不能代替最终扫码结果。

### 3.2 P0：发布页地图返回后重新登录/循环

**真实生命周期**：

```text
已登录发布页 → wx.chooseLocation → 页面 onHide
→ 地图返回 → App.onShow + 发布页 onShow
→ 页面 AuthGuard 与 current 刷新并发
```

**根因**：旧 `App.onShow` 先执行 `CloudService.ensureCloudReady().then(...)`，把 `AuthStore.refreshCurrentUser()` 延后到微任务。发布页 `onShow` 的 `AuthGuard` 可能先以已认证状态开始、在异步边界让出执行权，随后 App 刷新把 store 切到 restoring，守卫恢复后把暂态误判为未登录并导航登录页。地图每次返回都会重复该竞态，形成循环。问题不是 location 数据，也不是页面实例重建。

**本轮修复**：`app.js` 的 `onShow` 直接同步发起 `AuthStore.refreshCurrentUser()`；`AuthService` 自身仍负责等待 CloudBase 就绪。页面守卫因此能够观察/等待同一份刷新 Promise，不再穿过“尚未发起刷新”的空窗。没有重写 AuthStore/AuthGuard，也没有绕过服务端 current。

**验证**：

- 逻辑测试覆盖已登录+有效学校、选择地点写回、取消不清空表单/旧地点；
- DevTools 使用真实登录态在发布页预置标题、描述和结构化地点，并发触发 App/Page 前台恢复：最终仍为发布页、`isLoggedIn=true`、未跳登录，表单和地点逐项保留；
- 项目负责人最终真机确认：真实地图选择/取消均不再跳登录或闪屏，表单、原地点和滚动体验保持正常。

### 3.3 P1：已选学校但聊天显示“校园信息待完善”

**根因**：截图位置是聊天页参与者摘要，不是消息 tab 自身。`cloudfunctions/messageQuery/index.js::safeUser` 只返回旧 `campus`，客户端 `normalizePublicUser` 和聊天/商品选择器也直接展示 `campus`；学校选择链路写入的权威字段是 `schoolId/schoolName`，因此 UI 永远拿不到已选学校。

**本轮修复**：

1. `messageQuery.safeUser` 增加只读 `schoolName`；
2. `MessageService.normalizePublicUser` 生成 `schoolDisplayName = schoolName || campus || 校园信息待完善`；
3. 聊天页和聊天商品选择器统一展示 `schoolDisplayName`；
4. `campus` 仅保留为旧响应兼容，不再覆盖非空权威 `schoolName`。

**云端结果**：只部署 `messageQuery`。部署前后均为 `Active / Available / Nodejs18.15 / index.main / 10s / 256MB`；源码 SHA-256 `e8b5d2e3270ed8e8e3d07750cde585eb7e5c0611e4ee0822df3f18acb468b675` 与远端一致，package hash `501eac1bb79c650772f255be715bc1df11a89dbea9ca85b610f12d75ccaaeaba`，lock hash `a4b7d66744288d5a2162b6ea8b9de5bf5de82ec2f681af3666cfa1c86a1fc38b`；远端实际可加载 `wx-server-sdk 4.0.2` 和 `ws 8.21.3`。环境变量指纹、runtime、handler、timeout、memory 均未变化。

**验证**：生产登录态只读 `listConversations` 确认参与者摘要含 `schoolName`；未知 action 返回 `INVALID_ACTION`；聊天页和聊天商品选择器真实加载并优先显示 `schoolName`，0 console error、0 exception。探针没有请求写操作或创建 fixture。

### 3.4 P1：系统选择器返回时发布页闪回未登录 UI

**人工现象**：第一轮原修复已经消除地图返回后的登录导航和死循环，但已登录用户打开/返回地点、图片或视频系统选择器时，发布页仍会短暂显示“登录后发布校园闲置 / 微信登录”，随后恢复表单。

**统一根因**：`AuthStore.bootstrap({ force:true })` 开始前台刷新时会保留缓存用户对象，却把全局 `status` 临时改成 `restoring`。`AuthStore.isLoggedIn/isSchoolReady` 要求 `status=authenticated`，因此发布页订阅在每次 App 从系统界面恢复时都会瞬间得到 `false` 并渲染登录占位。地点、相册和视频都触发相同的 App/Page 恢复生命周期，所以不是三个选择 API 的独立缺陷。

**状态语义修复**：

- 已由服务端确认的内存会话执行强制 refresh 时保持 `status=authenticated`、保留当前 user/学校摘要，同时设置 `restoring=true` 表达后台刷新；
- 服务端明确返回无用户时才进入 anonymous，明确 `USER_DISABLED` 时清用户并进入 error；普通网络/超时错误不会把已经可信的会话 UI 降级为未登录；
- 冷启动只有 storage cache、没有本次进程可信会话时仍使用 `status=restoring`，`isSchoolReady=false`，不能绕过 `authUser/current`；
- 发布页增加 `isAuthPending`：冷启动未知态显示“正在确认登录状态”，只有服务端/显式 logout 确认匿名后才显示微信登录；可信 refresh 期间继续显示原表单；
- 没有为 chooseLocation/chooseImage/chooseVideo 增加分支、延时或视觉遮盖。

**退出登录保护**：显式 logout 仍立即增加 operationVersion、清空所有进行中 Promise 引用、内存 user、学校摘要、`auth:user-summary`，写入 explicit logout marker。退出期间尚未完成的旧 refresh 即使晚返回也不能恢复用户；重新手动登录后只缓存当前真实账号及学校。

**验证**：Node 状态机验证覆盖冷缓存不可信、可信 refresh、refresh 网络错误、refresh 中 logout、旧响应丢弃和另一账号重新登录；发布页验证地点选择/取消、媒体保留、冷启动 pending 与匿名 UI。DevTools 连续模拟地点选择/取消、图片选择/取消、视频选择/取消、主动前后台切换7类恢复，共捕获28次认证 UI 更新，`isLoggedIn` 从未变为 false，登录/pending 占位均未覆盖可信表单。真实 DevTools 显式退出、reLaunch 保持匿名、缓存为空、商品列表不请求、再次手动登录恢复当前 schoolScoped 学校全部通过。

## 4. 全项目 UX/UI Audit

### 4.1 问题矩阵

| 优先级 | 页面/文件 | 复现与根因 | 本轮处理 | 推荐轮次 |
| --- | --- | --- | --- | --- |
| P0 | 启动；体验版二维码、`app.json` | 原二维码写死不存在的 `pages/index/index`；默认入口也未显式声明 | 二维码已改为 `pages/home/index`，代码增加显式首页入口 | 本轮新二维码扫码验收 |
| P0 | 发布；`app.js`、`pages/publish/index.js` | 地图返回时 App/Page `onShow` 竞态把 restoring 暂态当未登录 | 已修复并通过真机验收 | 第一轮关闭 |
| P1 | 聊天/聊天商品选择器；`messageQuery`、`message-service`、两页 WXML | 权威 `schoolName` 未进入安全摘要，UI 只读旧 `campus` | 已修复、只部署 `messageQuery` 并通过真机验收 | 第一轮关闭 |
| P1 | 发布；`auth-store`、发布页 JS/WXML | 系统选择器返回触发 force refresh，status 临时变 restoring 导致登录 UI 闪屏 | 已修复可信刷新状态语义和冷启动 pending UI | 本轮真机复验 |
| P1 | 预约参与者区域；`appointmentQuery.safeUser`、`appointment-service`、预约列表/详情/创建相关页 | 仍以旧 `campus` 生成参与者学校文案；已选学校可能显示待完善 | 按 `100.md` 明确不改、不部署 | Phase 24 第三轮前，建议 P1 |
| P1 | 公开用户/卖家资料；`userQuery.publicProfile`、`public-user-service`、`pages/user-profile` | public profile 同时有 `schoolName` 与旧 `campus`，部分摘要仍消费 campus | 按 `100.md` 明确不改、不部署 | Phase 24 第三轮前，建议 P1 |
| P1 | 我的页/选校页退出文案；`pages/profile/index.wxml`、`pages/school-select/index.js` | 仍写“浏览商品无需登录/匿名浏览”，与 Phase 18 已强制登录的真实规则冲突 | 只记录，避免扩大认证文案改造 | Phase 24 第二轮 |
| P2 | 发布描述、预约备注；`app.wxss` 及两页 textarea | 原生 `textarea` 漏出全局 `box-sizing:border-box`，`width:100% + padding` 超出父卡片 | 已做同根因的一行公共修复 | 本轮人工小屏验收 |
| P2 | 登录按钮；`pages/login/index.wxss` | 原生 button 依赖固定 `line-height`，内部默认度量导致文字视觉不居中 | 已增加 flex 双轴居中并通过真机验收 | 第一轮关闭 |
| P2 | 登录产品语义；`pages/login/index.js` | 明确退出后的既有 `profileCompleted=true` 用户可直接恢复服务端资料，页面却看起来像允许空头像/昵称新注册 | 不改模型，记录并给出第二轮方案 | Phase 24 第二轮，建议 P1 产品优先级 |
| P3 | 聊天页键盘/极小屏；`pages/chat/index.wxss` | `100vh`、原生 textarea、扩展面板与键盘高度组合在不同机型仍有遮挡风险；当前有 safe-area 但无全机型证据 | 只记录 | Phase 24 第三轮真机矩阵 |
| P3 | 长学校名/昵称/标题；多页卡片与固定操作区 | 多数位置已有 flex、`min-width:0` 或省略，但两行/多语言和极窄屏仍缺视觉矩阵 | 只记录 | Phase 24 第三轮 |

### 4.2 未发现新的阻断项

- custom tab bar、聊天输入栏、发布/商品详情/预约详情固定底栏均已处理 `env(safe-area-inset-bottom)`；没有证据支持本轮修改。
- 未发现 `100vw` 导致的全局横向滚动、无界图片/视频宽度、指向已删除页面的导航常量或宽泛启动重定向。
- 空态、加载态、错误态与重试在核心列表页均有既有实现；本轮没有为视觉一致性批量重写样式。

## 5. Phase 24 第二轮登录流程重构建议（仅分析）

### 5.1 当前耦合

当前 login 页同时承担：微信可信身份建立/恢复、昵称头像采集、资料编辑、target 保存与回跳、学校缺失判断和前往 school-select。`authUser/login` 返回或创建可信用户，`profileCompleted` 决定是否强制资料表单；学校是否可进入业务则由独立的 `schoolId/schoolName/schoolRequired/schoolUnavailable` 决定。

明确退出后再次点击发布时，既有用户的服务端记录仍可能 `profileCompleted=true`。点击按钮会恢复这个已经完成的资料摘要，因而当前页面里空着的输入框不再是新注册的必填数据。这是“身份恢复”与“资料采集”共用同一个按钮/页面造成的产品误解，不是校验被绕过。

### 5.2 推荐目标流

```text
点击受保护入口
→ 仅建立/恢复微信可信身份
→ 服务端 current/login 返回权威用户摘要
→ 无有效学校：进入 school-select
→ 有有效学校：按 AuthGuard target 返回原业务页
→ 昵称/头像作为“个人资料”能力独立编辑
```

建议保留 AuthStore 的单一权威摘要、共享刷新 Promise、target 白名单和 Phase 20 `schoolVersion` 失效机制。头像/昵称可在“我的→编辑资料”中补充；新用户可使用安全默认显示名/默认头像，但是否让空资料进入业务必须作为独立产品决策，不应继续借 `profileCompleted` 隐式控制身份建立。

### 5.3 兼容与云端影响

- 现有用户：原资料、学校、冷却与历史关系全部保留，不迁移即可兼容。
- 最小方案可能只调整客户端页面职责和 `AuthGuard` 顺序；若继续保留 `authUser/login/current/updateProfile` 现有返回结构，可不改 users 数据。
- 若决定重新定义或弃用 `profileCompleted`、为新用户持久化默认资料，才需要修改 `authUser` 或数据语义；届时必须单独暂停、设计向后兼容并取得云端部署授权。
- 绝不能把客户端传入的学校、openid/userId 或资料完成标志当作权限依据；学校仍由服务端 active/valid 记录、当前用户、`schoolVersion` 和 7 天冷却控制。

第二轮建议先形成状态机和页面原型，再决定是否需要云端变化，不在本轮实现。

## 6. 精确修改清单

- `app.json`：显式默认首页入口。
- `app.js`：前台恢复时同步发起 AuthStore 刷新，消除生命周期竞态。
- `store/auth-store.js`：可信前台刷新保持 authenticated UI；冷启动缓存仍需服务端确认；logout 晚响应失效。
- `pages/publish/index.js`、`pages/publish/index.wxml`：区分可信登录、认证待确认和明确匿名 UI。
- `app.wxss`：原生 textarea 纳入全局 border-box。
- `cloudfunctions/messageQuery/index.js`：安全用户摘要增加 `schoolName`。
- `services/message-service.js`：权威字段优先与旧响应回退。
- `pages/chat/index.wxml`、`pages/chat-product-picker/index.wxml`：使用统一展示字段。
- `pages/login/index.wxss`：按钮 flex 居中。
- `scripts/verify-phase-24.js`：86 项静态/逻辑/认证状态回归。
- `scripts/verify-phase-24-devtools.js`：真实 DevTools 启动、前台恢复、消息摘要与负向探针。
- `scripts/deploy-phase-24-message-query.js`：单函数部署守卫、哈希/配置/依赖复核。
- `package.json`：新增三条 Phase 24 命令。
- 本文：审计、部署、验证、风险与人工验收记录。

## 7. 验证结果

### 7.1 自动回归

| 命令 | 结果 |
| --- | ---: |
| `npm run phase-24:verify` | 86/86 |
| `npm run phase-18-explicit-logout:verify` | 28/28 |
| `npm run verify` | 81/81 |
| `npm run school-selection:verify` | 128/128 |
| `npm run product-school-binding:verify` | 51/51 |
| `npm run phase-18:verify` | 91/91 |
| `npm run phase-18-school-change:verify` | 79/79 |
| `npm run phase-18-auth-market:verify` | 16/16 |
| `npm run phase-19:verify` | 49/49 |
| `npm run phase-20:verify` | 78/78 |
| `npm run phase-21:verify` | 64/64 |
| `npm run phase-22:verify` | 42/42 |
| `npm run phase-23:verify` | 133/133 |

总计 926 项专项/综合断言通过。Phase 24 脚本同时覆盖全部项目 JavaScript 语法、JSON 解析、页面文件存在性、WXML/WXSS 关键静态约束；最终另执行 `git diff --check`。

### 7.2 云端与生产只读审计

- `messageQuery` 定向部署成功，只有该函数进入部署列表；2026-08-11 最终只读复核为 `Active / Available / Nodejs18.15 / index.main / 10s / 256MB`，环境变量指纹不变。
- 远端源码/package/lock SHA-256 与本地逐项一致；远端实际安装并可加载 `wx-server-sdk 4.0.2`、`ws 8.21.3`。
- DevTools 最终只读列举确认12个既有云函数均为 Active；本轮未部署 `appointmentQuery`、`userQuery` 或其他函数。
- Phase 23 生产基线为8个业务集合 `ADMINONLY`、存储 `READONLY`、索引数 users 2 / products 20 / favorites 4 / conversations 5 / messages 4 / appointments 10 / productViews 3 / schools 5。本轮所有云端工具均限定为 `messageQuery` 单函数部署或只读读取，没有 ACL、索引、学校状态、迁移、清理或正式业务数据写命令。
- DevTools 探针 `writesRequested=false`、`fixturesCreated=false`；未知 action 正确拒绝，未调用写 action。

### 7.3 微信开发者工具与 preview

- 首页、发布、消息、聊天、聊天商品选择器真实加载；登录和选校路由由静态门禁及现有页面验证覆盖。
- 默认 launch/enter/current route 均为首页；发布页7类前台恢复模拟捕获28次认证 UI 更新，未出现登录占位且表单保留；消息学校字段链路通过。
- 显式退出真实 DevTools 两阶段通过：退出后缓存/学校/商品 scope 立即清空，reLaunch 继续匿名且没有列表请求，手动登录后恢复当前真实学校。
- console error 0，runtime exception 0。
- 2026-08-11 最终 CLI preview 成功：`487779 Byte / 476.3 KB`，未出现 80051；二维码与 info 只写入被忽略的 `temp/`。

## 8. 最终人工验收结果

项目负责人已在真实体验版/真机确认以下项目全部通过：

- 新二维码路径为 `pages/home/index`，可正常进入，不再出现“页面不存在”；
- 地图选择和取消均不跳登录、不闪登录 UI，表单与原地点保留，选择结果正常写回；
- 图片、视频选择和取消均不闪登录 UI，发布表单保持；
- 系统选择器和前后台恢复期间可信已登录会话始终显示发布表单；
- 聊天显示权威 `schoolName`，不再错误显示“校园信息待完善”；
- 发布描述与预约备注 textarea 不再横向溢出，登录按钮文字居中；
- logout 后旧 user 与 `schoolId/schoolName/schoolVersion` 不复用，受保护入口正常要求登录，再登录恢复当前真实账号及学校。

以下原清单作为已完成验收证据保留：

### A. 体验版冷启动

- 使用路径明确显示为 `pages/home/index` 的新体验版二维码从微信正常打开，停止使用旧 `pages/index/index` 二维码。
- 确认不出现“页面不存在”。
- 确认进入首页，或按账号真实状态进入合法登录/选校流程。
- 如果旧二维码或旧分享卡片仍失败，不作为新入口回归失败；记录其来源并停止传播。

### B. 已登录发布与真实地图

- 登录并确认“我的”显示正确学校。
- 进入发布，填写标题、描述、价格、分类等。
- 打开微信地图并选择地点。
- 返回后确认仍停留在同一发布表单，不跳登录、不循环。
- 观察系统选择器打开和返回全过程，确认从未闪现“登录后发布校园闲置 / 微信登录”。
- 确认标题、描述、价格、分类、图片等原内容未丢失，地点名称/地址正确写回，滚动位置可接受。

### C. 地图取消

- 在已有内容和已有地点的发布表单打开地图后取消。
- 确认不跳登录、不循环、不清空表单，也不覆盖原地点。
- 分别选择/取消图片和视频，确认不闪登录 UI，已有标题、地点、图片和视频都不丢失。

### D. 消息学校信息

- 用已绑定 active 学校且存在会话的账号打开消息→聊天。
- 确认对方学校显示其权威学校名，不再错误显示“校园信息待完善”。
- 打开聊天扩展中的商品选择器，确认 owner 学校显示一致。

### E. UI 小屏与安全区

- 在一台窄屏 iPhone 和一台 Android 上检查发布描述、预约备注不横向溢出。
- 检查登录页“确认并登录”文字水平/垂直居中。
- 打开键盘检查聊天输入栏和底部安全区没有遮挡。

### F. 退出登录

- 退出后再进入发布/消息等受保护入口，确认登录引导正常。
- 确认页面不把上一个用户的学校摘要当作当前登录态。
- 对既有已完善资料账号，记录页面是否仍让用户误以为“空资料也能注册”；该项用于第二轮产品重构，不作为本轮模型改动。

## 9. 尚未处理的 Phase 24 后续工作

- 第二轮：登录流程产品与状态机重构；
- 后续统一处理 `appointmentQuery` 的旧 `campus` 语义；
- 后续统一处理 `userQuery` / 公开卖家资料的旧 `campus` 语义；
- 修正与 Phase 18 强制登录冲突的“匿名浏览”旧文案；
- 第三轮：全局 UI、小屏、safe-area、长文本和键盘兼容；
- 第四轮：多设备、体验版和全业务真机矩阵。

## 10. 当前结论

**Phase 24 第一轮正式完成**：代码、`messageQuery` 定向部署、926项自动回归、DevTools、preview、体验版/真机人工验收和正式收尾均已通过。该结论只覆盖第一轮“UX 审计 + 启动/认证/学校状态关键流程修复”，不代表整个 Phase 24 complete；不得创建 `phase-24-complete`，下一步是 Phase 24 第二轮登录流程重构。
