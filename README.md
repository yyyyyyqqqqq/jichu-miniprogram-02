# 即出——校园闲置物品线下面交平台

“即出”是一个面向校园内部的闲置物品信息与线下面交微信小程序。用户可以浏览闲置、查看详情，并通过商品私信沟通校园面交。项目不提供在线支付、担保交易、快递物流或购物车。

## 当前阶段

第九阶段“消息中心与私信聊天核心闭环”及其“真实微信用户登录与双账号测试准备”补充任务已完成源码、自动验证、云端部署、双账号联合验收和正式收尾，并由 `phase-9-complete` 标记。唯一延期项是缺少第三个真实账号导致的非参与者越权真机测试；服务端参与者校验和自动验证已覆盖，风险较低，不阻塞阶段完成。第八阶段标签未被改写：

- 微信原生小程序基础工程与统一公共样式
- 首页组合搜索、分类筛选、综合/最新/价格排序、下拉刷新和稳定分页
- 首页首次加载、查询中、空状态、整页错误和加载更多错误分离
- 商品详情完整展示、参数校验、不可公开商品过滤和独立重试
- `available`、`reserved` 公开列表与 `sold` 商品详情状态展示
- 商品详情卖家入口、校园面交安全提示和原生页面分享
- 发布、个人中心和后续业务页面骨架
- 首页、消息、我的自定义 TabBar，以及独立的中间发布按钮
- Product、Auth、Navigation Service 边界
- 18 条多分类统一 Product Mock 数据继续作为开发 fixture 保留
- 草稿、下架和删除商品公开查询隔离
- 原生价格、发布时间和数量格式化工具
- Loading、空状态和错误状态公共组件
- 增强的 Node.js 完整性和业务边界验证脚本
- 微信云开发真实环境初始化
- `authUser` 云函数与幂等用户记录设计
- 真实微信身份与用户主动资料分层、头像选择上传、昵称填写和资料更新
- 确定性用户 ID 防止重复与并发首次登录产生多条用户记录
- 非阻塞登录状态恢复、主动登录和客户端退出
- 个人中心登录状态、错误重试和安全本地摘要
- 发布、消息、收藏、联系卖家等统一登录守卫
- 固定目标白名单和登录后安全返回
- `productQuery` 商品列表与详情查询云函数
- 首页与详情页通过 ProductService 读取 `products` 云数据库
- 云端搜索、分类、四种排序和真实 `skip + limit` 分页
- 客户端商品数据标准化、超时和统一错误映射
- 第四、第五阶段人工验收通过的云数据库商品读取与发布数据
- 登录用户商品发布表单、客户端与服务端双重校验
- 最多 6 张商品图片选择、预览、删除与云存储上传
- `createProduct` 云函数可信身份校验、幂等写入与稳定错误结构
- 上传失败、保存失败、超时重试与孤儿图片清理
- 发布成功跳转商品详情，以及首页列表刷新标记
- 生产商品查询云函数移除测试数据写入口
- 商品公开字段过滤、查询页码限幅和严格云文件路径校验
- 图片解码、类型、大小与用户目录清理范围校验
- 登录回跳失败恢复、日志脱敏检查和发布前安全清单
- “我的发布”按在售、已下架、已售出查询当前登录用户商品
- `manageProduct` 云函数服务端所有权校验和幂等状态迁移
- 商品下架、重新上架、标记已售及列表刷新
- 所有者专用商品编辑页、字段白名单与 version 并发保护
- 商品软删除、服务端图片差异清理和失败重试状态
- 商品详情真实收藏/取消收藏、收藏状态与数量同步
- 独立收藏关系、事务计数、重复请求幂等和本人商品收藏拒绝
- “我的收藏”真实分页、刷新、状态提示和取消收藏
- 安全公开用户 ID、公开资料白名单和卖家主页
- 用户公开在售商品分页，以及详情页到卖家主页的安全跳转
- 商品详情通过可信 `productId` 创建或复用一对一商品会话
- 真实消息中心、会话游标分页、未读角标、下拉刷新和错误恢复
- 一对一文本聊天、历史消息游标分页、8 秒轻量轮询和发送失败重试
- 确定性会话 ID、确定性消息 ID、事务摘要与未读计数更新
- 会话参与者读写校验、服务端发送者身份和严格安全响应映射

当前结论不代表已经通过微信官方审核或正式发布上线；第三个真实账号的非参与者越权真机补测，以及兼容性、体验版和正式发布材料仍需在后续验收或发布流程中继续核对。

## 技术栈

- 微信原生小程序
- JavaScript
- WXML / WXSS
- Node.js 内置模块（仅用于本地验证）
- 微信云开发与 `wx-server-sdk`
- 无第三方 UI 库
- 小程序客户端无 npm 运行时依赖

小程序客户端使用 `wx.cloud.callFunction()` 调用认证、商品查询、发布、状态管理、收藏、公开主页和消息云函数，不直接访问 `users`、`products`、`favorites`、`conversations` 或 `messages` 集合。

## 目录结构

```text
.
├── app.js / app.json / app.wxss
├── components/           公共展示组件
├── cloudfunctions/       微信云函数
│   └── authUser/         登录与当前用户查询
│   └── productQuery/     公开商品与本人发布查询
│   └── createProduct/    登录用户商品校验与幂等写入
│   └── manageProduct/    本人商品状态、编辑、软删除与图片清理
│   └── favoriteProduct/  收藏关系、事务计数与本人收藏列表
│   └── userQuery/        用户公开资料与公开在售商品
│   └── messageQuery/     会话、会话头部与消息历史安全查询
│   └── messageAction/    会话创建、文本发送与标记已读
├── config/               云环境统一配置
├── constants/            分类、商品状态和路由常量
├── custom-tab-bar/       自定义底部导航
├── mock/                 统一 Mock 商品数据
├── pages/                页面与后续业务骨架
├── scripts/              项目完整性验证脚本
├── services/             商品、认证和导航服务
├── store/                轻量应用与认证状态
└── utils/                异步与格式化工具
```

## 使用微信开发者工具导入

1. 打开微信开发者工具，选择“导入项目”。
2. 项目目录选择 `D:\codex\jichu mini program02`。
3. 工具会读取 `project.config.json` 中现有 AppID：`wx5e54edaf5c80418c`。
4. 确认当前账号有该 AppID 权限；如无权限，请在开发者工具导入界面选择本人有权限的 AppID，不要把私有配置提交到仓库。
5. 按下方说明准备 `products` 集合并部署 `productQuery` 与 `createProduct`。
6. 点击“编译”，首页应显示来自云数据库的商品列表。

## 云开发配置

当前项目使用云环境：

```text
cloud1-d9gpdpv6p2db56d8e
```

认证云函数（`login`、`current`、`updateProfile`）：

```text
cloudfunctions/authUser
```

商品查询云函数：

```text
cloudfunctions/productQuery
```

商品发布云函数：

```text
cloudfunctions/createProduct
```

云函数通过 `cloud.getWXContext()` 获取真实微信身份，客户端不会传递或接收身份标识。云端使用 AppID 与身份标识的 SHA-256 摘要生成确定性用户文档 ID，避免并发首次登录生成重复用户。昵称和头像不从微信静默获取：用户在登录页主动选择头像、填写昵称，可选填写校园信息；头像经类型、解码和 5MB 大小校验后上传到当前用户专属云存储目录。

首次登录前，请在云开发控制台创建 `users` 集合。建议关闭客户端直接读写，仅允许云函数访问。

部署云函数：

```powershell
& "D:\program\微信web开发者工具\cli.bat" cloud functions deploy `
  --env "cloud1-d9gpdpv6p2db56d8e" `
  --paths "D:\codex\jichu mini program02\cloudfunctions\authUser" `
  --remote-npm-install `
  --project "D:\codex\jichu mini program02"
```

部署商品查询云函数：

```powershell
& "D:\program\微信web开发者工具\cli.bat" cloud functions deploy `
  --env "cloud1-d9gpdpv6p2db56d8e" `
  --paths "D:\codex\jichu mini program02\cloudfunctions\productQuery" `
  --remote-npm-install `
  --project "D:\codex\jichu mini program02"
```

部署商品发布云函数：

```powershell
& "D:\program\微信web开发者工具\cli.bat" cloud functions deploy `
  --env "cloud1-d9gpdpv6p2db56d8e" `
  --paths "D:\codex\jichu mini program02\cloudfunctions\createProduct" `
  --remote-npm-install `
  --project "D:\codex\jichu mini program02"
```

集合创建、权限、索引、测试数据初始化与验证步骤见：

```text
docs/phase-4-cloud-products.md
```

商品发布部署、云存储检查与人工验收步骤见：

```text
docs/phase-5-cloud-product-publish.md
```

第六阶段安全、权限、索引、回归和发布准备步骤见：

```text
docs/phase-6-security-release-readiness.md
```

## 商品数据与架构

正式数据访问统一经过：

```text
Page → ProductService → productQuery → products
```

页面与组件使用标准化后的 `id`，Service 负责兼容数据库 `_id`、空字段、数字、数组、日期、状态与卖家信息。

公开商品查询默认只返回：

```text
available / reserved / sold
```

旧数据中的 `published` 会在客户端标准化为 `available`。`draft`、`offline` 和 `deleted` 不会出现在首页，也不能通过公开详情接口读取。

`mock/products.js` 仍作为本地开发 fixture 保留，但正式运行不会静默回退到 Mock。

商品发布统一经过：

```text
Publish Page
→ ProductPublishService 上传云存储图片
→ createProduct 取得可信微信身份并查询 users
→ products 幂等写入
→ ProductService / productQuery 读取新商品
```

客户端仅提交经过校验的商品字段和云文件 `fileID`。卖家、状态、计数及服务端时间均由云函数构造，发布请求 ID 与用户 ID 共同生成确定性商品文档 ID，避免超时重试产生重复商品。

## 认证架构

```text
App 非阻塞启动
→ AuthStore 后台 bootstrap
→ AuthService 调用 authUser/current
→ 云端校准真实登录状态
```

主动登录：

```text
受限入口或登录页
→ AuthGuard 白名单目标
→ 用户主动选择头像、填写昵称
→ AuthStore.login → authUser/login 创建或复用真实用户
→ AvatarService 上传当前用户专属头像
→ AuthStore.updateProfile → authUser/updateProfile
→ 返回安全用户模型并标记资料完成
→ 返回原目标页面
```

本地只缓存：

```text
id / nickname / avatarUrl / campus / profileCompleted
```

本地缓存仅用于恢复期间的展示优化，不作为可信权限依据。

第七阶段 A 的架构、索引、状态迁移和人工验收步骤见：

```text
docs/phase-7a-my-products-lifecycle.md
```

第七阶段 B 的编辑、并发、软删除和图片生命周期说明见：

```text
docs/phase-7b-product-edit-soft-delete.md
```

第八阶段收藏、事务计数、公开用户 ID 和卖家主页说明见：

```text
docs/phase-8-favorites-public-profile.md
```

第九阶段会话模型、消息幂等、未读计数、索引和验收边界见：

```text
docs/phase-9-messaging-chat.md
```

真实微信登录与双账号人工验收步骤见：

```text
docs/phase-9-real-login-test-prep.md
```

## 本阶段未实现

- 已删除商品恢复、图片排序
- 面交预约、预约接受/拒绝/取消
- 图片、文件、语音、视频消息与消息撤回
- WebSocket、数据库 watch、订阅通知和消息 Tab 总未读角标
- 地图选点
- 任何在线支付、担保支付或物流能力

预约相关入口仍未实现；聊天当前只支持绑定具体商品的一对一文本消息。

## 本地验证

```powershell
node scripts/verify-project.js
```

或：

```powershell
npm run verify
```

验证覆盖 JSON、页面和组件四件套、真实身份唯一性与并发登录、统一云初始化、资料校验、头像上传安全、身份与返回边界、登录守卫、商品查询、本人商品隔离、字段白名单、version 并发、状态迁移、软删除、图片差异与回滚、收藏事务与幂等、收藏计数、公开资料白名单、会话权限、消息幂等、未读计数、稳定游标、发布参数、Loading 清理与日志脱敏。当前结果为 `51 checks passed`。

## 后续阶段

第九阶段已经完成。后续可在具备第三个真实微信账号时补测非参与者越权，并继续兼容性、体验版和正式发布准备。下一独立业务阶段建议实现面交预约。

## Git 仓库

<https://github.com/yyyyyyqqqqq/jichu-miniprogram-02>

默认分支：`main`
