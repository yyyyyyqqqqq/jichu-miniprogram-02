# Phase 24 独立 staging 真新用户验收环境设计与实施记录

状态：**human-validation-passed / staging retained**
原设计完成日期：2026-08-12
staging 获批、实施及真新用户人工验收完成日期：2026-08-13
适用基线：Phase 24 Round 2 工作区（尚未提交）
当前结论：**Phase 24 Round 2 complete；Phase 24 整体尚未完成。**

## 历史设计阶段边界

以下“只设计、0 写入、0 部署”描述仅代表 2026-08-12 设计阶段，已被第 24 节的 staging 实施与真新用户人工验收状态覆盖，不代表当前项目状态。

设计阶段边界：只审计、设计和记录；当时没有创建云环境、集合、索引、函数或测试数据，没有修改环境配置、源码或部署脚本。

设计阶段结果：**0 应用/云函数/工具源码修改、0 云端写入、0 部署、0 commit、0 push、0 tag**。

## 1. 执行摘要

推荐建立一个与 production 数据、函数、存储完全隔离，但继续绑定同一微信小程序 AppID 的最小 staging 云环境。首轮只复制两条公开学校元数据，创建 `users / schools / products` 三个集合，部署 `authUser / schoolQuery / productQuery / createProduct / userQuery` 五个函数，并使用独立云存储。

严格最小环境不复制收藏、消息、预约和浏览关系链。一个已经在 production 登录过的真实微信账号即可完成验收：相同 AppID 下即使其微信身份不变，staging 的 `users` 集合中没有对应记录，`loginIdentity` 仍会真实进入“首次创建用户”分支；production 记录不会被删除、修改或模拟。

本段是 2026-08-12 的设计时前置结论，已被 2026-08-13 的获批实施与人工验收覆盖。当前真实状态见第 24 节：**human validation passed**。

## 2. 为什么生产现有账号不能模拟真新用户

`authUser` 按微信上下文中的 `APPID + OPENID` 生成确定性用户 ID。production 中已经登录过的账号始终能找到原 `users` 记录；退出登录只清客户端可信会话和缓存，重新登录会走“读取既有用户”分支，不会走首次创建分支。

在 production 删除该用户、篡改 OPENID、临时换用户 ID 或清空其资料都不是可接受模拟：这会破坏真实账号、学校版本、历史商品和关系数据，也无法证明正常首次登录路径。独立 staging 的数据库命名空间为空，才同时满足“真实微信登录”和“production 零影响”。

## 3. 当前环境切换机制审计

| 文件/机制 | 当前行为 | 结论 |
|---|---|---|
| `config/cloud.js` | 优先读取被忽略的 `config/cloud.private.js`；缺失时得到公开占位符 | 可以阻止秘密进入仓库，但只有 `environmentId`，没有 production/staging 角色 |
| `config/cloud.private.js` | 当前本机文件含真实 production 环境 ID，受 `.gitignore` 保护 | 不输出实际 ID；目前是客户端和多数脚本的共同默认目标 |
| `config/cloud.private.example.js` | 只有 `YOUR_CLOUDBASE_ENV_ID` 示例 | 未表达多环境和角色约束 |
| `project.config.json` | AppID 为公开占位符，声明 `cloudfunctionRoot`，不含云环境 ID | 安全；不能单独完成环境选择 |
| `project.private.config.json` | 被忽略，含本机真实 AppID，不含云环境 ID | AppID 与云环境选择分离 |
| `services/cloud-service.js` | 初始化前校验环境 ID；缺失或占位符时报 `CLOUD_CONFIG_MISSING` | 缺配置时 fail closed，不会静默回 production |
| 云函数 | 使用 `cloud.DYNAMIC_CURRENT_ENV` | 函数部署到哪个环境，就只访问该环境资源 |
| `scripts/schools/cloud-cli.js` | 读取同一 `config/cloud.private.js` 并拒绝占位符 | 无配置时 fail closed，但不识别目标角色 |
| Phase 24 部署脚本 | 要求 `--env <masked-id>` 与本机配置匹配 | 能防输错 ID，不能防把 production ID 当作 staging |

核心风险不是“缺配置自动回 production”，而是**单个可变私有环境 ID 同时驱动客户端、部署和数据脚本，且工具不知道它代表 production 还是 staging**。当该文件仍指向 production 时，不带角色语义的脚本会把它当作自然目标。

## 4. production / staging 最小切换设计

不引入配置中心或复杂框架，只对当前私有配置机制增加最小角色语义。实施时建议采用两个均被忽略的文件：

```js
// config/cloud.targets.private.js：只保存本机环境注册表
module.exports = {
  production: '真实 production 环境 ID',
  staging: '真实 staging 环境 ID'
};

// config/cloud.private.js：只选择当前客户端目标
module.exports = {
  environmentName: 'staging',
  environmentId: '真实 staging 环境 ID'
};
```

加载器必须校验：

1. `environmentName` 只能是 `production` 或 `staging`，不得缺省。
2. `environmentId` 必须与私有注册表中该角色的 ID 完全一致。
3. 两个角色的 ID 必须非空、非占位符且互不相同。
4. 客户端只显示 `STAGING`/`PRODUCTION` 角色提示，不打印完整环境 ID。
5. 本轮实施优先复用 `config/cloud.private.js`，不再增加更多层次；注册表只承担“角色不能错配”的安全职责。

这两个文件均不得进入 Git。公开示例文件只写占位符和字段结构。

## 5. 未指定环境时的安全策略

任何 build、preview、deploy、seed、audit、cleanup 命令都必须显式提供 `--env staging` 或 `--env production`。未指定环境时直接退出，不能把当前私有配置、上次选择、production 或 staging 当默认值。

每次命令执行前必须同时打印角色、掩码环境 ID、AppID 掩码和动作类型；角色与私有注册表不匹配、两个环境 ID 相同、ID 为占位符、目标未知时一律退出。production 写命令继续要求额外的掩码 ID 确认；staging 写命令也不得只靠角色字符串放行。

## 6. 客户端、构建与体验版切换策略

同一份业务源码通过被忽略的私有选择文件连接不同云环境，微信小程序 AppID 保持不变。切换 staging 后应先运行只读 preflight，再由微信开发者工具编译，并从该编译结果生成路径为 `pages/home/index` 的体验版二维码。

验收包必须有不影响 production 的显著环境标识，例如开发版/体验版控制台首条输出 `[ENV] STAGING`，必要时在非正式构建的“我的”页显示“STAGING”；正式 production 构建不得展示该标识。禁止在 UI、日志、二维码名称或截图中暴露完整环境 ID。

同一时间只允许一个明确的本地活动角色。切换角色后必须清除开发者工具编译缓存并重新编译，不能复用先前体验二维码推断当前环境。

## 7. 部署脚本防误投产门禁

未来 staging 部署入口应只接受固定 allowlist 中的五个函数，并满足以下全部条件：

- 显式 `--env staging`；解析得到的环境 ID 与私有 staging ID 一致。
- staging ID 与 production ID 不同；任一 ID 缺失都中止。
- 显式 `--functions authUser,schoolQuery,productQuery,createProduct,userQuery`，不能使用“全部函数”。
- 展示本地函数摘要、runtime、handler、内存、超时和环境变量键名；dry-run 默认开启。
- apply 需要第二次确认 staging 掩码 ID；若发现 production 掩码或角色不一致立即退出。
- 部署后只读核对远端状态及本地/远端摘要；不得顺带修改 ACL、索引或数据。
- production 部署入口拒绝 staging 角色，staging 入口拒绝 production 角色；不能共用一个只有 `--env <任意ID>` 的写入口。

## 8. 最小集合矩阵

| 集合 | 登录 | 选校 | 首页/市场 | 发布 | 卖家公开资料 | 初始数据 | 决策 |
|---|---:|---:|---:|---:|---:|---|---|
| `users` | 必需 | 必需 | 必需 | 必需 | 必需 | 0；首次登录后 1 | **创建** |
| `schools` | 间接 | 必需 | 必需 | 必需 | 必需 | 2 条 active/valid | **创建** |
| `products` | 否 | 否 | 必需 | 必需 | 必需 | 0；验收发布后 1 | **创建** |
| `favorites` | 否 | 否 | 否 | 否 | 否 | 无 | 省略；不测收藏 |
| `conversations` | 否 | 否 | 否 | 否 | 否 | 无 | 省略；不测联系卖家 |
| `messages` | 否 | 否 | 否 | 否 | 否 | 无 | 省略；不进入聊天 |
| `appointments` | 否 | 否 | 否 | 否 | 否 | 无 | 省略；不测预约 |
| `productViews` | 否 | 否 | 否 | 否 | 否 | 无 | 省略；详情浏览统计允许受控降级 |

发布后客户端会打开商品详情并尝试记录浏览。`productViewAction` 缺失时 `product-view-service` 返回 `VIEW_RECORD_FAILED`，不阻断详情、发布结果或卖家主页。该降级必须写入验收预期；若评审要求详情页无任何非关键降级，可把 `productViews + productViewAction + idx_cleanupAfter` 作为独立可选增量，不应因此复制整套关系链。

## 9. 最小云函数矩阵

| 云函数 | 用途 | 决策 |
|---|---|---|
| `authUser` | `loginIdentity` 首次建用户、选校、资料编辑、current | **部署** |
| `schoolQuery` | 获取/搜索可用学校 | **部署** |
| `productQuery` | 首页同校市场、详情、卖家商品列表 | **部署** |
| `createProduct` | 真实发布商品 | **部署** |
| `userQuery` | 当前用户资料和同校公开卖家主页 | **部署** |
| `favoriteProduct` | 收藏状态/收藏写入 | 省略；自己的商品不会查询收藏状态 |
| `messageQuery` / `messageAction` | 会话和聊天 | 省略 |
| `appointmentQuery` / `appointmentAction` | 预约 | 省略 |
| `productViewAction` | 浏览计数 | 严格最小省略；可选无降级增量 |
| `manageProduct` | 下架、重上架、删除等商品管理 | 省略；不属于本次路径 |

五个必需函数必须部署当前 Round 2 工作区的准确版本，不能从旧 tag、production 在线包或未评审分支拼装。

## 10. 最小学校数据范围与字段

推荐固定两条已在现有项目真实验证过的公开学校元数据：上海工程技术大学、上海财经大学浙江学院。只从仓库中已归一化的教育部公开数据产物按 `officialCode` 精确筛选，不从 production 即时导出，不导入 2952 条全量数据。

每条 staging 记录保留完整归一化字段：`_id`、`officialCode`、`name`、`nameNormalized`、`province`、`city`、`educationLevel`、`authority`、`officialStatus`、`platformStatus`、`dataSource`、`sourceYear`、`sourceVersion`、`sourceRow`、`remark`。其中 `_id` 必须继续由正式算法确定性生成，`officialCode` 原样保留，`officialStatus='valid'`、`platformStatus='active'`。

保留正式 `_id` 能真实覆盖用户 `schoolId`、商品学校快照、精确查询和后续脚本兼容；环境已经隔离，因此同 ID 不会造成跨环境数据混用。

## 11. 学校数据脚本策略

未来 seed 工具只允许读取仓库 `data/schools/generated/schools.normalized.json`，并在源码中固定两所学校的 officialCode allowlist。默认 dry-run，输出将写入的记录数、名称、officialCode 掩码、确定性 `_id` 掩码和字段摘要。

apply 必须显式 `--env staging --confirm-target <掩码ID> --expected-count 2`，写前确认 staging 的 `schools` 集合为空或两条记录完全幂等；发现第三条记录、字段漂移、production 角色或目标不一致时退出。禁止远程全量复制、模糊名称匹配和“先清空再导入”。

## 12. ACL 与存储规则

最小 staging 应镜像 production 安全基线：

- `users`：`ADMINONLY`
- `schools`：`ADMINONLY`
- `products`：`ADMINONLY`
- 云存储：`READONLY`

客户端不直接读写数据库，所有业务数据库访问继续只经云函数。商品图片和资料头像使用 staging 自己的云存储路径；production 文件 ID、下载 URL 和存储对象不得复制进 staging。当前 production 已在 `READONLY` 规则下支持既有上传路径，所以 staging 不应为了方便改成所有人可写。

## 13. 最小索引清单

每个集合创建平台系统 `_id_` 唯一索引。为避免空库或小数据量掩盖真实复合查询要求，再创建以下四个业务索引：

| 集合 | 索引 | 字段 | 唯一 |
|---|---|---|---:|
| `schools` | `idx_officialCode_unique` | `officialCode ASC` | 是 |
| `schools` | `idx_platformStatus_nameNormalized_id` | `platformStatus ASC, nameNormalized ASC, _id ASC` | 否 |
| `products` | `idx_school_status_favorite_view_createdAt_id` | `schoolId ASC, status ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC` | 否 |
| `products` | `idx_seller_school_status_createdAt_id` | `sellerOpenid ASC, schoolId ASC, status ASC, createdAt DESC, _id ASC` | 否 |

第一轮人工脚本固定首页为“全部分类 + 综合排序”，因此只需一个 strict 市场排序索引；公开卖家主页需要 seller/school 索引。若人工脚本要切“最新”、价格、分类或省份筛选，必须先按 production 已验证定义增加对应索引，不允许在缺索引时把报错解释为业务失败。

`users` 当前查询以确定性文档 ID 或单条 `_openid` 查找为主，不需要额外业务索引；平台自动索引是否出现由创建后只读审计记录。`idx_platformStatus_province_nameNormalized_id`、其余 strict 排序/分类索引、关系集合索引均不属于本次最小闭环。

## 14. 云函数环境变量与运行参数

`productQuery` 必须使用一个只属于 staging 的高熵 `PRODUCT_QUERY_CURSOR_HMAC_SECRET`，不得复制、打印或散列比较 production secret 的明文。部署和审计只显示键名、是否存在和不可逆指纹。

`PRODUCT_SEED_ENABLED` 明确设为 `false`。`SCHOOL_SCOPED_MARKET_ENABLED=true`、`SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL=true` 和空 allowlist 当前是源码常量，不是远端环境变量；部署后要通过源码摘要和只读行为确认它们没有漂移。

五个函数的 runtime、handler、超时、内存和依赖版本应与当前 production/本地已验证基线一致，除 staging 独立 secret 外不引入环境特例。

## 15. 独立云存储设计

staging 使用本环境默认存储，不挂载或引用 production bucket。验收只上传：一组测试商品媒体、一次可选资料头像。对象路径必须带可识别但不含个人信息的前缀，例如 `phase24-staging/<run-id>/...`，便于精确清理。

测试前记录 staging 存储对象基线；测试后按 run-id 列出精确对象清单。禁止批量删除未知前缀，禁止把 production fileID 作为 staging 商品媒体。

## 16. 测试账号与 fixture 策略

**严格最小只需一个真实微信账号**：它可以已经在 production 使用过，但必须在 staging 的 `users` 集合中不存在。首次登录后由真实 `loginIdentity` 创建唯一 staging 用户；不得由管理员预建用户记录。

初始 `products` 为空，不造用户、不造商品、不造关系 fixture。账号完成选校后自己发布一件带明显测试标识的商品，即可在首页看到同校商品，并从详情进入自己的公开卖家主页；这足以覆盖 fallback 和公开白名单的真实函数路径。

若评审还要求验证“另一个用户看到卖家主页”，再增加第二个真实体验成员账号，仍由其真实首次登录生成记录。不要用伪造 OPENID、复制 production 用户或管理员插入用户代替。

## 17. 验收前置检查

实施后的每次人工测试开始前必须满足：

1. 客户端、部署工具和只读审计均显示角色 `staging`，且掩码环境 ID 一致。
2. staging ID 与 production ID 明确不同。
3. 三集合 ACL 与存储 ACL 符合第 12 节。
4. 五个函数 Active/Available，本地与远端源码/package/lock 摘要一致。
5. 四个业务索引和系统 `_id_` 索引存在，定义正确。
6. `schools=2`、`users=0`、`products=0`；存储测试前缀为空。
7. 被测微信账号对应的 staging 用户 ID 查询为不存在；production 只做计数/摘要基线，不查询或输出敏感身份字段。
8. 体验二维码入口为 `pages/home/index`，包内显示/记录 `STAGING` 角色。

任何一项不满足都停止，不通过删除 production 用户或临时放宽权限绕过。

## 18. 真新用户完整人工脚本

1. 用已经在 production 使用过、但未进入过 staging 的体验成员账号扫码。
2. 冷启动应进入单一“微信登录”按钮；不得出现旧昵称头像注册表单或“页面不存在”。
3. 点击登录。后端应真实创建 staging 用户：`authenticated=true`、`profileCompleted=false`、无学校、昵称/头像可空。
4. 自动进入选校页，选择两所测试学校之一；确认 7 天换校模型和 `schoolVersion` 初始化语义没有被绕过。
5. 回到首页/市场。空市场正常展示，不因资料未完善阻断；请求保持 school strict。
6. 发布一件测试商品并上传 staging 图片。资料未完善时发布仍成功，商品学校固定为所选学校。
7. 发布后详情正常打开。浏览统计缺失属于已批准的非关键降级，不得出现业务错误页。
8. 从商品进入公开卖家主页；空昵称显示“校园用户”，空头像显示统一默认头像，公开字段仍受白名单和同校规则约束。
9. 进入“我的 → 编辑资料”，补昵称和头像；返回后当前用户/公开卖家主页显示更新资料。
10. 旧商品的发布时卖家快照不会自动回填；若快照为空，商品卡继续使用统一 fallback，这是预期，不应误判为编辑失败。
11. 显式退出、模拟重启、再次微信登录；应读取 staging 中刚创建的同一用户，保留学校和资料，不再进入首次创建。
12. 管理端只读核对：`users=1`、`products=1`、学校仍为 2，production 前后计数/摘要不变。

人工报告必须区分“首次登录创建”和“第二次登录读取已有记录”，并保留页面截图、时间、体验版版本号、staging 角色证明和无敏感信息的只读摘要。

## 19. 清理、保留与销毁方案

### 长期保留 staging

保留环境、三集合、两条学校、五函数、四索引和独立 secret；每次验收后只清本次 run-id 的商品媒体、商品记录和真实测试用户，学校数据保留。清理前先导出精确对象/文档 ID 清单，按“存储对象 → 商品 → 用户”顺序处理，逐项核对计数；发现未知数据立即停止。

### 一次性临时环境

验收报告归档后先吊销体验二维码/停止使用 staging 配置，再核对 production 不变；记录精确 staging 环境 ID 后销毁整个 staging 环境。环境级销毁优于对未知集合做递归清空，但仍须由项目负责人单独授权和在控制台二次确认。

### 清理门禁

任何 cleanup 工具必须显式 `--env staging`、匹配私有注册表、拒绝 production ID、要求 run-id 与精确预期数量、先 dry-run。不得使用空变量、通配符、名称前缀推断环境或“删除全部”默认动作。

## 20. 成本与维护开销

本方案不承诺具体价格，实施前应以 CloudBase 控制台当期计费为准。相对成本估计如下：

| 项目 | 规模 | 成本/维护判断 |
|---|---|---|
| 环境 | 1 个额外环境 | 可能有基础资源或套餐占用，需控制台确认 |
| 函数 | 5 个、仅人工验收流量 | 调用成本低；版本漂移维护中等 |
| 数据库 | 3 集合、约 3—5 条文档 | 存储/读写成本很低 |
| 存储 | 少量测试图片/头像 | 很低，但必须定期清理 |
| 索引 | 4 个业务索引 | 数据量极小时成本低 |
| 人工 | 每轮部署、核对、清理 | 主要开销；角色门禁可降低误操作成本 |

真正的长期成本不是流量，而是 production 与 staging 函数、索引、ACL 和 secret 的配置漂移。

## 21. 长期保留与一次性临时环境比较

| 方案 | 优点 | 缺点 | 适用条件 |
|---|---|---|---|
| 长期保留 | Phase 25 RC、后续首次登录回归可重复；避免每次重建 | 持续成本、配置漂移、测试数据清理责任 | 后续至少还会做一次 RC/发布前回归 |
| 一次性临时 | 最小长期成本和攻击面；验收后完全销毁 | 每次重建慢，容易重复人工错误，无法保留回归基线 | 只做本次一次验收，之后没有新用户回归需求 |

结合既定 Phase 25 路线，建议**长期保留最小 staging 到正式发布后一个稳定观察周期**，但每轮清空用户、商品和媒体，只保留学校/函数/索引/ACL。若项目负责人明确 Phase 25 不再复测，再选择一次性销毁。

## 22. 风险清单与完成判定

| 风险 | 后果 | 防护 |
|---|---|---|
| staging ID 与 production ID 配错 | 误部署/误写生产 | 私有角色注册表、ID 必须不同、双向拒绝、掩码确认 |
| 客户端仍连 production | 新用户被当老用户或污染生产 | `[ENV] STAGING`、预检空用户、体验包重新编译 |
| 复制 production 用户/商品 | 不再是真新用户测试且引入隐私 | 只复制公开学校元数据；用户/商品由测试路径产生 |
| 少建索引 | 小数据误判或运行时报错 | 固定四个业务索引并核对定义 |
| 放宽 ACL | 绕过云函数安全模型 | 三集合 ADMINONLY、存储镜像 READONLY |
| 复用 production secret | 秘密扩散 | staging 独立高熵 secret，只审计键和指纹 |
| 缺少关系函数 | 误把非测试范围当故障 | 锁定手工路径；不点收藏、聊天、预约；记录浏览降级 |
| 测试数据残留 | 成本/隐私/后续假阳性 | run-id、精确清单、计数门禁、验收后清理 |
| staging 漂移 | 验收结论不代表待发布代码 | 部署当前工作区摘要，验收前对齐函数/索引/ACL |
| 同一账号二次测试 | 不再进入首次创建 | 每轮清理 staging 用户或换未使用账号；绝不删 production |

环境建立本身不等于 Phase 24 Round 2 人工完成。只有第 18 节全路径由真实新 staging 用户通过、前后 production 零变化证据成立、并由项目负责人确认，才能把人工验收标记为 complete。

## 23. 推荐结论、下一步与本轮停止点（2026-08-12 历史设计结论）

推荐方案是：同一小程序 AppID + 独立 CloudBase staging 环境；3 个集合、5 个函数、2 条学校、4 个业务索引、独立存储和独立 cursor secret；一个真实账号即可完成最小闭环。长期保留到 Phase 25/正式发布后的稳定观察周期，然后再决定销毁。

没有同等真实且更安全的“production 内模拟”方案。更强隔离的替代项是“独立测试小程序 AppID + 独立云环境”，但它会改变 APPID/OPENID 身份域、提高体验成员和发布运维成本，反而不如同 AppID 的独立 staging 贴近本次登录问题；本地 mock、伪造 OPENID 或 production 临时删用户均不能作为人工验收替代。

以下为当时设计阶段的待评审步骤，现均已由第 24 节的实施与验收状态覆盖：

1. 项目负责人确认长期/临时策略和允许建立独立云环境。
2. 评审私有角色注册表、脚本双门禁、资源/索引清单和成本。
3. 另开实施任务，先 dry-run，再创建环境和最小资源。
4. 完成真实账号人工验收与 production 零变化复核。
5. 清理测试用户/商品/媒体；决定保留或销毁。

**历史停止点：本设计当时到此停止并等待项目负责人评审；该状态已被 2026-08-13 的获批实施和人工验收覆盖。**

## 24. 2026-08-13 实施与人工验收状态：human validation passed

方案已按 `106.md` 获批实施，并按 `107.md` 收录项目负责人的真实扫码结论。当前结论为 **human validation passed**，Phase 24 第二轮完成；Phase 24 整体仍未完成。

### 环境与防误投产

- 使用同一小程序 AppID 下的独立 CloudBase 个人版 staging；环境于 2026-08-13 创建，当前状态正常。公开记录只保留 `STAGING` 与掩码环境标识，真实 production/staging ID、AppID 和 secret 均只在本机私有配置中。
- `config/cloud.targets.private.js` 保存 production/staging 注册关系，`config/cloud.private.js` 只保存当前活动角色与 ID；两者及 staging secret 文件均受 `.gitignore` 保护且未被 Git 跟踪。
- `config/environment.js` 与 `scripts/environment-preflight.js` 对角色、注册关系、ID 不同、占位符、动作、活动客户端和二次目标确认统一 fail closed。客户端当前活动目标为 staging，并在初始化前输出 `[ENV] STAGING`。
- build/preview/audit 均要求显式角色；deploy/seed/resource-create/cleanup 还要求掩码目标二次确认。production 非活动目标只允许显式只读 audit，任何 production 写入仍被拒绝。

### 已创建资源

- 集合仅有 `users`、`schools`、`products`；未创建 `favorites`、`conversations`、`messages`、`appointments`、`productViews`。
- 三集合 ACL 均为 `ADMINONLY`；staging 独立存储为 `READONLY`，没有临时开放规则。
- 四个业务索引已逐字段回读：schools 的 `idx_officialCode_unique`（唯一）与 `idx_platformStatus_nameNormalized_id`；products 的 `idx_school_status_favorite_view_createdAt_id` 与 `idx_seller_school_status_createdAt_id`。字段顺序、ASC/DESC 与 unique 均和设计一致。
- 只按 officialCode allowlist 从仓库规范化数据写入上海工程技术大学（4131010856）和上海财经大学浙江学院（4133014207），完整规范字段保留、平台状态为 active；seed 复跑为幂等。
- 人工扫码前数据计数为 `users=0 / schools=2 / products=0`；人工验收后真实状态为 `users=1 / schools=2 / products=1`。

### Secret 与函数

- `productQuery` 使用 staging 独立高熵 `PRODUCT_QUERY_CURSOR_HMAC_SECRET`；仅记录不可逆指纹 `dfe1058fbfb31682`，并设置 `PRODUCT_SEED_ENABLED=false`。远端环境变量整体指纹与 production 不同。
- 只部署当前 Phase 24 Round 2 工作区的 `authUser`、`schoolQuery`、`productQuery`、`createProduct`、`userQuery`，未部署其余函数。
- 五项均回读为 Active/Available、`index.main`、10 秒、256 MB；runtime 与 production 基线一致。本地/远端源码 hash、package、lock、`wx-server-sdk 4.0.2` 及 `ws` 版本全部一致且依赖可加载。

### Production 零变化核验

- staging 实施前的本轮 production 只读基线为 users 8、products 70、favorites 6、conversations 20、messages 145、appointments 20、productViews 24、schools 2952；实施完成后的只读复核一致。
- Phase 23 的 8 月 9 日历史快照是 products 68、messages 144、appointments 19。新增的 2/1/1 条记录均可由脱敏创建时间证明早于 8 月 13 日 staging 环境建立，不是本轮 staging 操作造成。
- 12 个 production 云函数仍 Active/Available；八集合 ACL、存储规则、索引名称/关键定义和函数环境变量指纹均与 Phase 23 基线一致。
- production 中不存在标题为 `Phase24 Staging Test` 的商品；users 计数未变化，没有 staging 测试用户进入 production。本轮生产核验只读，未调用函数、未部署、未改 ACL/索引。

### 自动验证与 preview

- Phase 24 staging 专项 39 项通过，覆盖缺失环境、角色/ID 不匹配、同 ID、占位符、production 写保护、私有文件未跟踪、公开示例占位符与脚本双门禁。
- 连同 Phase 24 Round 2 及 Phase 18—23 全部适用回归，共 1029 项断言通过。
- staging preview preflight 显示 `[ENV] STAGING`、活动目标匹配、目标不同；微信开发者工具 CLI preview 成功，入口由 `app.json.entryPagePath` 与编译条件固定为 `pages/home/index`，最终收尾主包 490323 Byte（478.8 KB）。
- 新二维码只保存在受忽略的 `tmp/phase-24-staging-preview-qr.png`；没有复用旧 production 二维码，也没有在名称、文档或日志摘要中记录完整环境 ID。

### 真实人工验收结果

- 项目负责人使用一个已在 production 使用、但从未进入 staging 的真实微信身份扫码；入口为 `pages/home/index`，无“页面不存在”。
- 登录页只有“微信登录”，不要求头像昵称，不出现旧资料表单。
- `loginIdentity` 真实首次创建用户，users `0→1`；人工过程确认初始空昵称/头像、`profileCompleted=false`、active、`schoolRequired=true`，没有伪造学校。
- 自动进入选校并选择上海工程技术大学；学校 ID/名称正确、`schoolReady=true`，`profileCompleted` 仍可为 false。
- 首次首页因 products=0 显示“暂时没有可浏览的商品”，属于 **Expected / By Design**，不是 Bug。
- `profileCompleted=false` 时市场、发布和公开卖家主页均正常；发布 `Phase24 Staging Test` 后 products `0→1`，首页出现商品，服务端权威学校、卖家身份和测试媒体均已只读回读确认。
- 空资料 fallback 正确：昵称“校园用户”、统一默认头像、公开字段白名单与同校规则保持。
- 编辑资料补充头像昵称后，`schoolId` 和 `schoolVersion` 不变。
- logout/relogin 读取同一用户，不再次创建或选校，学校和资料保留；users 仍为 1。
- 第一轮地图、图片、视频与前后台恢复不闪登录 UI，没有回归。

### Expected Limitation：消息服务未部署

staging 只部署五个 Round 2 必需函数，未部署 `messageQuery / messageAction / appointmentQuery / appointmentAction / favoriteProduct / productViewAction / manageProduct`。消息 Tab 因此显示消息服务缺失错误态，这是最小环境的 **Expected Limitation**：production 消息能力未受影响，本轮不验聊天/消息，也不为 Round 2 补部署消息函数。Phase 24 第四轮若需要 staging 全业务矩阵，再单独评估扩展。

### 最终 production 零变化与保留策略

人工验收后再次只读审计：production 当前本轮基线计数不变，12 个函数仍 Active/Available，ACL、索引、存储和函数环境变量指纹均无变化；production 中没有 staging 测试商品或用户。staging 用户、商品和媒体与 production 完全隔离。

当前不执行 cleanup。按长期保留策略，环境、两条学校、五个函数、四个业务索引、ACL、存储规则、独立 secret 及当前真实验收数据保留到 Phase 24 Round 4 / Phase 25 RC；清理须后续另行授权。

本次实施不 commit、不 push、不创建或移动 tag；`phase-24-round-1-complete` 继续作为唯一中途稳定点。
