# 即出——校园闲置物品线下面交平台

“即出”是一个面向校园内部的闲置物品信息与线下面交微信小程序。用户可以浏览闲置、查看详情，并在后续阶段通过私信约定校园面交地点。项目不提供在线支付、担保交易、快递物流或购物车。

## 当前阶段

第一阶段已完成：

- 微信原生小程序基础工程与统一公共样式
- 首页 Mock 商品列表、分类筛选、关键词搜索、下拉刷新和分页结构
- 商品详情最小展示与统一 `id` 路由
- 发布、消息、个人中心和后续业务页面骨架
- 首页、消息、我的自定义 TabBar，以及独立的中间发布按钮
- Product、Auth、Navigation Service 边界
- 8 条多分类统一 Product Mock 数据
- Loading、空状态和错误状态公共组件
- Node.js 静态完整性验证脚本

## 技术栈

- 微信原生小程序
- JavaScript
- WXML / WXSS
- Node.js 内置模块（仅用于本地验证）
- 无第三方 UI 库
- 无 npm 运行时依赖

本阶段不初始化云开发，也不调用云函数、云数据库、云存储或 `wx.login()`。

## 目录结构

```text
.
├── app.js / app.json / app.wxss
├── components/           公共展示组件
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
5. 点击“编译”，首页应显示“闲置面交”和 Mock 商品列表。

## Mock 数据与架构

页面不直接读取 `mock/products.js`。数据访问统一经过：

```text
Page → ProductService → Mock Data
```

后续接入云数据库时，可在 Service 层兼容云记录 `_id`，页面与组件仍只使用统一 `id`。

## 本阶段未实现

- 真实微信登录与用户体系
- 商品发布、图片上传和云数据库写入
- 收藏持久化与商品管理
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

验证覆盖 JSON、页面和组件四件套、组件路径、相对 `require`、本地资源、JavaScript 语法、WXML 标签、UTF-8 BOM、禁用 API/依赖、Product 模型以及首页核心 Service 链路。

## 后续阶段

1. 第二阶段：首页与商品详情完善
2. 第三阶段：微信登录与用户体系
3. 第四阶段：发布商品、图片上传与云数据库
4. 第五阶段：收藏、个人中心与商品管理
5. 第六阶段：消息、聊天与面交预约
6. 第七阶段：权限、索引、异常处理与最终验收

## Git 仓库

<https://github.com/yyyyyyqqqqq/jichu-miniprogram-02>

默认分支：`main`
