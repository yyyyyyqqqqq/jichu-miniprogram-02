# 即出

面向校园内部的闲置物品信息与线下面交微信小程序。
用户在同校市场发现商品，通过私信沟通并预约面交；项目不提供在线支付、担保交易、快递物流或购物车。

## 当前状态

- **Final Release Complete**：核心业务及生产收尾已完成。
- **Post-Final-Release security audit complete**：公开仓库 SAFE，安全 READY；可维护性 C，建议发布后渐进重构。
- **Disabled-account revocation hotfix complete**：受保护请求统一校验服务端权威账号状态。
- Phase 25 消息生命周期、全国高校、收藏性能优化和 Feedback 均已完成生产验收。
- 微信官方审核与正式发布尚未执行，是否进入审核由项目负责人决定。

上述状态不表示零技术债或保证微信审核通过。当前审计、接受的风险和后续优先级见 [最终安全与可维护性报告](docs/post-release-security-maintainability-audit.md)。

## 核心功能

- **登录与资料**：真实微信身份、主动确认头像和昵称、独立选校、登录回跳与退出。
- **全国高校**：2,952 所 active 普通高校，支持列表、搜索与稳定分页。
- **同校市场**：按权威学校隔离首页、搜索和分类，支持综合、最新、价格排序及分页。
- **商品发布与管理**：多图发布、地图选点、编辑、上下架、售出、软删除与图片清理。
- **收藏与卖家主页**：收藏/取消、本人收藏列表、公开资料与当前校园在售商品；收藏数据补全已采用有界并行优化。
- **聊天**：同一用户对唯一会话，支持文本、语音、图片、位置快照、商品卡片和预约系统消息。
- **消息生命周期**：会话隐藏、仅自己删除、消息撤回与转发，保留重试、幂等和并发保护。
- **面交预约**：创建、接受、拒绝、取消、完成及相关商品状态联动。
- **历史跨校关系**：换校后仍可访问本人既有收藏、会话和预约；跨校新增关系仍受服务端限制。
- **Feedback**：登录用户提交纯文本反馈，服务端先落库再通知固定收件方，包含幂等和基础频率限制。

学校真实变更有服务端冷却与版本校验；客户端缓存、时间和请求中的学校字段不能替代权威记录。
公开商品分享按接收者身份重新判定访问范围，商品发布时的学校快照不会随卖家换校自动迁移。

## 安全设计

- **服务端权威身份**：云函数从平台上下文取得调用者身份，不信任客户端伪造的身份字段。
- **Active-user gate**：受保护业务前重新读取用户、校验身份绑定与 active 状态；禁用账号不能靠旧客户端缓存继续获得业务权限。
- **数据库隔离**：9 个业务集合采用 `ADMINONLY`，普通客户端不直接读写数据库。
- **对象授权**：商品检查所有者；聊天、预约检查参与者、角色及状态；知道 object ID 不等于有访问权。
- **学校边界**：新商品与新关系由权威用户/学校记录约束；历史关系按所有者或参与者授权。
- **安全响应**：使用明确的 DTO 字段白名单；公开响应不包含私有身份或精确私密地点，聊天/预约私有内容仅向授权参与者返回，不返回完整用户记录或原始数据库错误。
- **输入与重放保护**：显式字段校验、幂等键、版本/状态机以及受查询范围约束的游标。
- **秘密隔离**：本机及云端私有配置保管凭据，公开 example 仅保留 placeholder。

公开商品详情、匿名学校查询及首次账号 onboarding 是有意保留的例外，不等于开放私人消息或关系写入。
Active gate 保证请求入口的账号校验，不意味着撤销已下载数据或使已知媒体链接立即失效。

聊天媒体仍采用现有 `READONLY` 存储策略：业务 API 先校验参与者，但完整 fileID 泄漏后存在访问风险。
媒体私有授权、统一反滥用和上传内容校验的进一步加固属于已记录的发布后工作。

## Architecture

```text
Mini Program Page / Component
          ↓
Service / Store / Guard
          ↓
Cloud Function
          ↓
Cloud Database / Storage
```

页面负责交互；Service 负责数据标准化、调用和错误映射；Store 负责客户端状态。
权限、可信身份、学校、事务和最终业务规则由云函数决定，客户端状态仅辅助展示。
文件通过受控媒体服务上传/预览；数据库业务访问经过云函数。

### 技术栈

- 微信原生小程序：JavaScript、WXML、WXSS、自定义 TabBar。
- 微信云开发：Cloud Functions、Cloud Database、Cloud Storage 与 `wx-server-sdk`。
- `Nodemailer`：仅用于 `feedbackAction` 服务端邮件通知，不进入小程序客户端。
- Node.js 本地验证工具；学校数据解析使用锁定版本 `@e965/xlsx`。
- 无第三方 UI 框架，小程序客户端无 npm 运行时依赖。

### 目录

```text
app.*                  小程序入口与全局样式
pages/                 页面
components/            公共组件
custom-tab-bar/        底部导航
services/              业务与媒体服务
store/                 应用、认证状态
utils/                 公共校验与工具
constants/             路由、分类和状态
cloudfunctions/        13 个独立云函数
config/                公开配置入口与私有配置示例
assets/                图标资源
data/schools/          公开学校数据及本地 fixture
reports/schools/       学校处理与验证报告
mock/                  显式本地开发 fixture
scripts/               本地验证和受控运维工具
docs/                  阶段记录、发布与安全报告
```

正式业务不会在云调用失败时静默回退到 Mock。

## Cloud Functions

| Function | 用途 |
| --- | --- |
| `authUser` | 登录、当前用户、资料、首次选校和换校 |
| `productQuery` | 同校市场、公开商品详情、本人发布 |
| `createProduct` | 可信身份/学校下的幂等商品创建 |
| `manageProduct` | 本人商品状态、编辑、软删除与图片清理 |
| `favoriteProduct` | 收藏关系、计数与本人收藏列表 |
| `userQuery` | 安全公开资料与查看者校园的商品 |
| `productViewAction` | 有效浏览计数与滚动窗口去重 |
| `messageQuery` | 会话、消息历史、送达状态与可分享商品 |
| `messageAction` | 建会话、发送、已读、隐藏、删除、撤回和转发 |
| `appointmentQuery` | 本人预约、详情及会话当前预约 |
| `appointmentAction` | 预约创建、状态转换与商品联动 |
| `schoolQuery` | active 学校列表、搜索和详情 |
| `feedbackAction` | 反馈提交、幂等/基础配额与服务端邮件 |

## Data Collections

所有集合均通过云函数访问；此处仅列模型用途，不提供真实记录。

| Collection | 用途 |
| --- | --- |
| `users` | 权威账号、资料与校园状态 |
| `products` | 商品、生命周期与发布校园快照 |
| `favorites` | 用户与商品的收藏关系 |
| `conversations` | 用户对会话、摘要与可见性 |
| `messages` | 消息内容、类型和生命周期 |
| `appointments` | 面交预约、角色和状态 |
| `schools` | 公开高校资料与运营状态 |
| `productViews` | 去重浏览窗口与计数记录 |
| `feedbacks` | 反馈、幂等及通知处理状态 |

## Privacy / Private Configuration

公开仓库中的占位符不得替换为真实值。按对应 example 创建本机副本：

| 私有文件 | 用途 |
| --- | --- |
| `project.private.config.json` | 真实 AppID 等开发者工具本机配置 |
| `config/cloud.private.js` | 当前环境角色与真实环境 ID |
| `config/cloud.targets.private.js` | 相互独立的 staging / production 目标 |
| `config/cloud.secrets.private.js` | 按环境隔离的 SMTP 凭据及 cursor secret |

私有配置由 Git 忽略，服务端秘密只由受控工具注入目标云环境，不能打包到客户端。
示例文件使用 placeholder 或空值；缺少配置应失败关闭，不应猜测目标或自动连接生产。

不要提交真实身份、用户正文、私有文件链接、数据库导出、原始日志、截图、部署包或私有运维证据。
`.gitignore` 同时排除临时目录、依赖、私有诊断及内部编号交接文件。
历史审计已披露早期非凭据部署标识残留；“无可用秘密泄漏”不等于“历史没有任何标识”。

## Local Development

1. 克隆仓库，用微信开发者工具导入项目根目录。
2. 保留公开 `project.config.json` 中的 placeholder，在本机私有配置中填写真实 AppID。
3. 按 `config/` 中 example 准备环境配置；日常开发使用独立 staging，不复用 production 数据。
4. 在根目录按锁文件准备本地依赖；需要部署的云函数保持各自 package/lock 独立。
5. 配置缺失时先修正本机副本；不要把真实值写回公开文件。
6. 编译小程序，执行本地回归；云端资源准备和部署使用对应受控流程。

```powershell
npm ci
npm run verify
npm run feedback:verify
```

根目录依赖主要用于学校数据工具；上述本地验证不会要求初始化生产测试数据。
`scripts/` 含有迁移、fixture、部署和清理工具，不能把所有脚本批量执行为“测试”。
任何生产写入均需单独授权、明确目标及该流程规定的快照/回滚门禁。

## Verification

- Final Release 的功能、生产安全验收与回滚边界已记录在 [最终收尾](docs/final-release-step-5-final-closure.md)。
- `npm run verify` 包含 81 组综合验证与永久 disabled revocation 矩阵，覆盖 46 个受保护操作。
- `npm run feedback:verify` 覆盖 39 项 Feedback 边界。
- 当前 auth、学校、消息、预约、收藏和 Final Release 本地回归已重新执行。
- 本轮 fresh 核验 production 9 个集合的 `ADMINONLY` 与 13 个函数入口源码；没有生产写入。
- 既有 hotfix production-safe probes 18/18 通过；原始私有证据不随仓库公开。

更多记录：

- [安全、公开仓库与可维护性审计](docs/post-release-security-maintainability-audit.md)
- [禁用账号撤权修复](docs/post-release-disabled-account-revocation-hotfix.md)
- [全国高校上线](docs/final-release-step-3b-production-school-activation.md)
- [收藏性能优化上线](docs/final-release-step-4b-performance-rollout.md)
- [Feedback 功能与验收](docs/final-release-feedback-feature.md)
- [消息生命周期与最小安全回滚边界](docs/phase-25-rollback-projection-compatibility.md)

旧阶段报告描述其当时状态；当前结论以最新审计为准。

## Known Technical Debt

- **Runtime modernization**：4 个函数使用 Node16、9 个使用 Node18；已 EOL，发布后高优先级迁往经平台支持验证的 LTS。
- **SDK 传递依赖**：各云函数仍有既有 5 high / 1 moderate npm audit 告警，已接受为发布后整改项，不代表漏洞已消失。
- **大型模块**：聊天页面、消息/预约事务及综合验证脚本较大，建议按职责渐进拆分。
- **媒体隐私**：已知 fileID 的 capability 风险、短时访问授权和随机对象键需进一步加固。
- **安全 helper 重复**：独立云函数内有小量 gate 重复；先保持统一 contract 回归，再评估受控抽取。
- **反滥用与上传**：统一服务端配额、并发边界及真实媒体 bytes/MIME 校验仍可增强。

可维护性 C 表示推荐重构，不表示上线后无法安全修 bug；不建议在审核前集中改写核心事务和认证结构。

## Post-Release

后续工作需独立规划与验收：

- Nearby School 等经确认的新需求。
- 受支持 runtime、依赖风险治理与持续安全复核。
- 私有媒体访问、反滥用和日志留存加固。
- 聊天/预约、认证状态与测试工具的渐进可维护性重构。
- 有数据支撑的分页、setData、媒体和查询性能优化。

本仓库的 Final Release Complete 不代表已经完成微信官方审核或面向用户正式发布。
当前审计完成后停止工程变更，等待负责人决定下一步。
