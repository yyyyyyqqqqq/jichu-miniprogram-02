# Final Release Step 4B — Performance Optimization Controlled Rollout & Release Seal

> Current status（2026-08-29）：**PASS — STEP 4B COMPLETE**。本文第 1—15 节保留首次 staging gate STOP 的历史证据；第 16 节记录 Step 4B-1 补齐后恢复并完成的 production controlled rollout，后者为最终状态。

## 1. Release Candidate Commit

- Baseline：`main / origin/main = e47329bde21756cbbbadc2637db5169209e01e1b`，ahead/behind `0/0`，初始工作区只有批准的 P4A-01 与 Step 4A scripts/docs。
- Release candidate：`02edd6e279fe338dc6ec3f67e4b6d7219f2e0873`。
- Commit message：`perf: parallelize bounded favorite product hydration`。
- RC 只包含 8 个文件：唯一业务源码 `cloudfunctions/favoriteProduct/index.js`、两份 Step 4A 文档、三份 Step 4A benchmark/verify scripts、两份 Step 4B 单函数 deploy/runtime scripts。
- `package.json`、package lock、wx-server-sdk、runtime、cloud config、database permission、index 均无 diff；tmp/private/credential 未提交。

## 2. Pre-Deploy Remote Hash

2026-08-29 07:21:56Z production PRE snapshot：

- `favoriteProduct`：Active / Available；Nodejs18.15；`index.main`；10s / 256MB；InstallDependency TRUE。
- production remote source SHA-256：`89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1`。
- RC approved source SHA-256：`0214cf9d702af7d097aae03169cce9103a9dc54e30e4ec93caebddefe9cd6e60`。
- 部署脚本 hard-freeze 该 approved hash，并只允许函数名 `favoriteProduct`。

## 3. Rollback Source

Step 4A 前 production 版本已由三重 identity 固定：

- Git commit：`e47329bde21756cbbbadc2637db5169209e01e1b`
- Git blob：`6732bd123b5b02ede3464e869ebc32a8126f2686`
- source SHA-256：`89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1`

production 最终没有部署，因此不需要 production rollback；远端仍是上述旧版本。

## 4. Staging Result

以下内容记录 Step 4B 首次尝试时的历史 STOP。后续 Step 4B-1 已在 `docs/final-release-step-4b-1-staging-favorites-infrastructure.md` 补齐基础设施并完成真实 gate；不要把本节历史失败理解为当前 staging 状态。

### Deployment

staging 在本轮前存在 users/products 等 Phase 24/25 最小资源，但不存在 `favoriteProduct` 函数。经 explicit staging target、masked confirmation、production/staging distinct gate 后，只新建并部署 `favoriteProduct`：

- deployed only：`favoriteProduct`
- Active / Available
- Nodejs18.15 / `index.main` / 10s / 256MB
- remote source SHA-256 精确等于 RC approved hash
- package/lock match
- wx-server-sdk 4.0.2 / ws 8.21.3 loadable
- environment fingerprint 为无变量基线
- 未部署其他函数，未写业务数据

### Runtime gate

切换 ignored private active client target 并重新启动 DevTools 后，真实 staging `listMyFavorites(page=1,pageSize=10)` 返回：

- success：false
- code：`DATABASE_ERROR`
- message：收藏数据暂不可用

随后使用只读 index/collection inspection 确认根因：staging 不存在 `favorites` collection（`ResourceNotFound: Db or Table not exist: favorites`），因此也不存在 production 查询所需的关系查询/index matrix。

这不是 P4A-01 源码 semantic drift；它是 staging 最小环境未配置收藏子系统。但 Step 4B 禁止新增 schema/index/config，且 production 最终 gate 要求 staging PASS，因此不得创建 collection/index 绕过门禁，也不得用 local mock 代替 staging runtime PASS。

### Staging rollback

按 STOP/rollback 规则执行精确恢复：

- dry-run 确认只删除刚新建的 staging `favoriteProduct`；
- 删除成功；
- fresh detail 返回 Function does not exist，证明恢复至本轮前函数状态；
- ignored private active client target 已恢复为 registered production。

## 5. Production Deployment

**NOT EXECUTED。**

staging runtime gate 未通过，流程在 production deploy 前停止。没有部署 productQuery、messageQuery、appointmentQuery、schoolQuery 或任何其他函数。

## 6. Production Remote Hash

停止后 fresh production dry-run/detail：

- `favoriteProduct` 仍为 Active / Available；
- runtime/handler/resource/installDependency/environment fingerprint 未变；
- source SHA-256 仍为旧版 `89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1`；
- 与 RC approved source 不同，证明 P4A-01 未进入 production。

## 7. Before Performance

Step 4A production deployed-old-code baseline（DevTools/automator overall path）：

- 5 warm samples
- errors 0
- p50 644ms
- p95/max 747ms

这是 production before，不是 deterministic mock。

## 8. After Performance

**NOT EXECUTED。**

production 没有部署 RC，因此不存在合法的 deployed-after benchmark。不得把本地 deterministic 数字描述为 production improvement。

发布前重新执行的 local deterministic benchmark 为：

- before：p50 257.93ms / p95 266.23ms
- RC after：p50 25.01ms / p95 32.40ms
- p50 -90.30% / p95 -87.83%
- result count/order stable，business writes 0

这些数字只证明代码路径的隔离收益，不代表 production。

## 9. Error Count

- local deterministic：0 errors
- local automated regression：0 failures
- staging deployment/config/package verification：0 errors
- staging favorite read runtime：1 blocking `DATABASE_ERROR`（缺失 staging collection）
- production deployment/smoke/performance：未执行，不填写伪造的 after error count

## 10. Functional Equivalence

本地 `verify-project.js` 81 checks PASS，其中 favoriteProduct transaction、idempotency、allowed status、missing/deleted filtering、pagination、privacy/envelope 均覆盖；Step 4A verifier 44 checks PASS；关系查询、顺序、total/hasMore、DTO、authorization、school/ownership 和 mutation transaction 未变。

staging 远端 source/package/config 等价性通过，但真实 list 无法越过缺失 collection，因此 staging functional equivalence **未完成**，不能标记 PASS。

## 11. Production Data Integrity

production PRE 与停止后的 fresh AFTER snapshot 完全一致：

| Collection | PRE | AFTER |
|---|---:|---:|
| users | 8 | 8 |
| products | 72 | 72 |
| favorites | 7 | 7 |
| conversations | 26 | 26 |
| messages | 209 | 209 |
| appointments | 25 | 25 |
| schools | 2952 | 2952 |
| productViews | 28 | 28 |

八个 collection normalized digest/hash 全等，`businessDataMutation = 0`。products offline 57 / sold 12 / deleted 3，public visible 0，PUBLIC MARKET ZERO true。schools active 2952 / pending 0 / official drift 0 / identity conflict 0。

## 12. Regression Results

- JavaScript syntax：PASS
- deterministic before/after benchmark：PASS
- `verify-final-release-step-4a.js`：44 checks PASS
- `verify-project.js`：81 checks PASS
- 19 个 Final Release Step 3A–3C、Phase 19–25、学校选择/分页/源数据相关 scripts：全部 PASS
- `git diff --check`、staged allowlist、sensitive scan：PASS
- staging real list runtime：**FAIL — environment resource missing**

## 13. Rollback Status

- staging：已恢复本轮前状态，`favoriteProduct` 不存在；没有创建 `favorites` collection/index。
- production：从未部署，无需 rollback；旧 source identity 保持在线。
- rollback execution error：0。

## 14. Git Push / Tag Status

- local RC commit 已存在：`02edd6e279fe338dc6ec3f67e4b6d7219f2e0873`。
- `main` 相对 `origin/main`：ahead 1 / behind 0。
- 未 push：production deployment/performance/integrity seal gate 未完成。
- 未创建/移动/push tag。现有仓库只有 `phase-N-complete` 等阶段标签，没有明确 Final Release Step 4B tag convention；即使 PASS 也不应猜测标签名。
- 本报告保持未提交，用于记录本次 STOP 证据；不得把 RC 当作 production release seal。

## 15. Remaining Manual Checks / Required Follow-Up

要恢复 Step 4B，必须先由 owner 另行授权 staging 收藏子系统基础设施：

1. 明确创建 staging `favorites` collection 是否符合环境策略；
2. 复制 production-equivalent、非敏感的 favorites query index shape；
3. 确认 ACL；
4. 准备不影响 production 的 staging favorite relation，或明确空数据可接受的语义矩阵；
5. 重新部署 RC 到 staging 并完成第一页/下一页/顺序/total/hasMore/allowed status/missing filtering/invalid input/transaction/idempotency；
6. staging PASS 后才允许重新进入 production pre-snapshot、单函数 deployment、smoke、1 warm-up + 10 sequential samples、zero-write/integrity 和 Git push seal。

普通 Android、低内存 Android、iOS 收藏页性能仍为 **MANUAL / NOT EXECUTED**；不得伪记 PASS。

## Historical Decision After First Attempt

**PAUSED — STEP 4B-1 COMPLETE; PRODUCTION ROLLOUT NOT RESUMED**

## 16. Resumed Production Controlled Rollout（Final）

### 16.1 Active target switch proof

- Step 4B-1 结束时 ignored private active client target 为 registered staging。
- 重新读取 production/staging 注册表，只输出 masked identity，并确认两者不同。
- staging final read-only health 先通过：`favorites` exists、ACL `ADMINONLY`、两条必要索引 exact match、RC function Active/Available/hash exact、fixture leftover 0、empty-list smoke 0 errors。
- 随后将 ignored private active target 显式切换至 registered production，关闭项目并重新启动 DevTools automation。
- fresh reconnect 成功；第二次 preflight 为 `[ENV] PRODUCTION`、`activeTargetMatches=true`、`targetsDistinct=true`。

### 16.2 Workspace / source / privacy gate

- deployment 前 HEAD 为 RC `02edd6e279fe338dc6ec3f67e4b6d7219f2e0873`，相对 origin/main ahead 1 / behind 0。
- `cloudfunctions/favoriteProduct/index.js` SHA-256 仍精确为 `0214cf9d702af7d097aae03169cce9103a9dc54e30e4ec93caebddefe9cd6e60`；相对 RC 的 business source diff 为 0。
- Step 4B-1 scripts/docs 与 `_id` verifier correction 审计通过；private actor/manifest/runtime evidence 位于 ignored `tmp/`。
- staged sensitive scan：真实 AppID/environment ID、OPENID、credential、secret、token、private manifest、production raw record 均为 0。

### 16.3 Production PRE snapshot

2026-08-29 13:42:18Z fresh PRE：

| Collection | Count |
|---|---:|
| users | 8 |
| products | 72 |
| favorites | 7 |
| conversations | 26 |
| messages | 209 |
| appointments | 25 |
| schools | 2952 |
| productViews | 28 |

八集合 normalized digest 与此前 Step 4B baseline 全等。products offline 57 / sold 12 / deleted 3，available/reserved/public visible 均 0，PUBLIC MARKET ZERO true。schools 2952 total / 2952 active / 0 pending / 0 official drift / 0 identity conflict。

production old `favoriteProduct`：Active / Available、Nodejs18.15、`index.main`、10s / 256MB、InstallDependency TRUE、空变量 environment fingerprint，source SHA-256 为 `89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1`。

### 16.4 Rollback readiness

部署前从当前 repository 重新解析并验证：

- commit：`e47329bde21756cbbbadc2637db5169209e01e1b`
- blob：`6732bd123b5b02ede3464e869ebc32a8126f2686`
- reconstructed source SHA-256：`89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1`
- package.json / package-lock.json：可从该 commit 确定性恢复

三重 identity 全部匹配，rollback source ready。

### 16.5 Production deployment

只部署 `favoriteProduct`。未部署或修改任何其他函数、collection、index、ACL、runtime、dependency 或 schema。

- deployed only：`favoriteProduct`
- before source：`89bfc3412a...489f1`
- after/approved source：`0214cf9d70...6e60`
- Active / Available
- Nodejs18.15 / `index.main` / 10s / 256MB
- InstallDependency TRUE
- package/lock match
- installed wx-server-sdk 4.0.2 / ws 8.21.3 loadable
- extra files / environment fingerprint unchanged

### 16.6 Immediate production smoke

部署后先执行低频 read-only smoke，未先跑 benchmark：

- `listMyFavorites(page=1,pageSize=10)`：success / OK
- relation total：5
- page relation count：5
- filtered DTO count：5
- missing/deleted count：0（当前真实账号本页没有覆盖；staging fixture 已覆盖）
- stable order / envelope / allowed status / private-field absence：PASS
- errors / console errors / exceptions：0 / 0 / 0
- add/remove favorite：未执行

### 16.7 Four performance evidence classes

四类数字严格分开：

1. Local deterministic：mock database isolation evidence；不是线上目标。Step 4B predeploy rerun约为 after p50 25.01ms / p95 32.40ms。
2. Staging runtime：1 warm-up + 10 sequential；本轮 Step 4B-1 fixture raw relations 8 / DTO 6，p50 507ms / p95=max 552ms，0 errors；只作 staging health gate。
3. Production old deployed before：Step 4A historical warm 5 为 p50 644ms / p95=max 747ms；本轮同一 DevTools/账号/实际 5 relations 的 fresh 1 warm-up + 10 formal 为 p50 714ms / p95=max 1144ms，0 errors。
4. Production new deployed after：本轮 1 warm-up + 10 formal 为 p50 523ms / p95=max 584ms，0 errors。

### 16.8 Actual production performance comparison

| Metric | Fresh old deployed | New deployed | Change |
|---|---:|---:|---:|
| p50 | 714ms | 523ms | -26.75% |
| p95 | 1144ms | 584ms | -48.95% |
| max | 1144ms | 584ms | -48.95% |
| payload p50/p95/max | 4900B | 4900B | 0% |
| errors | 0 | 0 | unchanged |

与 Step 4A historical old baseline 比较，新版 p50 644→523ms（-18.79%），p95/max 747→584ms（-21.82%）。实际 pageSize 10、relation total/page relation 5、DTO 5、missing/deleted 0；因此这里评价的是 5 次 hydration 的真实收益，不把 local 25—45ms 或 staging 数字冒充 production improvement。

没有 DATABASE_ERROR、timeout、quota/rate limit、resource error、unhandled rejection；最大并行仍被 `MAX_PAGE_SIZE = 20` 硬限制。没有增加 retry、pool、cache 或 prefetch。

### 16.9 Functional / security equivalence

production 专项 read-only runtime 13 项 PASS：page 1/2、pagination、stable order、total、hasMore、allowed status、invalid page/pageSize、forged client identity ignored、invalid action rejection、safe envelope/DTO、client direct database denial。当前 production 真实数据没有 missing/deleted relation，故该项不伪记 production coverage；Step 4B-1 staging fixture 已真实覆盖。

既有 production zero-write security probes 18/18 PASS，包括 forged identity、malformed favorite request 与各函数 invalid action；probe 前后 counts/projected digests 全等，database write API、transaction、migration、fixture、delete 均未执行。console errors / exceptions 为 0 / 0。

本地 `verify-project.js` 81 checks、`verify-final-release-step-4a.js` 44 checks、相关 JavaScript syntax 与 `git diff --check` 全部 PASS。production 未执行合法 add/remove 或 mutation transaction；这些已由 staging 23 项 matrix 验证。

### 16.10 Production POST integrity

2026-08-29 13:50:46Z POST 与本轮 PRE 八集合逐项 normalized digest 全等，counts 仍为 8 / 72 / 7 / 26 / 209 / 25 / 2952 / 28，`businessDataMutation=0`。PUBLIC MARKET ZERO 与 schools 2952 active / 0 pending / 0 drift / 0 conflict 保持。

fresh production function detail 为 Active / Available，source SHA-256 `0214cf9d702af7d097aae03169cce9103a9dc54e30e4ec93caebddefe9cd6e60`。

### 16.11 Rollback status

Rollback **NOT EXECUTED / NOT REQUIRED**。deployment、smoke、performance、security、regression 和 integrity 全部通过；旧 source 仍由 commit/blob/hash 三重 identity 保留，可在需要时确定性恢复。

### 16.12 Git commits / push / tag

- RC：`02edd6e279fe338dc6ec3f67e4b6d7219f2e0873` — `perf: parallelize bounded favorite product hydration`
- Step 4B-1 / production read-only tooling：`d473af5` — `chore: add step 4b release verification tooling`
- 本最终 production report 以独立 documentation commit 封板。
- `main` 已 push；final fetch/rev-list 验证 local main == origin/main，ahead/behind 0/0。
- tag not created — repository 只有 `phase-N-complete` 等阶段 convention，没有 Final Release Step 4B 的既有 tag 命名规范；未猜测或创造新体系。

### 16.13 Remaining manual tests

普通 Android、低内存 Android、iOS 收藏页完整真机性能观察：**MANUAL / NOT EXECUTED**。本轮只改变云函数 hydration；不伪造真机 PASS，也没有为此制造 production mutation。

## Final Decision

**PASS — STEP 4B COMPLETE**

P4A-01 已进入 production；remote source SHA-256 为 `0214cf9d702af7d097aae03169cce9103a9dc54e30e4ec93caebddefe9cd6e60`。production benchmark errors 0，实际 5 relations 的 after p50/p95/max 为 523/584/584ms，PRE/POST invariants 全等，Git main 已封板并推送，未创建无规范依据的 tag。
