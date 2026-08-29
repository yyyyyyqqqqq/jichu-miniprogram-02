# Final Release Step 3C-3 Production Rollout

> 执行日期：2026-08-28（Asia/Shanghai）
> 最终状态：**STEP 3C-3 PRODUCTION ROLLOUT PASS**
> 边界：只定向部署 `userQuery`、`appointmentAction`、`messageAction`；未提交、推送、打标签，未提交微信审核或正式发布。

## A. Authorization

- 项目负责人提供了精确授权短语：`AUTHORIZE FINAL RELEASE STEP 3C-3 PRODUCTION DEPLOYMENT`。
- 执行器另要求 production 环境、单函数参数和 owner authorization 三重匹配；未把 staging、当前活动目标或上次选择当作隐式授权。
- 本轮没有获得重上架/创建测试商品、创建预约/会话 fixture、维护窗口、回滚、Git 封版或微信发布授权。

## B. Production preflight

- 活动目标明确切换并验证为 `[ENV] PRODUCTION`；environment 与 AppID 只保留脱敏值，production/staging 注册目标不同。
- 初次 fresh baseline 发现 `reserved=1 / publicVisible=1`，因此在任何 Step 3C-3 部署前停止。项目负责人说明该商品是测试发布且已下架后，重新执行 fresh baseline。
- 干净基线：products 72 = offline 57 + sold 12 + deleted 3；available 0、reserved 0、public visible 0。
- appointments 25 = cancelled 13 + rejected 3 + completed 9；active 0。
- schools 2952 / active 2952 / pending 0；official drift 0、identity conflict 0。
- `schoolQuery` 为 Active/Available、Nodejs18.15、`index.main`、10 秒、256 MB；source hash `95f227f782395293b7ba9b53a0307e74c4f90020090d43c5520867a771878899`，独立 cursor secret 和要求索引均存在。
- 部署前八集合快照在 `2026-08-28T13:40:41.235Z` 完成并通过。

## C. Approved hashes

| Function | Approved staging/local SHA-256 |
| --- | --- |
| `userQuery` | `65b120ccecb97b19eace5bfa4d5bb2a4ae62d3fadf9d9a5fcc8c47f61ae71ee9` |
| `appointmentAction` | `13e9fcc3d225f3e9e0116a28632283a820b969a6025f9f98a10a436c5d1f5e23` |
| `messageAction` | `301999900a3f170b5d80dc4e34a4404b2d40abe281c43ce73397850ab45d15b5` |

三个本地冻结 hash 在部署前复算通过；最终 production remote hash 均与批准值逐字节一致。

## D. userQuery rollout

- 严格按第一顺位单独部署。
- 部署前 remote source：`c464b43f71f6ea08107a509b37e7ac41e3985eab97e23a39a128096ce92b3979`。
- 部署后 remote source：`65b120ccecb97b19eace5bfa4d5bb2a4ae62d3fadf9d9a5fcc8c47f61ae71ee9`。
- Active/Available、Nodejs18.15、`index.main`、10 秒、256 MB、dependency install TRUE。
- `package.json`、lockfile 与本地一致；`wx-server-sdk@4.0.2`、`ws@8.21.3` 可加载。
- environment fingerprint 保持 `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`。

## E. appointmentAction rollout

- `userQuery` 即时验证通过后，按第二顺位单独部署。
- 部署前 remote source：`8959c9a8953071f9819b18bd47b655aa780ad8344e2ec5f4e0c544c9150e2f83`。
- 部署后 remote source：`13e9fcc3d225f3e9e0116a28632283a820b969a6025f9f98a10a436c5d1f5e23`。
- Active/Available、Nodejs18.15、`index.main`、10 秒、256 MB、dependency install TRUE。
- `package.json`、lockfile、`current-school-boundary.js` 与本地一致；SDK/`ws` 可加载。
- environment fingerprint 未变。

## F. messageAction rollout

- 前两项即时验证通过后，按第三顺位单独部署。
- 部署前 remote source：`345fbe2ab6016ca24f3adfb06189f8c2b0d0e4f05d11d30982c5852c11d5fa47`。
- 部署后 remote source：`301999900a3f170b5d80dc4e34a4404b2d40abe281c43ce73397850ab45d15b5`。
- Active/Available、Nodejs18.15、`index.main`、10 秒、256 MB、dependency install TRUE。
- `package.json`、lockfile、`current-school-boundary.js` 与本地一致；SDK/`ws` 可加载。
- environment fingerprint 未变。

## G. Runtime verification

- 在真实登录态、production-target DevTools 中执行只读云函数调用；`writesRequested=false`，console error 0、exception 0。
- `userQuery.publicProfile`：PASS。服务端返回权威学校名，伪造 `schoolName/schoolId` 无效，DTO 未暴露内部身份/学校字段。
- 历史聊天：PASS。既有会话和消息仍可读取。
- 历史预约：PASS。`appointmentQuery.listMine` 可读取，观测 20 条记录。
- 三项函数在额度中断后的恢复审查中再次核验为 Active/Available，remote source 仍等于批准 hash；不存在半部署状态。

## H. Client production-target verification

- 客户端活动目标、云环境绑定和私有 production 配置匹配，未回落到 staging。
- production-target 编译/preview 成功；主包 533744 bytes（521.2 KB），未执行 upload、体验版、审核或正式发布。
- 公开主页与预约错误反馈 wiring 自动验证通过。
- 跨校预约原生单按钮 modal 在 staging 已由专项验证覆盖；production-target 代码/编译/preview PASS。由于 PUBLIC MARKET ZERO 且没有安全的跨校在售商品，本轮未在 production 实际触发该 modal，不能记作 production 真机人工 PASS。

## I. Manual smoke

- `MANUAL PRODUCTION DUAL-ACCOUNT SMOKE NOT EXECUTED DUE TO ACCOUNT LIMITATION / PUBLIC MARKET ZERO`。
- 本轮没有重上架商品、造 fixture、创建新预约或新会话来绕过门禁。
- 新跨校预约、新会话边界由 12-case 服务端专项、本地回归、staging 双账号既有验收和 production 精确部署 hash 共同证明；没有伪称完成新的 production 双账号 mutation smoke。
- 历史预约、历史聊天和公开主页已通过 production 登录态只读 runtime 验证。

## J. Data integrity

部署前后八集合计数和规范化 SHA-256 逐项相同：

| Collection | Count | SHA-256 | Delta |
| --- | ---: | --- | ---: |
| users | 8 | `d876037f0db52245faecc15106086c4a0e0597f77641c93afa37685d160bc855` | 0 |
| products | 72 | `8f712baf49e5b1d8543aca14d7e92564cf9efaf53cf98658f5ebd4255f046ea8` | 0 |
| favorites | 7 | `c6f785072b496f37f6a86362287de80b0fdf97ab17050412fdec464a9f8ba12d` | 0 |
| conversations | 26 | `c7e48ae8253bfc5e7e28637ef28abdb0281c310829b65b36ceda576b9288d9b6` | 0 |
| messages | 207 | `1a566a7d816395d67c270fc75e01975b09bd22d5d398bbcaf71892d77cb09b43` | 0 |
| appointments | 25 | `0448dbbc6ba5f1d4b206e68ff70615d778cd61da8da069cc6221b45d42aefdeb` | 0 |
| schools | 2952 | `1074f64ad16a7fb1acfff7dc09efa768ad44dec79ed58a981eaacf532768d41f` | 0 |
| productViews | 27 | `b04aaa8816c5e6c953b914979ee4570a9a8def805b281eedd43192d3d09c2e90` | 0 |

部署后快照于 `2026-08-28T13:49:03.078Z` 完成。`businessDataMutation=0`。

## K. Nationwide school invariants

- total 2952、active 2952、pending 0、official drift 0、identity conflict 0。
- production `schoolQuery` 全量只读审计：2952 条、148 页、首屏 20；duplicate ID 0、cursor duplicate 0、结尾正确。
- 搜索、省份样本、签名篡改/跨 scope、非法输入门禁全部通过；204 calls、0 errors。
- 远端执行时间 min 1ms、p50 54ms、p95 67ms、max 187ms。

## L. PUBLIC MARKET ZERO

- 部署后仍为 offline 57 + sold 12 + deleted 3；available 0、reserved 0、public visible 0。
- `PUBLIC MARKET ZERO=true`。本轮没有重新发布、上架、迁移或创建商品。

## M. Automated regression

- Step 3C profile：8 cases PASS。
- Step 3C appointment current-school boundary：12 cases PASS。
- appointment modal UX 专项：PASS。
- Phase 19：50；Phase 20：78；Phase 21：64；Phase 24：88；Phase 24 pair：52，全部 PASS。
- Phase 25 lifecycle：67；hide/send race：899；diagnostic：69；rollback：35，全部 PASS。
- nationwide school selection：128；Step 3A、Step 3B、Step 3C-2 local、Phase 23 security hardening 133、project 81，全部 PASS。
- 新增脚本语法、`package.json` 解析和 `git diff --check` PASS。

## N. Rollback readiness

- 已留存三项部署前 remote source hash、批准的新 hash、运行配置和 environment fingerprint，可定位变更边界。
- 旧 source hash 与 Git `HEAD` 对应文件一致，但旧版本会重新开放跨校新预约/新会话漏洞，因此它们不是可直接恢复的安全 rollback target。
- 如新版本出现事故，优先 STOP、诊断并进入 maintenance/feature disable；只有项目负责人再次明确授权且具备安全补偿方案时才允许回滚。不得为恢复可用性盲目部署已知不安全版本。

## O. Remaining blockers

- 尚未完成 production 真实双账号的新同校预约、跨校拒绝、新会话边界和 modal 真机触发；原因是账号/样本限制与 PUBLIC MARKET ZERO，不能通过重上架或造数据规避。
- Step 3B 遗留的 production 非首 20 选校/profile/冷启动/首页/cooldown 专用账号人工闭环仍未补验。
- Final Release selective Git seal、commit/push/tag、微信体验版/审核/正式发布均未执行，等待项目负责人审阅本报告后另行授权。

**STEP 3C-3 PRODUCTION ROLLOUT PASS**
