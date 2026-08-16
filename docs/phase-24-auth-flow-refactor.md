# Phase 24 第二轮：微信身份、学校与个人资料解耦

## 当前结论

Phase 24 第二轮方案 B 已完成本地实现、4 个 production 云函数定向部署、自动验证、微信开发者工具验证、独立 staging 建设及真实新用户人工扫码闭环。项目负责人已于 2026-08-13 明确确认人工验收通过，**Phase 24 第二轮完成**。

这不是 Phase 24 全阶段完成：第三轮全局 UI/兼容性和第四轮多设备全业务真机矩阵均未开始；`phase-24-round-1-complete` 继续作为稳定回滚点。

> 2026-08-13 后续状态：Round 3 开始前又完成了一次登录 UX / 状态机前置修正。方案 B 的三个业务状态继续解耦，但客户端不再在显式 `loginIdentity` 后直接跳过资料步骤；每次新的显式登录都必须经过头像昵称确认，再检查学校并返回原 target。代码、1033 项适用自动回归及无写入 DevTools 验证已完成，staging/真机人工验收待项目负责人执行。完整增量记录见 `docs/phase-24-login-profile-confirmation.md`。下文关于“单按钮登录后直接进入业务”的内容仅记录 Round 2 当时验收基线，不代表当前客户端行为。

## 为什么只改客户端不可行

旧流程不只是登录页要求头像和昵称。服务端的 `createProduct`、`productQuery`、`userQuery` 以及 `authUser/updateSchool` 都把 `profileCompleted` 当作业务权限门禁。即使客户端删除资料表单，资料未完善的新身份仍会在发布、市场、卖家主页和换校处被服务端拒绝。

因此必须同时调整服务端权限定义与客户端状态机；客户端不得绕过或伪造服务端身份、学校和资料状态。

## 原门禁矩阵

| 能力 | 旧条件 | 问题 |
| --- | --- | --- |
| 登录完成 | 微信身份 + 昵称/头像资料 | 身份建立与展示资料耦合 |
| 选择/修改学校 | 已认证 + `profileCompleted` | 资料未完善身份无法完成学校闭环 |
| 当前学校市场 | active + 有效学校 + `profileCompleted` | 展示资料错误地决定校园业务权限 |
| 发布商品 | active + 有效学校 + `profileCompleted` | 空昵称/头像导致合法发布失败 |
| 同校公开卖家主页 | 查看者有效学校 + `profileCompleted` | 资料未完善查看者不能访问公开资料 |

## 新权限定义

```text
authenticated = 可信微信身份已经建立
schoolReady   = authenticated + active 用户 + active/valid 权威学校
profileCompleted = 仅表示头像/昵称等个人展示资料是否完善
```

核心校园业务现在只依赖 `authenticated + active user + schoolReady`。`profileCompleted` 不再决定市场、合法详情、公开卖家主页、发布或换校权限。

## 4 个云函数修改

### authUser

- 新增 `loginIdentity`，身份仅来自 `cloud.getWXContext()`。
- 客户端提交的 OPENID、userId、schoolId、profileCompleted、nickname、avatar 均不能成为身份依据。
- 首次建立身份时创建确定性用户 ID，`nickname=""`、`avatarUrl=""`、`profileCompleted=false`、`status=active`、学校为空且 `schoolRequired=true`。
- 老用户只刷新 `lastLoginAt`，原昵称、头像、资料状态、学校、`schoolVersion` 和历史关系全部保留。
- `updateProfile` 继续作为独立资料能力；`selectSchool` 沿用原安全逻辑。
- `updateSchool` 只移除 `profileCompleted` 门禁，7×24 小时冷却、事务、active/valid 学校校验、`schoolVersion` 递增和旧请求失效机制不变。

### createProduct

- 只移除 `profileCompleted`、昵称和头像的发布门禁。
- 仍要求可信微信身份、active 用户、有效权威学校、原商品/地点/媒体校验、确定性幂等、卖家所有权和学校固定绑定。
- 昵称或头像为空时可以发布；保存空展示字段，客户端统一展示 fallback，不改变商品 `schoolId` 语义。

### productQuery

- 移除 `profileCompleted` 对当前学校市场和合法详情访问的阻塞。
- `accessRequiresAuth`、strict school、school scope、跨校只读详情、关系/参与者边界、`schoolVersion` 失效、稳定游标、HMAC 与 fail-closed 全部保留。
- 没有扩大跨校新增收藏、会话或预约权限。

### userQuery

- 移除查看者必须 `profileCompleted` 的条件。
- 查看者仍必须是可信 active 身份并拥有当前 active/valid 学校；公开商品仍按 Phase 21 的查看者学校过滤。
- 返回字段仍为安全公开白名单，不返回 OPENID 或内部字段。
- 被查看用户昵称为空时返回“校园用户”，头像为空时返回空安全值供客户端默认头像处理。

## 新用户语义

真正的新用户第一次点击“微信登录”时，只建立可信微信身份，不要求头像或昵称，也不自动选择学校。若无有效学校，统一进入 `school-select`；选校完成后 `schoolReady=true`，即使 `profileCompleted=false` 也可进入当前学校市场、查看同校公开卖家主页和发布商品。

本轮没有为了验证而创建真实 production 测试用户。除 mock 微信上下文和本地专项测试外，项目负责人已使用一个在 production 存在、但从未进入 staging 的真实微信身份完成首次创建闭环；真实数据完全留在独立 staging。

## 老用户兼容

线上已有账号完成了退出、模拟重启和重新登录自动验证：用户 ID、昵称、头像、`profileCompleted`、学校 ID/名称和 `schoolVersion` 全部不变；重新登录只产生既有账号正常的 `lastLoginAt` 更新，不新建用户，不修改商品或历史关系。

## 客户端状态机与页面（Round 2 历史基线）

- `AuthStore.isLoggedIn()` 只表示可信身份。
- `isSchoolReady()` 只组合 authenticated、active 用户和有效学校。
- `AuthGuard` 不再因 `profileCompleted=false` 返回登录页。
- `school-select` 接受已认证但资料未完善的用户。
- 首页和“我的”页不再把资料未完善视为未登录。
- Round 2 当时登录页删除昵称、头像和“确认并登录”，只保留“微信登录”。该行为已被后续前置修正替代：当前先点击“微信登录”建立身份，再进入极简头像昵称确认步骤。
- 当前显式登录成功后必须先确认资料；确认后有有效学校返回原 target，无学校进入选校，完成后返回 target。
- 新增“我的 → 编辑资料”页，独立维护头像和昵称，不拥有学校字段。

## 默认资料 fallback

新增 `utils/user-presentation.js` 作为最小统一展示 helper：

- 空昵称统一显示“校园用户”；
- 空头像统一使用现有默认头像展示，文字占位为“校”；
- 历史“微信用户 / 即出用户 / 匿名用户”等占位统一归一；
- 已认证用户不使用“匿名”文案。

已同步接入我的页、商品卖家摘要、公开用户主页、聊天/会话、聊天商品选择、预约和商品服务转换层。

## 自动验证（Round 2 历史基线）

- 新增 Phase 24 auth flow 专项 63 项，覆盖新身份、老用户保留、选校、换校冷却、发布/市场/userQuery 权限、logout 和静态安全边界。
- Phase 24 第一轮 87、显式退出 28、综合 81、选校 128、商品学校绑定 51、Phase 18 strict 91、换校 79、认证市场 16、Phase 19 49、Phase 20 78、Phase 21 64、Phase 22 42、Phase 23 133。
- Round 2 核心及既有回归合计 990 项通过；加入 staging 专项 39 项后，正式收尾总计 1029 项断言通过；`git diff --check` 通过。
- Round 2 核心 preview 为 488550 Byte / 477.1 KB；最终 staging 收尾 preview 为 490323 Byte / 478.8 KB，入口 `pages/home/index`，均无 80051。

## DevTools 与生产探针（Round 2 历史基线）

微信开发者工具自动验证通过：

- 登录页不包含任何资料输入状态，`target=publish` 保留；
- 已认证用户可进入独立资料编辑页；
- 地点、图片、视频选择/取消及前后台恢复共 7 类模拟、28 次认证 UI 更新，无登录占位闪现；
- `authUser/current`、`productQuery/list`、`userQuery/publicProfile` 只读探针通过；
- `authUser` 未知 action 和缺少 requestId 的 `createProduct` 负向非写入探针正确拒绝；
- 当前市场 2 个抽样商品均属于当前学校；公开资料只返回白名单字段；
- 现有账号显式退出后缓存、学校 scope 和商品清空，模拟重启不自动恢复；
- 单按钮重新登录返回首页，原资料、学校和 `schoolVersion` 保留，资料编辑页正常；
- 没有新建生产用户、商品或 fixture，console error/exception 为 0/0。

## 云端部署结果

仅定向部署：

1. `authUser`
2. `createProduct`
3. `productQuery`
4. `userQuery`

首次部署连接在发布完成后的核验下载阶段发生一次 `ECONNRESET`；随后的只读 hash 核对确认四项均已发布，脚本因此跳过重复发布，只执行远端包重试下载与完整验证。

最终四项均为 Active/Available、`index.main`、10 秒、256 MB；`authUser/createProduct/productQuery` 为 Nodejs16.13，`userQuery` 为 Nodejs18.15。本地/远端源码、package 和 lock hash 一致，环境变量指纹保持部署前值。四项实际安装 `wx-server-sdk 4.0.2`；`createProduct/productQuery/userQuery` 为 `ws 8.21.3`，`authUser` 保持 Phase 23 基线的无直接 `ws` 依赖。

没有部署其他函数，没有修改 ACL、索引、学校状态、学校数据、商品数据或历史关系。

## 真实新用户人工验收结果（Round 2 历史基线）

项目负责人于 2026-08-13 在独立 staging 完成并确认以下闭环：

1. 新身份扫码进入真实首页，登录页只有“微信登录”，不要求头像或昵称，也没有旧“确认并登录”资料表单。
2. `loginIdentity` 首次创建唯一用户，人工过程确认初始 `nickname=""`、`avatarUrl=""`、`profileCompleted=false`、`status=active`、`schoolRequired=true`，没有自动学校。
3. 自动进入 `school-select`，选择上海工程技术大学后 `schoolReady=true`，而 `profileCompleted` 仍为 false，并正常返回业务页面。
4. 初始 `products=0` 时首页显示空市场；这是最小 staging 的 **Expected / By Design**，不是 Bug。
5. 在 `profileCompleted=false` 下可以进入同校市场、打开公开卖家主页并发布 `Phase24 Staging Test`；商品由服务端绑定当前权威学校。
6. 空昵称显示“校园用户”，空头像显示统一默认头像，没有 null/undefined 或异常空 UI；公开字段白名单与同校规则保持。
7. “我的 → 编辑资料”补充昵称头像成功，`schoolId` 与 `schoolVersion` 没有因资料编辑改变。
8. 显式退出并重新登录后读取同一 staging 用户，不再首次创建、不再选校；学校和编辑后的资料保留，users 仍只有一条。
9. 第一轮地图、图片、视频选择器和前后台恢复修复没有回归，不闪登录 UI。

最终只读回读为 `users=1 / schools=2 / products=1`；用户 active、学校正确、`schoolVersion=1`、资料编辑结果和二次登录时间证据存在；测试商品状态 available、媒体存在、卖家身份与用户一致、商品学校与权威学校一致。

## Staging Expected Limitation

Round 2 staging 是最小登录验收环境，只部署 `authUser / schoolQuery / productQuery / createProduct / userQuery`。它没有部署 `messageQuery / messageAction / appointmentQuery / appointmentAction / favoriteProduct / productViewAction / manageProduct`。

因此点击消息 Tab 时出现“消息暂时无法加载 / 消息服务未正确部署”是 **Expected Limitation**，不是 production Bug，也不是 Round 2 登录重构失败。production 消息能力未受影响；Round 2 不补部署消息函数。若 Phase 24 第四轮要在 staging 跑全业务矩阵，再单独评估扩展资源。

## Production 零变化与 staging 保留

最终只读审计确认 production 的 users/products/schools 及其余集合计数保持本轮基线，12 个函数均 Active/Available，ACL、索引、存储和环境变量指纹未变化；production 中没有 staging 测试商品或用户。本轮没有部署、调用写函数或修改 production 配置。

staging 暂不清理。环境、两条学校、五个函数、四个业务索引、ACL、存储规则、独立 secret 以及当前真实验收用户/商品/media 均保留；任何测试数据清理必须另行授权。

## 后续边界

- Phase 24 第二轮完成，但整个 Phase 24 尚未完成。
- Round 3 全局 UI、小屏、safe-area、长文本、键盘兼容、旧 campus/认证文案和 UX 一致性尚未开始。
- Round 4 iOS/Android/多设备/体验版全业务真机矩阵尚未开始。
- Phase 25 RC 与正式上线准备尚未开始。
- 当前工作区继续不 commit、不 push、不创建或移动 tag；`phase-24-round-1-complete` 仍是唯一稳定回滚点。
