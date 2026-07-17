# 即出——校园闲置物品线下面交平台

“即出”是一个面向校园内部的闲置物品信息与线下面交微信小程序。用户可以浏览闲置、查看详情，并在后续阶段通过私信约定校园面交地点。项目不提供在线支付、担保交易、快递物流或购物车。

## 当前阶段

第五阶段商品云端发布链路已完成源码接入：

- 微信原生小程序基础工程与统一公共样式
- 首页组合搜索、分类筛选、综合/最新/价格排序、下拉刷新和稳定分页
- 首页首次加载、查询中、空状态、整页错误和加载更多错误分离
- 商品详情完整展示、参数校验、不可公开商品过滤和独立重试
- `available`、`reserved`、`sold` 商品只读状态展示
- 商品详情卖家入口、校园面交安全提示和原生页面分享
- 发布、消息、个人中心和后续业务页面骨架
- 首页、消息、我的自定义 TabBar，以及独立的中间发布按钮
- Product、Auth、Navigation Service 边界
- 18 条多分类统一 Product Mock 数据继续作为开发 fixture 保留
- 草稿、下架和删除商品公开查询隔离
- 原生价格、发布时间和数量格式化工具
- Loading、空状态和错误状态公共组件
- 增强的 Node.js 完整性和业务边界验证脚本
- 微信云开发真实环境初始化
- `authUser` 云函数与幂等用户记录设计
- 非阻塞登录状态恢复、主动登录和客户端退出
- 个人中心登录状态、错误重试和安全本地摘要
- 发布、消息、收藏、联系卖家等统一登录守卫
- 固定目标白名单和登录后安全返回
- `productQuery` 商品列表与详情查询云函数
- 首页与详情页通过 ProductService 读取 `products` 云数据库
- 云端搜索、分类、四种排序和真实 `skip + limit` 分页
- 客户端商品数据标准化、超时和统一错误映射
- 16 条可控、幂等的云数据库测试商品初始化数据
- 登录用户商品发布表单、客户端与服务端双重校验
- 最多 6 张商品图片选择、预览、删除与云存储上传
- `createProduct` 云函数可信身份校验、幂等写入与稳定错误结构
- 上传失败、保存失败、超时重试与孤儿图片清理
- 发布成功跳转商品详情，以及首页列表刷新标记

## 技术栈

- 微信原生小程序
- JavaScript
- WXML / WXSS
- Node.js 内置模块（仅用于本地验证）
- 微信云开发与 `wx-server-sdk`
- 无第三方 UI 库
- 小程序客户端无 npm 运行时依赖

小程序客户端使用 `wx.cloud.callFunction()` 调用认证、商品查询和商品发布云函数，不直接访问 `users` 或 `products` 集合。

## 目录结构

```text
.
├── app.js / app.json / app.wxss
├── components/           公共展示组件
├── cloudfunctions/       微信云函数
│   └── authUser/         登录与当前用户查询
│   └── productQuery/     商品列表、详情与受控测试数据初始化
│   └── createProduct/    登录用户商品校验与幂等写入
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

认证云函数：

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

云函数通过 `cloud.getWXContext()` 获取真实微信身份，客户端不会传递或接收身份标识。云端使用 AppID 与身份标识的 SHA-256 摘要生成确定性用户文档 ID，避免并发首次登录生成重复用户。

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
→ AuthStore.login
→ authUser/login
→ 返回安全用户模型
→ 返回原目标页面
```

本地只缓存：

```text
id / nickname / avatarUrl / campus / profileCompleted
```

本地缓存仅用于恢复期间的展示优化，不作为可信权限依据。

## 本阶段未实现

- 商品编辑、删除、下架与“我的发布”管理
- 收藏持久化
- 私信聊天与面交预约
- 地图选点
- 任何在线支付、担保支付或物流能力

页面中的相关入口仅提供清晰占位或“后续阶段开放”提示，不代表业务已经可用。

## 本地验证

```powershell
node scripts/verify-project.js
```

或：

```powershell
npm run verify
```

验证覆盖 JSON、页面和组件四件套、云函数结构、身份来源、安全返回、本地缓存、AuthService/AuthStore 接口、非阻塞 bootstrap、白名单登录守卫、商品读取回归，以及发布校验、上传路径、受保护字段、幂等重试和孤儿图片清理。

## 后续阶段

1. 第六阶段：收藏、个人中心与商品管理
2. 第七阶段：消息、聊天与面交预约
3. 第八阶段：权限、索引、异常处理与最终验收

## Git 仓库

<https://github.com/yyyyyyqqqqq/jichu-miniprogram-02>

默认分支：`main`
