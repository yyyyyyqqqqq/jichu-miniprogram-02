# 即出——校园闲置物品线下面交平台

“即出”是一个面向校园内部的闲置物品信息与线下面交微信小程序。用户可以浏览闲置、查看详情，并通过商品私信沟通校园面交。项目不提供在线支付、担保交易、快递物流或购物车。

## 当前阶段

第十二阶段“商品浏览量展示与有效浏览计数”已完成源码、云端部署和多账号真机验收，并使用 `phase-12-complete` 作为阶段标记。第十三阶段“聊天富消息”已完成源码、两项消息云函数部署和最终真机验收，并使用 `phase-13-complete` 作为阶段标记。阶段十三完成后的收尾又为商品发布与编辑补齐地图选点、旧商品兼容和严格服务端地点校验；这属于阶段十三后的完善，不命名为第十四阶段。第十四阶段“多学校校园市场现状审计与架构设计”已完成并以 `phase-14-complete` 标记。第十五阶段现已完成教育部普通高校名单解析、标准化、云端导入、受控真实学校激活和只读查询线上闭环：上海工程技术大学、上海财经大学浙江学院为 `active`，其余 2950 所为 `pending`。第十六阶段的数据和查询前置条件已经满足，但必须等待用户验收和新指令；当前不创建阶段15标签，也未实现用户或商品 `schoolId`。既有阶段标签均未改写：

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
- 列表卡片隐藏浏览量，详情弱化展示“人浏览 · 人收藏”
- 登录买家浏览使用独立云函数、滚动 24 小时事务去重和卖家本人排除
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
- 语音录制与播放、相册与拍摄、位置快照、双方其他商品卡片
- 富消息媒体目录隔离、受控商品查询、服务端商品快照与同键幂等重试
- 确定性会话 ID、确定性消息 ID、事务摘要与未读计数更新
- 会话参与者读写校验、服务端发送者身份和严格安全响应映射
- 商品发布与编辑统一使用用户主动触发的地图选点，并复用共享地点服务
- 新商品强制提交规范化结构化地点，旧商品保留文本地点兼容编辑与展示
- 商品公开查询不返回精确结构化地点，不使用自动、后台或持续定位
- 面交预约按钮、资料保存按钮和发布页地点占位文字的垂直居中收尾
- 教育部 2026 年普通高等学校名单只读解析、规范化、异常校验和可复现产物
- 2952 所普通高校的安全 dry-run、幂等云端导入、唯一标识和运营状态隔离
- `schools` 集合 `ADMINONLY` 权限、唯一与查询索引，以及只返回 active 学校的 `schoolQuery`
- 客户端 `SchoolService` 查询边界；本阶段不写用户或商品学校字段
- 本地受控学校状态运维、确定性确认批次、条件更新、激活审计和回滚 dry-run
- 两所真实测试学校线上 list/search/detail、字段白名单和两页游标闭环

当前结论不代表已经通过微信官方审核或正式发布上线；兼容性、体验版和正式发布材料仍需在后续发布流程中继续核对。

## 技术栈

- 微信原生小程序
- JavaScript
- WXML / WXSS
- Node.js 内置模块（仅用于本地验证）
- 微信云开发与 `wx-server-sdk`
- 本地学校数据解析使用锁定版本 `@e965/xlsx`
- 无第三方 UI 库
- 小程序客户端无 npm 运行时依赖

小程序客户端使用 `wx.cloud.callFunction()` 调用认证、商品查询、浏览记录、发布、状态管理、收藏、公开主页、消息和学校查询云函数，不直接访问 `users`、`products`、`productViews`、`favorites`、`conversations`、`messages` 或 `schools` 集合。

## 目录结构

```text
.
├── app.js / app.json / app.wxss
├── components/           公共展示组件
├── cloudfunctions/       微信云函数
│   └── authUser/         登录与当前用户查询
│   └── productQuery/     公开商品与本人发布查询
│   └── productViewAction/ 有效浏览记录与 24 小时去重
│   └── createProduct/    登录用户商品校验与幂等写入
│   └── manageProduct/    本人商品状态、编辑、软删除与图片清理
│   └── favoriteProduct/  收藏关系、事务计数与本人收藏列表
│   └── userQuery/        用户公开资料与公开在售商品
│   └── messageQuery/     会话、消息历史与双方可分享商品安全查询
│   └── messageAction/    会话创建、文本/富消息发送与标记已读
│   └── schoolQuery/      已激活学校的列表、搜索与详情只读查询
├── config/               云环境统一配置
├── constants/            分类、商品状态和路由常量
├── custom-tab-bar/       自定义底部导航
├── mock/                 统一 Mock 商品数据
├── data/schools/         学校规范化数据、清单和本地测试 fixture
├── reports/schools/      学校源画像、校验、dry-run 与导入报告
├── pages/                页面与后续业务骨架
├── scripts/              项目验证及学校解析、差异和导入脚本
├── services/             商品、认证、学校和导航服务
├── store/                轻量应用与认证状态
└── utils/                异步与格式化工具
```

## 使用微信开发者工具导入

1. 打开微信开发者工具，选择“导入项目”。
2. 项目目录选择本地克隆目录 `<PROJECT_ROOT>`。
3. 保持 `project.config.json` 中的 `YOUR_WECHAT_APP_ID` 不变，在被 Git 忽略的 `project.private.config.json` 顶层填写真实 `appid`。
4. 复制 `config/cloud.private.example.js` 为 `config/cloud.private.js`，只在副本中填写真实云环境 ID。
5. 确认当前账号有该 AppID 和云环境权限；不要提交两个本机私有配置文件。
6. 按下方说明准备 `products` 集合并部署 `productQuery` 与 `createProduct`。
7. 点击“编译”，首页应显示来自云数据库的商品列表。

## 云开发配置

公开文件中的占位符不得替换。开发前创建本机文件 `config/cloud.private.js`：

```js
module.exports = {
  environmentId: '你的真实云环境 ID'
};
```

### 本地配置与隐私

公开仓库只保留可复用占位符和 `config/cloud.private.example.js`。真实值的来源固定为：

- AppID：`project.private.config.json` 顶层 `appid`，覆盖 `project.config.json` 的公开占位符。
- 云环境 ID：`config/cloud.private.js` 的 `environmentId`，由 `config/cloud.js` 加载后交给统一云初始化。

若运行时私有云配置缺失或仍是占位符，应用会返回 `CLOUD_CONFIG_MISSING`，不会静默连接其他环境。真实 AppID、云环境 ID、本机路径和私有配置只应保存在本地。`project.private.config.json`、`config/cloud.private.js`、`.env*`、依赖目录、临时部署产物、数据库导出、诊断日志、私有截图、用户数据目录和编号内部交接文档均由 `.gitignore` 排除。不要提交 AppSecret、SecretId、SecretKey、访问令牌、私钥、完整 OPENID 或生产用户数据。

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

以下 PowerShell 模板不绑定任何生产环境或本机路径：

```powershell
$PROJECT_ROOT = "<PROJECT_ROOT>"
$WECHAT_DEVTOOLS_CLI_PATH = "<WECHAT_DEVTOOLS_CLI_PATH>"
$CLOUDBASE_ENV_ID = "YOUR_CLOUDBASE_ENV_ID"

& $WECHAT_DEVTOOLS_CLI_PATH cloud functions deploy `
  --env $CLOUDBASE_ENV_ID `
  --paths "$PROJECT_ROOT\cloudfunctions\authUser" `
  --remote-npm-install `
  --project $PROJECT_ROOT
```

部署商品查询云函数：

```powershell
& $WECHAT_DEVTOOLS_CLI_PATH cloud functions deploy `
  --env $CLOUDBASE_ENV_ID `
  --paths "$PROJECT_ROOT\cloudfunctions\productQuery" `
  --remote-npm-install `
  --project $PROJECT_ROOT
```

部署商品发布云函数：

```powershell
& $WECHAT_DEVTOOLS_CLI_PATH cloud functions deploy `
  --env $CLOUDBASE_ENV_ID `
  --paths "$PROJECT_ROOT\cloudfunctions\createProduct" `
  --remote-npm-install `
  --project $PROJECT_ROOT
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

商品地点由用户点击后调用微信地图选择器取得，发布页、编辑页和预约地点页复用 `LocationService` 做取消、权限错误、字段清理与坐标范围处理。新发布商品必须包含规范化的 `locationDetail`，`createProduct` 会再次执行严格服务端校验；编辑旧商品时，`manageProduct` 兼容只有文本 `location` 的历史数据，但地点一旦被修改就必须提交新的合法结构化地点。公开商品查询继续只返回适合展示的文本地点，不返回精确坐标或地址。

项目不会在页面加载时自动获取位置，也不执行后台定位、持续定位或位置变化监听。地图只在用户明确点击并确认选点时打开；取消选择不会覆盖已有地点。

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

第十阶段面交预约、状态机、地图选点、云端集合与部署结果见：

```text
docs/phase-10-appointment-meetup.md
```

第十二阶段浏览量展示、滚动 24 小时去重、云端部署和验收说明见：

```text
docs/phase-12-product-view-counting.md
```

第十三阶段语音、图片、位置、商品消息、安全边界和最终验收结论见：

```text
docs/phase-13-rich-chat-messages.md
```

第十四阶段多学校影响审计、数据模型、查询索引、迁移、安全和阶段 15—25 实施设计见：

```text
docs/phase-14-multi-school-audit.md
```

第十五阶段官方高校来源、解析规则、数据校验、受控导入、云端权限索引和只读查询结果见：

```text
docs/phase-15-school-data-and-query.md
```

## 本阶段未实现

- 已删除商品恢复、图片排序
- 文件、视频消息与消息撤回
- WebSocket、数据库 watch、订阅通知和消息 Tab 总未读角标
- 用户选校、商品学校绑定、同校市场隔离、存量迁移及相关 UI（学校基础库、两所测试学校激活和只读服务已经完成）
- 任何在线支付、担保支付或物流能力

聊天当前支持绑定具体商品的一对一文本、语音、图片、位置、双方其他商品卡片及预约状态系统消息。位置是用户确认后发送的单次快照，不是持续实时共享；实时推送仍未实现。

## 本地验证

```powershell
node scripts/verify-project.js
```

或：

```powershell
npm run verify
```

验证覆盖 JSON、页面和组件四件套、真实身份唯一性与并发登录、统一云初始化、资料校验、头像上传安全、身份与返回边界、登录守卫、商品查询、本人商品隔离、浏览量展示、图片预览生命周期、卖家排除、滚动 24 小时去重、并发原子计数、字段白名单、version 并发、状态迁移、软删除、商品与聊天媒体清理、收藏事务与幂等、公开资料白名单、会话权限、文本与富消息幂等、媒体路径隔离、位置范围、商品地图选点与旧数据兼容、双方商品查询和服务端快照、独立商品选择页、预约权限与状态机、系统消息、稳定游标、聊天降级、发布参数、三处 UI 居中、Loading 清理与日志脱敏。学校专项验证另覆盖原文件只读、结构画像、规范化、确定性主键、重复检测、dry-run 幂等、导入门禁、运营字段保护、只返回 active 学校、搜索分页、详情隔离、公开字段和客户端服务边界。当前完整结果为 `73 checks passed`。

## 后续阶段

第十五阶段学校基础库、两所真实测试学校激活和只读查询线上闭环已经完成；当前 active 2、pending 2950，第十六阶段进入条件已满足。用户验收并发出新指令后，阶段 16—25 再依次完成用户选校、商品绑定、同校查询、跨校边界、学校切换、历史关系适配、迁移、安全、UI 和综合验收。本轮没有提前修改用户、商品、AuthStore 或页面。

## Git 仓库

<https://github.com/yyyyyyqqqqq/jichu-miniprogram-02>

默认分支：`main`
