# Final Release Step 3D — Selective Git Seal

> 执行日期：2026-08-29（Asia/Shanghai）
> 范围：Nationwide School + Current-School Boundary
> Git 基线：`b4242a7ae17c094753605d06b6444daf172ce28d`

## 1. Baseline HEAD

- branch：`main`
- baseline HEAD：`b4242a7ae17c094753605d06b6444daf172ce28d`
- baseline origin/main：`b4242a7ae17c094753605d06b6444daf172ce28d`
- baseline ahead/behind：`0/0`
- baseline staged：0
- working tree：34 modified、36 untracked；全部逐文件分类，没有使用 `git add -A`。

## 2. Included files

本次 seal 的 INCLUDE 共 71 个文件（含本报告）：

```text
cloudfunctions/appointmentAction/current-school-boundary.js
cloudfunctions/appointmentAction/index.js
cloudfunctions/messageAction/current-school-boundary.js
cloudfunctions/messageAction/index.js
cloudfunctions/schoolQuery/index.js
cloudfunctions/userQuery/index.js
data/schools/generated/manifest.json
docs/final-release-step-1-audit.md
docs/final-release-step-2a-blocker-plan.md
docs/final-release-step-2b-product-cleanup.md
docs/final-release-step-3a-nationwide-school-readiness.md
docs/final-release-step-3b-production-school-activation.md
docs/final-release-step-3c2-staging-acceptance.md
docs/final-release-step-3c3-production-rollout.md
docs/final-release-step-3d-git-seal.md
package.json
pages/appointment-create/index.js
pages/chat/index.js
pages/profile/index.wxml
pages/profile/index.wxss
pages/school-select/index.js
pages/school-select/index.json
pages/school-select/index.wxml
pages/school-select/index.wxss
pages/user-profile/index.wxml
reports/schools/source-anomalies.json
reports/schools/source-profile.json
reports/schools/source-summary.md
scripts/audit-final-release-step-3a-staging-query.js
scripts/audit-final-release-step-3b-production-devtools.js
scripts/audit-final-release-step-3b-production-query.js
scripts/audit-final-release-step-3c3-production.js
scripts/deploy-final-release-step-3b-school-query.js
scripts/deploy-final-release-step-3c2-staging.js
scripts/deploy-final-release-step-3c3-production.js
scripts/deploy-phase-24-auth-flow.js
scripts/deploy-phase-24-staging.js
scripts/environment-preflight.js
scripts/final-release-product-cleanup-dry-run.js
scripts/final-release-step-2b-post-audit.js
scripts/final-release-step-2b-product-cleanup.js
scripts/final-release-step-3b-core.js
scripts/final-release-step-3b-production-activation.js
scripts/phase-24-staging-core.js
scripts/prepare-final-release-step-3a-staging-indexes.js
scripts/prepare-final-release-step-3a-staging-schools.js
scripts/prepare-final-release-step-3b-production-indexes.js
scripts/prepare-final-release-step-3b-production.js
scripts/resolve-phase-18-dual-account-remote.js
scripts/setup-phase-24-staging-resources.js
scripts/verify-appointments.js
scripts/verify-final-release-product-cleanup-dry-run.js
scripts/verify-final-release-step-2b-product-cleanup.js
scripts/verify-final-release-step-3a.js
scripts/verify-final-release-step-3b-production.js
scripts/verify-final-release-step-3b.js
scripts/verify-final-release-step-3c1.js
scripts/verify-final-release-step-3c2-appointment-ux.js
scripts/verify-final-release-step-3c2-staging-runtime.js
scripts/verify-final-release-step-3c3-production-runtime.js
scripts/verify-phase-18-final-cutover.js
scripts/verify-phase-19.js
scripts/verify-phase-24.js
scripts/verify-product-school-binding.js
scripts/verify-project.js
scripts/verify-school-selector-pagination.js
scripts/verify-schools.js
services/appointment-service.js
services/message-service.js
services/public-user-service.js
utils/appointment-feedback.js
```

范围包括全国学校 signed cursor/分页/搜索/省份/窗口与最终 UI、production/staging 受控准备和只读审计、公开主页权威学校、双方当前学校与商品学校三方一致边界、历史关系兼容、预约 modal，以及对应回归和 release evidence。

## 3. Excluded files and categories

下列类别未进入候选集或 staged diff，并由 `.gitignore` 明确隔离：

- `tmp/` 中 production 原始快照、activation state/manifest、查询结果、preview 二维码与 info；
- `config/cloud.private.js`、`config/cloud.targets.private.js`、`config/cloud.secrets.private.js`、`project.private.config.json`；
- `.env*`、凭据、secret 原值、本机目标配置；
- 编号 owner-only 指令文档、`00-项目总交接文档.md`；
- `node_modules/`、`miniprogram_npm/`、缓存、日志、截图与云函数下载包。

可见的 70 个原始变更均属于已完成 Step 3A/3B/3C，没有待处理的可见 EXCLUDE 文件。具体反馈邮箱在 secret/privacy scan 中被发现后已替换为通用占位符。

## 4. Secret and privacy scan

- 私钥、真实 AppID、CloudBase environment ID、API key、access/refresh token、SMTP password/authorization code、cursor secret 原值：0。
- 真实 openid、生产用户标识、production 原始数据、用户绝对路径：0。
- 允许项：批准 source hash、deployment hash、集合计数、脱敏 environment/AppID、非 secret fingerprint、环境变量键名、测试 fixture。
- 操作确认短语是项目既有 fail-closed change-control 常量，不是云凭据；未包含 CLI/session authorization token。
- 结果：PASS。

## 5. Production invariant read-only result

Fresh read-only audit completed at `2026-08-29T06:18:47.067Z`：

- schools：total 2952、active 2952、pending 0、official drift 0、identity conflict 0。
- products：offline 57、sold 12、deleted 3；available 0、reserved 0、public visible 0。
- `PUBLIC MARKET ZERO=true`。
- `businessDataMutation=0`；本轮没有 production write。
- `156.md` 同时记录项目负责人后续 production 人工验收全部 PASS；Step 3C-3 rollout 当时未执行的人工项不在历史报告中倒填。

## 6. Function hash verification

| Function | Status | Production source SHA-256 |
| --- | --- | --- |
| `schoolQuery` | Active / Available | `95f227f782395293b7ba9b53a0307e74c4f90020090d43c5520867a771878899` |
| `userQuery` | Active / Available | `65b120ccecb97b19eace5bfa4d5bb2a4ae62d3fadf9d9a5fcc8c47f61ae71ee9` |
| `appointmentAction` | Active / Available | `13e9fcc3d225f3e9e0116a28632283a820b969a6025f9f98a10a436c5d1f5e23` |
| `messageAction` | Active / Available | `301999900a3f170b5d80dc4e34a4404b2d40abe281c43ce73397850ab45d15b5` |

四项均与 approved local/staging hash 精确一致。

## 7. Regression result

- Step 3A：PASS；Step 3B：26；Step 3C current-school boundary 12 / public profile 8；appointment UX：PASS。
- Phase 19：50；Phase 20：78；Phase 21：64；Phase 24：88；Phase 24 pair：52。
- Phase 25 lifecycle：67；hide/send race：899；diagnostics：69；rollback：35。
- nationwide school data：5 groups；school selection：128；selector pagination：5 groups。
- Phase 23 security hardening：133；project verify：81。
- production nationwide query：2952 records、148 pages、204 calls、0 errors；duplicate/cursor duplicate 0，signed tamper/scope mismatch rejected；p50 52ms、p95 65ms、max 153ms。
- `package.json` parse、229 JavaScript syntax、WXML/JSON/project checks、`git diff --check`：PASS。

## 8. Staged diff summary

- selective staged files：71。
- staged stat：71 files changed、8074 insertions、146 deletions。
- staged name-status：37 added、34 modified；仅包含第 2 节清单。
- 不包含 secret、`tmp/`、raw production dump、unrelated feature、Nearby School、Node20 migration、Feedback feature、dependency upgrade、未授权性能优化或微信发布配置。

## 9. Final commit hash

Final commit identity：**包含本报告的 Step 3D seal commit**。其不可变 SHA-1 由 `git rev-parse HEAD` / `git log -1` 和本任务最终输出记录。

说明：commit 内容无法预先包含自身最终 SHA（写入 SHA 会改变 commit object）；因此本节使用不可歧义的提交身份定义，实际 hash 在 commit 创建后由 Git 输出，不使用占位 hash 冒充结果。

## 10. Commit message

`feat: complete nationwide school rollout and school boundary fixes`

## 11. Push result

Push gate：仅在 staged diff、secret scan、production read-only invariant 和全量回归全部 PASS 后执行 `main → origin/main`。最终结果以 `git status --porcelain=v2 --branch`、`git rev-parse HEAD`、`git rev-parse origin/main` 和本任务最终输出共同确认。

## 12. Local/origin synchronization

完成门禁：local `main == origin/main` 且 ahead/behind `0/0`。该状态在 push 后 fresh fetch/remote-tracking verification 中确认。

## 13. phase-25-complete tag verification

`phase-25-complete^{}` 必须继续指向 `4967995d1ca20f0fef8050b91864721dddafbab5`。本轮不创建、不移动、不删除任何 tag。

## 14. Final working tree state

完成门禁：staged 0、modified 0、无未跟踪正式文件；只允许 `.gitignore` 已明确隔离的 private/tmp 文件存在。

## 15. Remaining final-release work

- Step 3D 只完成 Git seal，不代表微信体验版、官方审核或正式发布。
- 等待 owner 统一 Final RC seal 与后续微信发布授权。
- 不执行 Nearby School、Node20 migration、Feedback、依赖升级或其他未授权范围。

**FINAL RELEASE STEP 3D GIT SEAL PASS**
