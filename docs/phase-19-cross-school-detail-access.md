# Phase 19：跨校商品详情只读与新增关系闸门

> 状态：代码、自动验证、回归、生产部署、微信开发者工具 preview 与真实双账号跨校买家态人工验收均已完成，**Phase 19 complete**。
>
> Phase 20 尚未开始。Phase 21 尚未开始。

## 1. 基线检查

开发前基线：

| 项目 | 结果 |
| --- | --- |
| branch | `main` |
| HEAD | `bf9fa62 feat: complete phase 18 school scoped marketplace` |
| HEAD tag | `phase-18-complete` |
| origin 同步 | `0 ahead / 0 behind` |
| 工作区 | clean |

Phase 19 从上述稳定基线开发；最终封版提交信息为 `feat: add phase 19 cross-school detail access guards`，annotated tag 为 `phase-19-complete`。

## 2. 原有架构审计

- 商品详情：`pages/product-detail/index.js` → `services/product-service.js` → `productQuery/detail`。详情按合法 `productId` 查询，公开状态为 `available / reserved / sold`；Phase 18 的学校 strict 过滤只作用于 `productQuery/list`。
- 分享：商品详情页原有 `onShareAppMessage`，入口参数为商品 ID；原来没有朋友圈分享处理。
- 收藏创建：详情页 → `FavoriteService.add` → `favoriteProduct/addFavorite` → `favorites` 事务写入。
- conversation 创建：详情页 → `MessageService.createOrGetConversation` → `messageAction/createOrGetConversation`；确定性会话 ID 支持复用。
- reservation 创建：聊天页 → `AppointmentService.create` → `appointmentAction/createAppointment`；既有相同预约可幂等返回。
- 当前学校权威来源：云函数通过真实微信身份定位 `users` 权威记录，读取其 `schoolId`；客户端传入的学校、用户 ID 或 openid 都不参与授权决定。
- Phase 18 strict query：`cloudfunctions/productQuery/index.js` 的 `list` 分支与 school-scoped cursor/seek 查询；本阶段没有放宽、旁路或复用详情逻辑替代列表 strict。

## 3. Phase 19 实现

### 3.1 商品详情

`productQuery/detail` 继续按合法商品 ID 返回合法公开状态，离线、草稿、软删除或不存在商品继续拒绝。响应新增服务端计算的 `access`：

- `sameSchool`：同校，可建立新关系；
- `crossSchoolReadonly`：跨校，只读；
- `owner`：商品所有者，保留管理语义；
- `anonymous / accountNotReady`：允许合法 ID 只读，但不能建立关系。

### 3.2 跨校只读

详情页显示轻量提示“该商品来自其他学校，仅支持查看”，保留商品公开内容和分享；禁用新的收藏、联系卖家和卖家主页跳转。若历史收藏已经存在，仍允许取消收藏。

### 3.3 分享

新增 `onShareTimeline`。好友分享路径与朋友圈 query 都只携带可信 `productId`，不携带或信任学校参数。分享接收方重新调用 `productQuery/detail`，由服务端按接收方当前权威学校计算访问模式。

### 3.4 收藏权限

`favoriteProduct` 在事务内读取权威用户与商品学校。历史收藏优先返回，取消收藏继续允许；只有创建新收藏时才执行同校校验。跨校或学校资料不完整统一返回 `CROSS_SCHOOL_RELATION_FORBIDDEN`，客户端只展示友好文案。

### 3.5 conversation 权限

`messageAction/createOrGetConversation` 先复用确定性历史会话；只有不存在历史会话、准备创建新会话时，才在事务内重新读取权威用户与商品并校验同校。跨校新建统一拒绝，客户端提交的 schoolId 不可信。

### 3.6 reservation 权限

`appointmentAction/createAppointment` 先保留完全相同预约的幂等返回；只有准备新建预约时，才根据可信会话参与者确定买家，并在事务内比较买家当前学校与商品固定学校。跨校新建统一拒绝；既有预约的后续状态流未改变。

### 3.7 历史关系兼容

历史收藏、历史会话和相同历史预约的读取、复用、取消或后续状态操作不因用户后来换校被删除。校验顺序明确为“先识别历史关系，再判断是否建立新关系”。

### 3.8 卖家旧商品兼容

移除了 `manageProduct` 中仅因“卖家当前学校不同于商品发布学校”而禁止重新上架的限制。所有权校验保持，商品 `schoolId / schoolName` 仍不可编辑或迁移，卖家换校后仍可管理本人历史商品。

## 4. 修改文件

### 新增文件

- `scripts/verify-phase-19.js`：49 项 Phase 19 源码与行为验证。
- `scripts/verify-phase-19-devtools.js`：生产身份、真实云函数与页面状态的零写入验收脚本。
- `scripts/deploy-phase-19.js`：仅部署本阶段 5 个云函数，并校验目标环境、配置和线上/本地摘要。
- `docs/phase-19-cross-school-detail-access.md`：本报告。

### 修改文件

- `cloudfunctions/productQuery/index.js`：详情访问模式与学校作用域。
- `cloudfunctions/favoriteProduct/index.js`：收藏新增同校闸门、历史收藏兼容。
- `cloudfunctions/messageAction/index.js`：新会话同校闸门、历史会话复用。
- `cloudfunctions/appointmentAction/index.js`：新预约同校闸门、历史预约兼容。
- `cloudfunctions/manageProduct/index.js`：卖家历史商品管理兼容。
- `services/product-service.js`、`favorite-service.js`、`message-service.js`、`appointment-service.js`、`my-products-service.js`：访问状态归一化和统一错误映射。
- `pages/product-detail/index.js`、`index.wxml`、`index.wxss`：跨校只读 UI、交互阻止与分享。
- `scripts/verify-project.js`、`verify-appointments.js`、`verify-product-school-binding.js`、`verify-phase-18-auth-market.js`、`verify-phase-18-final-cutover.js`：新安全边界和历史兼容回归。
- `package.json`：Phase 19 验证、部署与开发者工具命令。
- `README.md`：阶段状态。

### 删除文件

无。

## 5. 云函数与部署

仅部署下列函数到既有目标环境 `cloud1***6d8e`，没有部署其他函数：

| 云函数 | 状态 | runtime | handler | timeout / memory | 本地/线上 SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `productQuery` | Active | Nodejs16.13 | `index.main` | 10s / 256MB | `563edc9c...c19` |
| `favoriteProduct` | Active | Nodejs18.15 | `index.main` | 10s / 256MB | `92593303...71b` |
| `messageAction` | Active | Nodejs18.15 | `index.main` | 10s / 256MB | `8ed12dc2...b75` |
| `appointmentAction` | Active | Nodejs18.15 | `index.main` | 10s / 256MB | `67bc1f08...3c7` |
| `manageProduct` | Active | Nodejs16.13 | `index.main` | 10s / 256MB | `5fed55ac...974f` |

部署前后环境变量指纹一致；没有修改数据库 ACL、索引、学校数据、密钥或 rollout 配置。

## 6. 自动化测试

| 命令 | checks | passed | failed |
| --- | ---: | ---: | ---: |
| `npm run phase-19:verify` | 49 | 49 | 0 |
| `npm run verify` | 81 | 81 | 0 |
| `npm run phase-18:verify` | 91 | 91 | 0 |
| `npm run phase-18-school-change:verify` | 75 | 75 | 0 |
| `npm run phase-18-auth-market:verify` | 14 | 14 | 0 |
| `npm run product-school-binding:verify` | 51 | 51 | 0 |
| `npm run school-selection:verify` | 128 | 128 | 0 |

另通过 JavaScript 语法检查、JSON 解析和 `git diff --check`。微信开发者工具真实 preview 成功，主包 `473763 Byte / 462.7 KB`，未出现 80051。

## 7. 场景矩阵

| 场景 | 自动结果 | 真实双账号结果 |
| --- | --- | --- |
| 同校详情 | 通过，`sameSchool` 且允许新关系 | 当前真实账号生产只读调用通过 |
| 跨校详情 | 通过，合法 ID 为 `crossSchoolReadonly` | PASS |
| 跨校收藏 | 直接调用与伪造 schoolId 均拒绝 | PASS |
| 跨校新会话 | 直接调用与伪造 schoolId 均拒绝 | PASS |
| 跨校预约 | 直接调用拒绝 | PASS |
| 历史收藏 | 可读取/幂等识别，可取消，不新建 | PASS |
| 历史会话 | 可复用，不创建第二条 | PASS |
| 分享 | 好友与朋友圈仅含 productId | PASS |
| 卖家历史商品 | 可管理，商品学校保持不变 | PASS；真实跨校历史商品返回 `owner` |

## 8. 回归测试

Phase 18 strict 列表边界、学校游标签名、换校状态失效、商品学校固定、首页同校筛选、收藏/消息/预约既有状态机以及综合旧功能验证均通过。详情按 ID 的跨校只读没有影响 `list` 的 school-scoped strict 路径。

## 9. 人工 / 真机验收

### 已自动完成

- 生产部署与五函数线上/本地摘要核对；
- 微信开发者工具编译、preview 与包体检查；
- 当前真实账号生产只读验证：同校非本人详情返回 `sameSchool`、跨校本人历史商品返回 `owner`、非法 ID 拒绝、首页保持 `schoolScoped` 且只展示当前学校商品，console error/exception 为 0/0；
- 当前真实身份、生产数据分布和关系投影只读核验；
- 所有直接攻击、伪造字段、历史关系及 Phase 18 回归的本地行为验证。

### 真实双账号人工验收

项目负责人已完成并确认 PASS：

- 跨校非本人商品详情正常打开并进入只读模式；
- 页面正确显示其他学校商品仅支持查看的提示；
- 跨校用户不能新增收藏、会话或预约；
- 历史收藏、历史会话和历史预约继续保留；
- 好友分享进入正常，跨校接收方只读且不能建立新关系；
- 返回当前学校首页后，首页、搜索与分类仍保持当前学校作用域；
- Phase 18 strict school scope 无回归。

## 10. 数据影响

- 真实用户：未修改。
- 真实商品：未修改。
- 真实收藏：未修改。
- conversation：未修改。
- message：未修改。
- reservation / appointment：未修改。
- fixture：未创建、未删除。
- 数据迁移：未执行。
- 数据库 ACL / 索引：未修改。
- 云端影响仅为上述 5 个云函数代码部署；本轮封版没有额外业务写入。项目负责人确认跨校拒绝型人工验收通过，没有产生被禁止的新关系。

## 11. Git

| 项目 | 当前结果 |
| --- | --- |
| commit hash | 本报告所属 Phase 19 封版提交 |
| commit message | `feat: add phase 19 cross-school detail access guards` |
| tag | `phase-19-complete`（annotated） |
| push | `main` 与阶段标签均推送至 `origin` |

## 12. 阶段结论

**Phase 19 complete**

代码、自动验证、历史回归、生产部署、preview 和真实双账号跨校买家态人工验收均已完成。市场发现保持同校 strict；合法商品 ID 支持跨校只读；跨校不能新增收藏、会话和预约；历史关系与卖家历史商品管理保持兼容。Phase 20 与 Phase 21 均尚未开始。
