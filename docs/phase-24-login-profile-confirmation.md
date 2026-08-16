# Phase 24 Round 3 前置修正：显式登录与头像昵称确认

## 当前结论

本轮已完成客户端代码、专项测试、适用的 Phase 18—24 自动回归、DevTools 验证及项目负责人真实人工闭环；`110.md` 已明确确认登录、头像昵称确认、学校恢复和退出重登事务验收通过。每次用户主动发起的新登录现在都是一个显式 transaction：

```text
微信身份
→ 头像昵称确认
→ 权威学校检查
→ 必要时选校
→ 原 target
```

已有可信 session 的正常冷/热恢复不会重复要求资料确认；显式 logout 后保持 anonymous，只有再次点击“微信登录”才创建新 transaction。

本轮没有修改云函数、数据库、ACL、索引、环境变量或学校状态，也没有部署。该登录专项的人工验收已关闭；Phase 24 整体仍未完成。

## 微信头像昵称能力审查

项目目标基础库为 3.7.3。当前实现不使用 `wx.getUserProfile` 或 `wx.getUserInfo` 读取真实头像昵称，也不接入第三方身份或资料插件。旧接口不能作为“一键取得真实微信头像昵称”的可靠产品能力；本轮采用微信当前开放组件路径：

- 头像：`button open-type="chooseAvatar"`
- 昵称：`input type="nickname"`
- 身份：仍只由云函数 `cloud.getWXContext()` 确认

`chooseAvatar` 返回的本地/临时路径不会写入 `users`。页面复用既有 `AvatarService`，先完成解码、类型与 5 MB 大小校验，再上传到当前用户专属云存储目录，最后只把稳定 `cloud://` fileID 交给 `authUser/updateProfile`。上传成功而资料保存失败时，当前页面保留已上传 fileID，重试不会重复上传。

能力参考：腾讯云开发者社区的[微信头像昵称能力调整说明](https://cloud.tencent.com/developer/article/2245051)和 CloudBase 文档的[微信用户信息组件说明](https://docs.cloudbase.net/lowcode/components/wedaUI/src/docs/compsdocs/wxOpen/UserInfo)。

## 原行为根因

Round 2 的客户端在 `loginIdentity` 返回历史用户后立即写入 authenticated 状态，登录页随后直接检查学校并跳回目标。服务端保存的旧 nickname/avatar 因而被客户端等价为“本次登录已确认”，显式 logout 虽然清除了 session，却没有形成新的资料确认边界。

问题不在服务端身份或学校模型。服务端按 `_openid` 复用确定性用户是正确的，也必须保留历史资料、学校和关系；需要补的是客户端 transaction，而不是删除账号、清空数据库或重新耦合 `profileCompleted`。

## 状态模型

三个业务状态保持解耦：

```text
authenticated    = 可信微信身份已经建立
schoolReady      = authenticated + active 用户 + active/valid 权威学校
profileCompleted = 昵称/头像展示资料是否完整
```

新增的 `loginStage` 只描述一次用户主动登录的 UI transaction：

| 状态 | 含义 |
| --- | --- |
| `none` | 没有显式登录 transaction |
| `identityPending` | 正在请求可信微信身份 |
| `profileConfirmRequired` | 身份已建立，必须主动确认头像昵称 |
| `schoolSelectionRequired` | 资料已确认，但没有有效权威学校 |
| `ready` | 本次步骤完成，正在返回原 target |

`profileConfirmRequired` 不是新的服务端业务门禁。市场、发布、卖家主页等核心权限仍只依赖可信 active 身份和 `schoolReady`；页面守卫仅在显式登录 transaction 未完成时把用户送回相应步骤。

transaction 与 `target` 及必要参数一起保存到 `auth:login-transaction`。App 前后台切换或页面恢复时，只在服务端 `current` 返回同一个用户后恢复该 transaction；用户不一致、禁用、无用户或显式 logout 时清除。generation token 继续阻止 logout 前的 login/current/profile 晚响应复活 session。

## 流程结果

### 新用户

```text
anonymous
→ loginIdentity 创建确定性 active user
→ profileConfirmRequired
→ chooseAvatar / nickname
→ updateProfile
→ schoolSelectionRequired
→ selectSchool
→ ready
→ 原 target
```

### 已有用户正常打开

```text
可信 session / 服务端 current
→ 恢复 authenticated 与权威学校
→ loginStage=none
→ 正常业务页面
```

不会因为普通 onShow、bootstrap 或 ensureReady 频繁要求再次确认资料。

### 已有用户显式退出后重登

```text
logout
→ 清内存用户、认证摘要、学校摘要、资料展示缓存、transaction
→ 持久化 explicit-logout
→ App.onShow 仍 anonymous
→ 用户再次点击微信登录
→ loginIdentity 复用同一服务端 user
→ profileConfirmRequired
→ 确认资料
→ 原有效学校直接恢复
→ 原 target
```

恢复已有学校不调用 `selectSchool` 或 `updateSchool`，不会递增 `schoolVersion`、启动 7×24 小时冷却或修改历史商品学校。

## target 与参数

登录和选校链路现在统一保留白名单目标及必要参数，覆盖首页、发布、商品详情、消息、聊天、聊天商品选择、收藏、我的、公开用户资料、预约创建、预约详情和预约列表。所有 URL 参数都经过固定 target 和 ID 格式校验；未知 target 回落到安全首页。

例如：

```text
publish
→ login?target=publish
→ profile confirmation
→ school-select?target=publish（仅无有效学校）
→ publish
```

## 失败、取消与恢复

- 取消头像选择：停留在资料确认页，不导航、不循环。
- 昵称为空或超过 20 字符：显示明确提示；服务端仍执行最终白名单和字段校验。
- 中途返回：显式 transaction 执行客户端 logout，不能进入半完成的 authenticated UI。
- App 前后台：transaction 与 target 可恢复，不自动跳过资料确认。
- 网络失败：保留页面与可重试状态；确定性 user ID 防止创建重复用户。
- 头像上传后资料保存失败：本页重试复用已上传 fileID，不重复上传。
- logout 晚响应：operation generation 不匹配时丢弃，不能复活旧 session。

## 自动验证

新增 `npm run phase-24-login-transaction:verify`，35 项覆盖：

- 新用户 identity → profile → school → target；
- 已有 session 正常恢复不重复确认；
- 显式 logout、App.onShow 保持 anonymous；
- 老用户重登必须进入 profile confirmation；
- 原 schoolId/schoolVersion 保持且不调用改校；
- profile 晚响应不能复活 logout session；
- transaction 重启恢复、target 参数和 URL 安全。

同步更新 Phase 24 auth flow、综合校验和 DevTools 脚本。当前通过结果：

| 验证 | 断言 |
| --- | ---: |
| 登录 transaction 专项 | 35 |
| Phase 24 auth flow | 71 |
| Phase 24 Round 1/UX | 87 |
| 显式退出 | 28 |
| 综合 verify | 81 |
| 选校 | 128 |
| 商品学校绑定 | 51 |
| Phase 18 strict | 91 |
| Phase 18 换校 | 79 |
| Phase 18 auth market | 16 |
| Phase 19 | 49 |
| Phase 20 | 78 |
| Phase 21 | 64 |
| Phase 22 | 42 |
| Phase 23 | 133 |
| **合计** | **1033** |

`phase-24-staging:verify` 要求 active client 为 staging；当前客户端为 production，因此在预检处安全失败，未执行其 39 项 staging 检查。没有为了凑验证数修改私有环境配置。

## DevTools 验证

微信开发者工具无写入模式通过：

- 显式入口为 `pages/home/index`；
- 登录页包含新的 profile transaction 状态并保留 `target=publish`；
- anonymous 状态访问发布/消息仍进入登录守卫；
- `authUser/current`、同校市场和同校公开资料只读探针通过；
- authUser 未知 action 与缺 requestId 的 createProduct 被正确拒绝，未写数据；
- 市场抽样 2 件商品均属于当前权威学校；公开资料只含安全白名单；
- writesRequested=false、fixturesCreated=false；
- console error/exception 为 0/0。

真实 `identity → updateProfile` 会更新用户资料，因此本轮没有在当前 production 客户端上执行。DevTools 的可选 `existing-account-relogin` 模式已强制要求 `environmentName=staging`，防止误写生产。

## 部署与数据影响

- 云函数修改：无。
- 需要部署：无。
- production 数据变化：无。
- staging 数据变化：无。
- ACL / 索引 / 环境变量 / 学校状态变化：无。
- users / products / favorites / conversations / messages / appointments 删除：无。
- commit / push / tag：无。

## 已完成人工验收清单（留档）

以下项目已由项目负责人确认通过，步骤保留用于后续回归。

### 1. staging 第一次登录

1. 使用 staging 中不存在的真实微信身份，从发布入口触发登录。
2. 确认先出现“微信登录”，身份成功后自动进入“完善微信资料”。
3. 使用微信头像选择、确认昵称并继续。
4. 确认进入学校选择，选有效学校后返回发布页，而不是首页。

PASS：没有旧 `getUserProfile/getUserInfo` 弹窗、没有页面不存在或重复 login；头像昵称正确显示；`schoolReady=true`；只产生一个 user。

### 2. staging 退出后重新登录

1. 我的 → 退出登录。
2. 确认首页/消息/发布均处于 anonymous 引导。
3. 再点击微信登录。
4. 确认必须再次出现头像昵称确认，而不是直接进入首页。
5. 确认资料后，原有效学校自动恢复且不要求重选，最后返回原 target。

PASS：user ID、schoolId、schoolVersion 不变；没有调用换校、没有冷却、users 不重复。

### 3. logout 后杀掉小程序

1. logout 后完全关闭小程序。
2. 重新进入。
3. 确认仍 anonymous，App.onShow/bootstrap 不自动恢复登录 UI。
4. 只有再次点击微信登录才启动新的 profile confirmation。

### 4. 取消、后台与网络

1. 在资料页取消头像选择，确认仍停留且可继续操作。
2. 清空昵称提交，确认提示明确且不 crash。
3. 在资料确认页切后台再回来，确认不闪匿名、不重复导航、不丢 target。
4. 在 updateProfile 网络失败后重试，确认不创建第二个 user、不重复上传头像。

### 5. 历史关系与学校安全

重登完成后确认原商品、收藏、聊天、预约均存在；用户 ID、schoolId、schoolVersion 不变；历史商品 schoolId 不变；跨校隔离、同校市场和 7×24 小时换校冷却保持原语义。

以上清单已由项目负责人确认通过。本结论只关闭登录事务专项，不代表聊天去商品化已经部署，也不代表 Phase 24 complete。
