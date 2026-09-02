# Post-Final-Release Public Repository, Security & Maintainability Audit

审计日期：2026-09-02（Asia/Shanghai）。审计代码基线：`18c9e94e97e952e929a8e89959898aa6cb0da38a`。

本报告是 disabled-account hotfix 后重新执行的审计，不沿用修复前的 SECURITY NOT READY。

## 1. Final assessment

- PUBLIC REPOSITORY: **SAFE**，保留并披露下述非凭据历史标识残留。
- SECURITY: **READY**，当前审计范围内 CRITICAL / HIGH BLOCKER 为 **0**。
- MAINTAINABILITY: **C — REFACTOR RECOMMENDED**。
- 可以在不做大型重构的情况下进入微信官方审核准备；不等于保证平台审核通过。
- 微信上传、官方审核和正式发布尚未执行。本轮不执行这些操作。

READY 是在明确接受的依赖、runtime、媒体访问及反滥用债务下的结论，不表示零漏洞、零隐私风险或独立渗透测试认证。

## 2. Scope and evidence boundaries

重新检查当前 HEAD、tracked 工作树、可达提交、tags、公开 docs/reports/scripts/configs、JSON/Markdown、图片资源、fixtures、package/lock；并独立复核 13 个云函数的身份和对象授权路径。

攻击者可以修改客户端、直接调用函数、伪造全部 event 参数、知道他人 object ID、重放 requestId/cursor、绕过 UI、clone 完整公开仓库。管理员凭据被盗和平台自身失陷不属于已证明抵御的范围。

本轮 production 只调用读取配置/权限/源码及数据库查询接口，没有调用业务函数、部署、发邮件、创建 fixture、修改账号、改 runtime/dependency、ACL/index 或业务数据。原始本机证据保持 ignored，不随报告提交。

既有真实 runtime 证据与 fresh 证据分开：

- **本轮 fresh**：全仓库/历史扫描、13 函数静态审计、本地回归、npm audit、production 9 ACL、storage ACL、13 个远端入口源码比对和数据计数。
- **已有 hotfix 验收**：staging 42 次 disabled 直调拒绝、actor 精确恢复、11 函数逐个 production 部署与完整包验证、18/18 production zero-write probes、9 集合 PRE/POST 一致。详见 [hotfix 报告](post-release-disabled-account-revocation-hotfix.md)。本轮没有重复这些 mutation 或把旧探针冒充 fresh。
- 线上入口 `index.js` 本轮重新逐个比对；完整部署包的独立验证来自上述 hotfix 证据，不把入口比对描述成重新下载全部依赖包。

## 3. Public repository privacy

### Coverage and method

在基线上枚举 40 个可达提交、27 个 tags、463 个当前 tracked 文件、1,037 个公开历史唯一 blob；初次扫描另外补查本地工具 checkpoint refs 中 7 个额外 blob。提交/tag 元数据一并检查；本地 checkpoint 随工作变化，最终扫描继续覆盖，不属于推送内容。

当前文件包括 260 JS、71 JSON、69 Markdown、27 WXSS、26 WXML、7 SVG、1 CSV 和 2 个无扩展名文件。全历史未发现 raster 图片、截图、压缩包或二进制数据 dump；7 个 SVG 均为纯矢量聊天图标，无嵌入用户图片。学校 CSV/JSON 为公开学校资料与本地测试数据。

方法包括 Git object 批量读取、凭据/身份/fileID/路径模式扫描、已知本机及生产 secret 精确交叉检查、当前生产身份/文档/内容字段比对，以及对命中位置的语义复核。没有把原始命中值写入本文。短通用文本、模板和 fixture 不能仅凭字符串相等认定真实内容泄漏；模式扫描也不构成数学意义的无泄漏证明。

### Results and triage

| 项目 | 本轮结论 |
| --- | --- |
| SMTP authorization code、production/staging cursor HMAC | 当前与历史均未发现真实值 |
| AppSecret、SecretId/SecretKey、PAT、JWT、private key、CloudBase/mail/webhook credential、`.env` values | 未发现可用凭据；命中为变量名、错误码、placeholder 或明确本地测试 secret |
| OPENID/unionid、私有 user/actor ID、聊天/Feedback/预约正文、私密 fileID、精确私密位置 | 未发现真实私有数据公开；身份样本交叉检查和候选语义复核无确认泄漏 |
| 当前 AppID / 完整 production、staging 环境 ID | 未进入当前公开配置或 hotfix 文件 |
| 历史 AppID、环境 ID、本机路径 | **确有残留**，早期提交可读；属于 LOW / ACCEPTED 非凭据元数据，不宣称历史零标识 |
| 历史商品 ID | 有 16 个旧 mock/seed 商品标识及一个曾公开测试商品的 object ID；不是私有用户/会话身份，不提供授权，LOW / ACCEPTED |
| 系统消息模板 | 一条生产系统消息与代码常量相同，是通用预约自动取消模板，不是用户私聊正文 |
| 固定 Feedback 收件地址 | 已批准的服务端业务常量，恰与 SMTP 登录账号相同；不是授权码，不在 README 或本文复述 |
| 私人数据 dump、私有截图、含私有值的原始 runtime report / rollout manifest / rollback package | 没有被跟踪或进入公开历史；公开仓库保留的是脱敏汇总和学校验证报告 |

因此 clone 可获得源码、公开学校/fixture、旧非秘密部署标识及测试商品标识，但不能据本轮结果获得生产或 staging 的可用 credential、真实私有身份、聊天/Feedback 数据库 dump。知道环境或商品标识不等于获得数据库访问权。

### Hotfix-specific inspection

重新检查 hotfix 报告、rollout core、deploy/rollback 工具、staging actor 工具、revocation/runtime/integrity verifier。真实 actor OPENID、actor 文档 ID、完整目标环境 ID、原始 manifest、函数包 credential 与 authorization secret 没有进入这些公开文件。

`tmp/` 引用是本机证据路径约定，不是 manifest 正文。公开的 owner confirmation phrase 是防误操作提示，不是认证凭据；实际云调用仍需本机授权和显式目标门禁。

私有配置、依赖、临时部署包、内部编号交接文件和诊断目录继续由 `.gitignore` 排除。最终 staged 文件仅为 README、本报告和一处安全文档清理，不含私有证据。

### Documentation cleanup

README 以当前 Final Release 状态重写。Feedback 报告的一处真实本机绝对路径改为相对配置路径。历史 Phase 报告保留其审计日期和阶段结论，不把历史状态批量改成当前状态；旧历史非凭据元数据如上披露，本轮不改写 Git 历史。

## 4. Disabled-account revocation

每次受保护请求在业务处理前执行：fresh `cloud.getWXContext()` identity → authoritative `users` lookup → identity binding → `status === 'active'` → ownership/participant/school 及业务处理。

永久矩阵覆盖 **46 个 active-required actions**，实际分布在 **12 个具有受保护入口的函数**。其中 **11 个是 hotfix 影响集合**，`createProduct` 原本已有正确 gate；不能把工具的 `protectedFunctions=11` 解释成全项目只有 11 个受保护函数。

| Function | 受保护 action 数 | 复核重点 |
| --- | ---: | --- |
| authUser | 6 | existing-account 分支严格绑定/active；不存在用户的 onboarding 保留 |
| productQuery | 2 | list / myProducts；公开 detail 为有意例外 |
| createProduct | 1 | 既有 authoritative user + school gate |
| manageProduct | 7 | 统一入口 gate 在商品读取/变更前 |
| favoriteProduct | 4 | 含已存在关系、取消、列表等路径 |
| userQuery | 2 | 查看者和公开目标状态；可信当前学校 |
| productViewAction | 1 | 写浏览记录/计数前严格 active |
| messageQuery | 5 | maintenance、会话和消息读取前 gate |
| messageAction | 8 | 含 hide / delete-for-me / recall / forward |
| appointmentQuery | 3 | 所有预约私有读取 |
| appointmentAction | 6 | 新建和全部状态/cleanup 入口 |
| feedbackAction | 1 | validation、幂等、配额、落库/邮件前 gate |
| schoolQuery | 0 | 3 个公开学校查询，匿名 onboarding 不受误伤 |

本地矩阵重新验证 missing/mismatched/non-active 用户均 fail closed，active 正向及公开/onboarding 例外保留。旧 disabled blocker 分类为 **INFO / FIXED**。

保证范围是每次请求进入受保护工作前重新校验；不声称已经证明管理员在请求中途 disable 能原子中止全部在途事务，也不声称已知媒体链接会随撤权失效。

## 5. Authorization architecture

| 面向攻击者的边界 | 当前代码结论 |
| --- | --- |
| forged OPENID / userId | 不作为 caller 权威身份；由平台上下文及确定性用户记录绑定 |
| forged schoolId / schoolName | 新商品/关系从可信用户和学校记录派生；首页市场和 cursor 按权威学校隔离 |
| 商品 IDOR / mass assignment | 管理路径校验 owner，显式字段白名单；seller、学校、计数、状态等不可随意覆盖 |
| Conversation / message IDOR | canonical conversation 先做 participant 校验；message 限定授权会话；recall 还校验 sender；forward 同时校验 source/target |
| Appointment IDOR | 读取参与者限制；写入角色/状态机/商品所有权约束；cursor 的每个 OR 查询分支仍带服务端身份 |
| Favorite | 关系键绑定 caller 与商品，列表仅本人；新关系同校、历史关系仍按 owner 授权 |
| Feedback | 只有 submit，没有任意 ID 读取反馈的业务 API；内容纯文本，归属和邮件配置不可从 event 指定 |
| Replay | 请求键绑定调用者/资源，幂等和版本/状态约束保留；不把 requestId 当授权凭据 |
| Cursor | 市场/学校使用 HMAC 和 scope 校验；消息/预约 seek 参数虽不签名，但不能移除 participant/identity 查询条件 |
| Safe DTO | 公开接口显式投影，不回传 OPENID、邮件配置、完整用户记录、精确私密地点或数据库原始错误 |

未发现仅凭其他用户 object ID 就能读取/修改其私有对象的路径。保留的设计例外：公开商品 detail、匿名学校查询、首次账号 onboarding、active 用户本人历史跨校关系；这些不授予跨校新增关系或他人私有读写权。

## 6. Fresh production database / function check

2026-09-02 13:12（Asia/Shanghai）重新读取控制面；最初过期的 CLI 临时凭据经正常 CLI 续期后才进行核验，没有以旧快照代替。

| Collection | Fresh ACL | Count |
| --- | --- | ---: |
| users | ADMINONLY | 8 |
| products | ADMINONLY | 72 |
| favorites | ADMINONLY | 7 |
| conversations | ADMINONLY | 26 |
| messages | ADMINONLY | 209 |
| appointments | ADMINONLY | 25 |
| schools | ADMINONLY | 2,952 |
| productViews | ADMINONLY | 28 |
| feedbacks | ADMINONLY | 1 |

普通客户端无法绕过服务端直接读取/写入这些集合；不包括持有管理员凭据的调用。客户端业务源码也没有直接数据库访问入口。

13/13 production 函数 Active/Available，`index.main`、256 MB，远端入口源码与当前本地源码匹配；12 个 timeout 10 秒，Feedback 为 20 秒。4 个 Nodejs16.13、9 个 Nodejs18.15。产品 seed 未启用，市场及学校 cursor secret 仅验证存在/长度，不输出值。

全国 schools 2,952 active；公开市场 available/reserved 商品仍为 0。这里只报告计数和状态，不提交生产原始记录或 digest。本轮没有重新授权任何 cleanup、迁移或部署。

## 7. Storage privacy — four explicit answers

Fresh storage ACL 为 **READONLY**，没有自定义 rule。其含义是所有用户可读、创建者及管理员可写；不是“仅聊天双方可读”。[CloudBase 官方 ACL 定义](https://docs.cloudbase.net/api-reference/manager/node/storage)。

1. **普通 API 能否让非参与者取得聊天媒体 fileID？** 本轮未发现。消息 DTO 仅在 canonical participant 校验后构造，转发也校验两端会话。
2. **是否可枚举？** 业务 API 没有全桶或他人会话媒体列举入口；但不能保证全平台对象不可枚举。路径结构可知，clientMessageId 用时间和 `Math.random`，不是密码学不可猜测的授权机制。
3. **完整 fileID 泄漏后能否读？** 存在直接访问/解析下载地址的 capability 风险；已知媒体不会因 disabled、hide 或 recall 自动撤销。路径校验和 UI 隐藏不提供媒体保密性。
4. **是否 release blocker？** 按本轮明确 threat model 分类为 **MEDIUM / POST-RELEASE**；没有发现实际业务接口向非参与者泄漏 fileID。不能因此宣称 private media 已有严格私有访问控制。

发布后优先评估私有聊天媒体存储、服务端 participant 校验后的短时访问授权、密码学随机对象键和链接失效策略；不能直接把全桶改 PRIVATE 而破坏另一参与者的合法读取。

## 8. Logs, errors, uploads and abuse

云函数未发现记录完整 event、聊天/Feedback 正文或 SMTP credential 的路径；对外返回业务码和安全错误文本，不返回 stack/原始 SDK error message。消息诊断主要为散列标识和分类。Feedback 服务端日志仍保留内部 feedbackId；客户端 develop 分支存在 SDK errMsg 诊断，分类 **LOW / ACCEPTED**，应限制日志权限和留存，不能公开原始日志。

普通媒体上传有目录、后缀、声明类型/大小、参与者和归属约束，但没有对所有普通上传统一读取实际 bytes/MIME；部分 forward 路径会验证实际数据。分类 **LOW / POST-RELEASE**，不宣称完整内容安全扫描。

Feedback 有 60 秒和 24 小时 10 次配额、幂等及 database-first 流程；当前本地证据覆盖串行边界，没有证明不同 requestId 并发配额严格性。消息/发布等没有统一 actor 时间窗限流，新的 requestId 仍可能造成垃圾内容和成本。分类 **MEDIUM / POST-RELEASE**；未在生产执行并发/负载试验。

## 9. Fresh dependency and runtime audit

根目录和全部 13 个云函数分别重新运行 `npm audit --json` 与 `npm audit --omit=dev --json`，覆盖 28 个目录 × 命令组合，全部只读；全部 28 个 package/lock 文件前后不变，没有 install/update/audit fix。

| Scope | Exit | Critical | High | Moderate | Low |
| --- | ---: | ---: | ---: | ---: | ---: |
| root | 0 | 0 | 0 | 0 | 0 |
| 13 个云函数，每个 | 1 | 0 | 5 | 1 | 0 |

云函数 npm audit **不是零漏洞 PASS**。共同链为 `wx-server-sdk@4.0.2` → `@cloudbase/node-sdk@3.17.2` / `@cloudbase/database@1.4.3`，受影响包包括 `axios@0.27.2`、`lodash.set@4.3.2`、`lodash.unset@4.5.2`。5 high / 1 moderate 是包计数，不能按 13 个函数累加成独立漏洞数。

fresh 26 个 GHSA 与 [既有 Step 2A 清单](final-release-step-2a-blocker-plan.md) 逐 ID 对照：新增 0、移除 0。当前业务没有直接 Axios/任意 URL 配置注入或 realtime `.watch()` 使用；Axios 仍用于 SDK 内 metadata/request 路径，不能说依赖完全不可达。未发现当前 event 可触发的新增利用链，按本轮要求保留 **HIGH / ACCEPTED RISK / POST-RELEASE**。

`@e965/xlsx@0.20.3`、`ws@8.21.3`、仅 Feedback 使用的 `nodemailer@9.0.6` 未被本次 audit 标记；Nodemailer high/critical 为 0。Feedback 本机未安装 node_modules，按 committed lock 审计；其余 12 个函数本地安装版本与 lock 一致。

Node 16 与 18 已 EOL，**Node 20 也在官方 EOL 列表中**，不能沿用“迁到 Node20 就消除 EOL”的旧措辞。[Node 官方 EOL](https://nodejs.org/en/about/eol)。

CloudBase 文档仍将 Nodejs20.19 标为推荐、22.21/24.11 标为公测，平台支持与上游生命周期不能混为一谈。[CloudBase runtime 配置](https://docs.cloudbase.net/cli-v1/functions/configs)。后续应核实供应商补丁承诺、选择受支持 LTS 并 staging-first 验证；**HIGH PRIORITY / ACCEPTED / POST-RELEASE**。本轮未发现新增立即可利用的 runtime 风险，不擅自迁移。

## 10. Maintainability — fresh quantitative evidence

使用 Acorn 8.16.0 对 260 个 tracked JS 重新解析，全部成功。Physical LOC 包含空行/注释但不含尾部虚拟空行；Code LOC 为 token 覆盖行。函数 span 包含嵌套函数所占行；CC = 1 + 条件/循环/catch/非 default case/三元/逻辑运算符，嵌套函数单独计分。

| Metric | Value |
| --- | ---: |
| 全项目 JS physical / code LOC | 87,953 / 83,021 |
| 函数数量，含 callbacks | 6,335 |
| 非 scripts JS / physical LOC | 85 / 28,953 |
| cloud JS / physical LOC | 20 / 11,263 |
| CC ≥20 / ≥30，全项目 | 95 / 26 |
| CC ≥20 / ≥30，非 scripts | 47 / 11 |
| 非 scripts 函数 span >100 / >200 行 | 26 / 6 |
| 静态相对模块依赖边 / 循环 SCC | 561 / 2 |
| `.setData` 调用点，全项目 / 非 scripts | 237 / 233 |

### Top files, functions and responsibilities

| File | LOC | Largest / risky function span; CC | Risk / post-release action |
| --- | ---: | --- | --- |
| scripts/verify-project.js | 9,031 | verifyMessagingFunctionFlow 1,933; 139 | 测试巨石；按 domain 拆 suite/fixture，保留统一入口和断言 |
| cloudfunctions/messageAction/index.js | 2,395 | sendMessage 364; 11；内层 transaction 322; 57 | 身份、幂等、消息/会话状态与重试耦合；先拆纯决策，保留事务边界 |
| pages/chat/index.js | 2,093 | onVoiceMessageTap 187; 27；sendPendingMessage 110; 28 | 媒体、轮询、重试、取消/晚到响应状态混合；拆 controller |
| scripts/verify-appointments.js | 1,432 | appointment domain verifier | 按状态/角色拆测试模块 |
| cloudfunctions/appointmentAction/index.js | 1,338 | transitionAppointment 221; 2；内层 transaction 211; 37 | 状态转换/商品/系统消息耦合；先纯状态规则后执行层 |
| services/message-service.js | 1,190 | 消息 normalization / transport / diagnostics | 分职责及保持 DTO contract |
| scripts/verify-disabled-account-revocation.js | 1,148 | createHarness 285; 8 | 抽纯 case definitions/harness，保留 46-action 矩阵 |
| scripts/verify-phase-18-school-scoped-market.js | 1,108 | school market verifier | 渐进拆分而不是删除历史安全覆盖 |
| scripts/verify-product-school-binding.js | 1,070 | school binding verifier | 保留权威学校边界与 fake 数据分离 |
| cloudfunctions/manageProduct/index.js | 1,066 | 商品状态/编辑/清理多职责 | 后续按纯校验与事务动作分离 |
| store/auth-store.js | 984 | bootstrap 155; 15；async callback 82; 20 | cache、登录事务、版本和订阅混合；分 adapter/state machine |

外层 CC 很低不代表事务简单；安全 guard、默认值和测试断言会抬高 CC，以上不是缺陷数量。

chat 有 35 个 setData 调用点，publish 20、product-detail 18、school-select 17、home 16、product-edit 15。静态计数不是运行频率或性能故障证据，后续需测 payload/频率。

13 个 dispatchers 共 50 个操作：auth 6、productQuery 3、create 1、manage 7、favorite 4、userQuery 2、view 1、messageQuery 5、messageAction 8、appointmentQuery 3、appointmentAction 6、schoolQuery 3、feedback 1。messageAction main 为 122 行/CC 28；公开 detail 和 3 个学校操作之外的 46 个操作纳入 existing-user active 矩阵。

### Duplication and hotfix debt

按忽略空白/注释、保留 identifier/literal、至少 5 code lines 的 exact-token 函数体比较：165 组、548 个 occurrence、383 个超出首份的 copies。跨至少两个 cloud JS 文件的重复为 36 组、126 个 occurrence、90 个 extra copies。包含嵌套 callback/测试，不能当作全仓库“重复率”。

常见重复有 failure/businessError 各 8 份，success/extractRecord/getDocumentOrNull/时间转换各 7 份，transaction 和 maintenance normalization 各 4 份。

**SECURITY DUPLICATION DEBT**：11 个 hotfix 影响函数并非各新增同名 requireActiveUser。实际有 9 个本地 `assertActiveUser`，共 110 行、每个 11–20 行、CC 4–10；authUser 收紧既有 14 行 assertExistingUser，userQuery 收紧 38 行 resolveViewerContext（含学校逻辑）。createProduct 为既有 gate。

9 个 helper 约占 cloud JS 物理行数 0.98%，错误语义/onboarding 边界有差别。当前独立部署包内保持明确本地 gate，配统一 contract regression，是合理安全取舍；**LOW / ACCEPTED + POST-RELEASE**，不要求审核前引入共享 runtime 包。

新工具热点另有 deploy hotfix 840 LOC（prepareManifest 124 行/CC 8）、staging-runtime 441（run 146/9）、actor tooling 344（run 138/13）、rollout core 331、integrity 259。职责已分层，后续优先拆大 harness 和纯配置契约。

### Dependency cycles and rating

两个静态 SCC：auth-store ↔ auth-service（返回边 lazy require）；hotfix verifier → staging-runtime → deploy → verifier（含 lazy require）。CLI 均有 main guard，纯 tooling 检查不触发 deploy；不是顶层初始化失败或递归部署。后者后续把 shared cases/纯 contracts 独立出来即可。

最终 **C** 而不是 D：热点集中且可定位，service/云函数边界、显式授权、永久回归与 staging/rollback 机制支持安全渐进修 bug。技术债会提高修改成本，但**不会导致上线后几乎无法安全修 bug**；发布后 refactor priority high，不把大重构设为当前审核门槛。

## 11. Permanent local regression

`npm run verify` 已永久串联 project verifier 和 disabled-account verifier。本轮重新执行 project 81 项、46-action 撤权矩阵、Feedback 39 项，以及当前有效 auth/school/security/message/appointment/favorite/Final Release 本地 suite；260/260 tracked JS 通过 `node --check`。

批次共执行 35 条命令：34 条 exit 0，1 条历史部署门禁正确拒绝（下述例外，不计 PASS）。Phase 23 133 项和预约导出测试在同轮独立完成；Phase 25 组合为 lifecycle 67、race 899、diagnostics 69、rollback 37，再加 project 81。

| 当前有效本地回归 | 本轮结果 |
| --- | --- |
| Phase 18 market / auth-market / logout / school-change | 91 / 16 / 28 / 79 通过 |
| Phase 18 preflight / orphan-review / orphan-fix / final-readiness | 10 组 / 7 组 / 8 组 / 25 通过 |
| Phase 18 data-migration / fixture-tool | 26 / 15，通过本地 mocks，不执行迁移或 fixture 写入 |
| Phase 19 / 20 / 21 / 22a / 22b / 22 | 50 / 78 / 64 / 6 组 / 19 / 42 通过 |
| Phase 24 / auth-flow / login-transaction / pair | 89 / 71 / 35 / 52 通过 |
| schools / school-selection / product-school-binding / selector-pagination | 5 组 / 128 / 51 / 5 组通过 |
| Final Release 3A / 3B / 3C1 / 3C2 UX | PASS / 26 / 12 + 8 / PASS |
| Final Release 4A / cleanup dry-run verifier | 44 / 28，通过静态/本地边界；不宣称 fresh 性能测量 |
| appointment / chat appointment degradation / product views / locations | 导出测试入口全部通过 |

favorite 的当前本地真实函数入口覆盖身份、学校、幂等/并发、失败零写和 DTO；revocation 矩阵覆盖其全部 4 个 actions。没有重跑 production Step 4B runtime。

详细结果在本机 ignored 审计证据中保留；本报告不携带本机路径、原始输出或用户数据。提交前再次执行 `npm run verify`（81 + 46）、`npm run feedback:verify`（39）、差异检查与敏感扫描，均通过。

历史部署门禁不伪装成当前业务测试：旧 Step 2B cleanup verifier 因仍保留的过期 production manifest 返回 `MANIFEST_NOT_FRESH`，是过期写授权被正确拒绝；没有移动/改新该 manifest 或放宽安全门禁。旧 Step 4A benchmark 的 mock 缺失新 active-user 前提，不作为当前性能通过证据，也不为跑旧 benchmark 修改业务代码。

## 12. Findings and priorities

| Finding | Severity | Disposition |
| --- | --- | --- |
| 旧 disabled revocation gap | INFO | FIXED，fresh matrix 验证 |
| 既有 SDK 传递依赖告警 | HIGH | ACCEPTED / POST-RELEASE，26 GHSA 无新增 |
| Node16/18 EOL | HIGH | ACCEPTED / POST-RELEASE HIGH PRIORITY |
| READONLY known-fileID capability | MEDIUM | POST-RELEASE，无普通 API 泄漏发现 |
| 统一 anti-abuse / 并发 Feedback 配额证据不足 | MEDIUM | POST-RELEASE |
| 大聊天/事务/测试模块 | MEDIUM | POST-RELEASE，maintainability C |
| 普通上传 bytes/MIME 加固 | LOW | POST-RELEASE |
| 内部日志标识及 develop SDK 诊断 | LOW | ACCEPTED，权限/留存管理 |
| 历史非秘密部署/测试标识 | LOW | ACCEPTED，已披露而非“零残留” |
| 本地安全 helper 重复、lazy dependency cycles | LOW | ACCEPTED / POST-RELEASE |
| placeholder、test secrets、系统模板、公开/onboarding 例外 | INFO | FALSE POSITIVE，不是鉴权绕过 |

CRITICAL BLOCKER：0；HIGH BLOCKER：0。顺序建议：受支持 runtime / SDK remediation → 聊天媒体访问与反滥用 → messageAction/chat/appointment 渐进拆分及 verify-project suite 拆分 → auth state machine/工具依赖环 → Nearby School 与进一步性能工作。所有后续代码/部署需要单独任务，不在本轮启动。

## 13. Final ten questions

1. **Clone 能获得 production/staging credential 吗？** 本轮未发现；旧 AppID/env ID 只是非秘密元数据，不是授权凭据。
2. **能获得真实 OPENID/chat/Feedback/database dump 吗？** 未发现这些私有数据；可以获得公开 fixture、系统模板和上述历史公开测试商品标识。
3. **改 client 能直接 DB read/write 吗？** 普通客户端不行，9 个集合 fresh ADMINONLY；管理员 credential 是不同信任边界。
4. **forged OPENID/userId/schoolId 能绕权吗？** 当前审计和回归未发现，权威身份/学校不取自这些参数。
5. **disabled 合法身份还能绕过撤权吗？** 46-action 范围没有发现；公开查询及已知媒体 capability 是明确例外，不宣称撤销所有历史下载能力。
6. **知道他人 object ID 能 IDOR 吗？** 当前未发现，owner/participant/role 查询约束仍成立。
7. **Storage 是否存在 private media exposure？** 有完整 fileID 泄漏后的访问风险；未发现普通业务 API 泄漏他人 fileID，MEDIUM / POST-RELEASE。
8. **Logs/errors 是否泄漏正文/credential？** 当前代码未发现；内部 feedbackId/develop errMsg 残余按 LOW 管理，未审阅或公开全部历史生产日志。
9. **微信审核前还有 security blocker 吗？** 在本轮范围和明确接受风险下，没有发现 CRITICAL/HIGH blocker。
10. **适合不做大型重构直接提交微信审核吗？** 技术/安全审计结论是适合，由 owner 决定进入审核；平台合规材料及实际审核不是本报告替代物。

本轮最终只提交 public-safe 文档，推送 main、fresh fetch、确认 0/0 与 clean，不创建 tag。完成后停止，不上传小程序、不提交审核、不正式发布、不继续重构。
