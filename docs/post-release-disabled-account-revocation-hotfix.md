# Post-Final-Release Disabled Account Revocation Hotfix

> Status: PASS — implementation, staging revocation/restore, production rollout, zero-write probes, and PRE/POST integrity gates completed.
>
> Scope: server-side revocation of authenticated actions after an authoritative `users.status` becomes non-`active`. Public and onboarding semantics remain unchanged.

## 1. Vulnerability

Several production cloud-function actions trusted a fresh WeChat `OPENID`, ownership, or conversation/appointment participation without re-reading the authoritative `users` record. A previously authenticated account could therefore continue selected private reads or writes after an operator changed that account to `status: disabled`.

## 2. Threat Model

The attacker is a previously valid user whose authoritative user record is now missing, identity-mismatched, or disabled, but who can call a cloud function directly and bypass client-side routing and cached login-state checks. Enforcement must occur inside every active-user-only cloud action before protected reads, ownership/participant checks, relation creation, or mutation.

Out of scope are anonymous public product detail, anonymous school discovery used during onboarding, first-account creation branches in authentication, unrelated authorization redesign, dependency upgrades, storage cleanup, and maintainability refactors.

## 3. Root Cause

The server already had strict authoritative checks in `createProduct` and `productQuery.list`, but the rule was not consistently applied at every private action boundary. The initial matrix review also found that `authUser` and `userQuery` treated only the literal `disabled` value as revoked, so malformed or future non-`active` statuses could pass. Fresh platform identity proves who invoked a function; it does not prove that the authoritative application account is still active.

## 4. Action Matrix

Classification vocabulary:

- **Public / anonymous**: no identity or active-user gate may be added.
- **Authentication / onboarding-safe**: identity is required, but a pre-existing active user is not always required because the action creates an account, reports its state, or is part of approved onboarding. Existing disabled detection must remain.
- **Active user required**: a fresh identity and an authoritative active, correctly bound user record are required before protected work.

| Function | Action | Class | Requires identity | Requires active user | Current check | Gap | Decision |
|---|---|---|---:|---:|---|---|---|
| `authUser` | `loginIdentity` | Authentication / onboarding-safe | Yes | No at entry | Fresh `OPENID`/`APPID`; authoritative deterministic user lookup; creates an active record only when absent | Existing records rejected only literal `disabled`; other non-active values could be projected active and updated | Preserve missing-user onboarding; require every existing record to be correctly bound and exactly active |
| `authUser` | `login` | Authentication / onboarding-safe | Yes | No at entry | Same authoritative existing-record lookup; creates when absent | Same non-active status gap | Preserve missing-user onboarding; strictly gate every existing record |
| `authUser` | `current` | Authentication / disabled-state detection | Yes | No outer gate | Authoritative lookup and binding check; literal disabled returns the safe disabled error | Unknown/non-active status could be projected as active | Keep reachable; map every bound non-active record to the existing safe `USER_DISABLED` envelope |
| `authUser` | `updateProfile` | Active user required | Yes | Yes | Authoritative record must exist; binding and literal-disabled checks precede update | Non-active values other than `disabled` were accepted | Require exact active status before validation/update |
| `authUser` | `selectSchool` | Active user required | Yes | Yes | Transactional authoritative record lookup precedes school mutation | Non-active values other than `disabled` were accepted | Require exact active status before school reads/mutation |
| `authUser` | `updateSchool` | Active user required | Yes | Yes | Transactional authoritative record lookup precedes school mutation | Non-active values other than `disabled` were accepted | Require exact active status before school reads/mutation |
| `productQuery` | `list` | Active user required | Yes | Yes | Market context resolves deterministic authoritative user, binding, active status, and active school | None | No code change |
| `productQuery` | `detail` | Public / anonymous | No | No | Publicly visible product detail is anonymous; optional caller identity only expands owner access | None | Preserve approved public semantics; no active gate |
| `productQuery` | `myProducts` | Active user required | Yes | Yes | Fresh `OPENID` and seller ownership filter only | No authoritative existence, binding, or active-status check | Add a local authoritative active-user gate for this action only |
| `createProduct` | `(create)` | Active user required | Yes | Yes | Fresh `OPENID`/`APPID`; deterministic authoritative user lookup; binding, active status, and school checks precede write | None | No code change |
| `manageProduct` | `takeOffline` | Active user required | Yes | Yes | Fresh `OPENID` plus product ownership/state checks | Missing authoritative user gate | Add one handler-boundary local gate before product access |
| `manageProduct` | `relist` | Active user required | Yes | Yes | Fresh `OPENID` plus product ownership/state checks | Missing authoritative user gate | Same handler-boundary gate |
| `manageProduct` | `markSold` | Active user required | Yes | Yes | Fresh `OPENID` plus product ownership/state checks | Missing authoritative user gate | Same handler-boundary gate |
| `manageProduct` | `getEditableProduct` | Active user required | Yes | Yes | Fresh `OPENID` plus product ownership check | Missing authoritative user gate | Same handler-boundary gate |
| `manageProduct` | `updateProduct` | Active user required | Yes | Yes | Fresh `OPENID` plus product ownership/validation checks | Missing authoritative user gate | Same handler-boundary gate |
| `manageProduct` | `softDelete` | Active user required | Yes | Yes | Fresh `OPENID` plus product ownership/state checks | Missing authoritative user gate | Same handler-boundary gate |
| `manageProduct` | `retryImageCleanup` | Active user required | Yes | Yes | Fresh `OPENID` plus product ownership/cleanup checks | Missing authoritative user gate | Same handler-boundary gate |
| `favoriteProduct` | `getFavoriteStatus` | Active user required | Yes | Yes | Fresh `OPENID`/`APPID`; product/relation logic reads the user only inside selected paths | Disabled caller can still inspect private relation state | Add one handler-boundary local gate |
| `favoriteProduct` | `addFavorite` | Active user required | Yes | Yes | New-relation transaction checks an active user | Existing-relation/idempotent path can return before the active check | Add one handler-boundary local gate; retain transactional checks |
| `favoriteProduct` | `removeFavorite` | Active user required | Yes | Yes | Fresh identity; user may be read but disabled is not rejected | Disabled caller can mutate relation | Add one handler-boundary local gate |
| `favoriteProduct` | `listMyFavorites` | Active user required | Yes | Yes | Fresh identity and caller relation filter | Missing authoritative user gate | Add one handler-boundary local gate |
| `userQuery` | `publicProfile` | Active user required by approved viewer-school semantics | Yes | Yes | Viewer is resolved from the authoritative deterministic user record and school; public target lookup hides literal disabled | Viewer and target rejected only literal `disabled`, not every non-active value | Require exact active viewer and active public target; name does not make this anonymous |
| `userQuery` | `publicProducts` | Active user required by approved viewer-school semantics | Yes | Yes | Same authoritative viewer/school and target boundary | Same non-active status gap | Require exact active viewer and active public target |
| `productViewAction` | `recordView` | Active user required | Yes | Yes | Fresh `OPENID`; product/view-window logic | Missing authoritative existence, binding, and active-status check before write/counter update | Add a local gate before product/view access |
| `messageQuery` | `listConversations` | Active user required | Yes | Yes | Fresh `OPENID`; maintenance and participant filters | Missing authoritative user gate | Add one handler-boundary local gate before maintenance/business queries |
| `messageQuery` | `getConversation` | Active user required | Yes | Yes | Fresh `OPENID`; participant authorization | Missing authoritative user gate | Same handler-boundary gate |
| `messageQuery` | `getMessageDeliveryStatus` | Active user required | Yes | Yes | Fresh `OPENID`; sender/participant authorization | Missing authoritative user gate | Same handler-boundary gate |
| `messageQuery` | `listMessages` | Active user required | Yes | Yes | Fresh `OPENID`; participant authorization | Missing authoritative user gate | Same handler-boundary gate |
| `messageQuery` | `listConversationProducts` | Active user required | Yes | Yes | Fresh `OPENID`; participant authorization | Missing authoritative user gate | Same handler-boundary gate |
| `messageAction` | `createOrGetConversation` | Active user required | Yes | Yes | Fresh `OPENID`/`APPID`; deeper new-conversation path checks buyer/seller status | Idempotent/existing-conversation paths are not uniformly gated at entry | Add one handler-boundary local gate; retain deeper peer checks |
| `messageAction` | `sendTextMessage` | Active user required | Yes | Yes | Fresh identity plus participant/state checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `messageAction` | `sendMessage` | Active user required | Yes | Yes | Fresh identity plus participant/state checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `messageAction` | `markConversationRead` | Active user required | Yes | Yes | Fresh identity plus participant check | Missing authoritative caller-status check | Same handler-boundary gate |
| `messageAction` | `hideConversation` | Active user required | Yes | Yes | Fresh identity plus participant check | Missing authoritative caller-status check | Same handler-boundary gate |
| `messageAction` | `deleteMessageForMe` | Active user required | Yes | Yes | Fresh identity plus participant/message check | Missing authoritative caller-status check | Same handler-boundary gate |
| `messageAction` | `recallMessage` | Active user required | Yes | Yes | Fresh identity plus sender/state checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `messageAction` | `forwardMessage` | Active user required | Yes | Yes | Fresh identity plus source/target participant checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `appointmentQuery` | `detail` | Active user required | Yes | Yes | Fresh `OPENID`; appointment participant authorization | Missing authoritative user gate | Add one handler-boundary local gate before maintenance/business queries |
| `appointmentQuery` | `listMine` | Active user required | Yes | Yes | Fresh `OPENID`; participant query | Missing authoritative user gate | Same handler-boundary gate |
| `appointmentQuery` | `getActiveByConversation` | Active user required | Yes | Yes | Fresh `OPENID`; conversation/appointment participant checks | Missing authoritative user gate | Same handler-boundary gate |
| `appointmentAction` | `create` | Active user required | Yes | Yes | Fresh `OPENID`/`APPID`; deeper create transaction checks buyer/seller active status | No uniform caller gate before all preliminary work | Add one handler-boundary local gate; retain deeper peer checks |
| `appointmentAction` | `accept` | Active user required | Yes | Yes | Fresh identity plus participant/role/state checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `appointmentAction` | `reject` | Active user required | Yes | Yes | Fresh identity plus participant/role/state checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `appointmentAction` | `cancel` | Active user required | Yes | Yes | Fresh identity plus participant/role/state checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `appointmentAction` | `complete` | Active user required | Yes | Yes | Fresh identity plus participant/role/state checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `appointmentAction` | `retryProductSoldCleanup` | Active user required | Yes | Yes | Fresh identity plus appointment participant/cleanup checks | Missing authoritative caller-status check | Same handler-boundary gate |
| `schoolQuery` | `list` | Public / anonymous onboarding | No | No | Valid action/input and active-school query; no identity required | None | Preserve anonymous onboarding access |
| `schoolQuery` | `search` | Public / anonymous onboarding | No | No | Valid action/input and active-school query; no identity required | None | Preserve anonymous onboarding access |
| `schoolQuery` | `detail` | Public / anonymous onboarding | No | No | Valid school identifier and public active-school lookup; no identity required | None | Preserve anonymous onboarding access |
| `feedbackAction` | `submit` | Active user required | Yes | Yes | Fresh `OPENID`; validation/rate limit/database-first submission flow | Missing `APPID`, authoritative user lookup, binding, and active-status check | Add a local gate before rate-limit and submission work; preserve mail/data ordering |

Invalid or legacy action names remain invalid and must fail before business dispatch; they are not granted an authentication classification.

## 5. Files Changed

- Active-user enforcement: `authUser`, `productQuery`, `userQuery`, `manageProduct`, `favoriteProduct`, `productViewAction`, `messageQuery`, `messageAction`, `appointmentQuery`, `appointmentAction`, and `feedbackAction`.
- Permanent regression: `scripts/verify-disabled-account-revocation.js`, `package.json`, and compatibility updates to the existing project, Feedback, auth-market, rollback-floor, product-school, and product-view verifiers.
- Controlled rollout: `scripts/disabled-account-rollout-core.js`, `scripts/manage-disabled-account-staging-actor.js`, `scripts/deploy-disabled-account-hotfix.js`, `scripts/verify-disabled-account-staging-runtime.js`, `scripts/capture-disabled-account-production-integrity.js`, and private-output support in the existing production historical read-only runtime verifier.
- Evidence: this report. Private manifests, rollback packages, actor records, and runtime reports remain Git-ignored under `tmp/`.

No package/lock dependency was changed. `createProduct` and `schoolQuery` were verified but not rewritten or deployed. `README.md` was not modified.

## 6. Active Gate Semantics

For every action marked **Active user required**, the server-side order is:

1. obtain fresh `OPENID` and `APPID` from `cloud.getWXContext()`;
2. derive the existing deterministic user document identifier;
3. read the authoritative `users` record;
4. fail closed if the record is missing;
5. fail closed if stored `openid` does not exactly match the fresh `OPENID`;
6. fail closed unless `status === 'active'`;
7. only then perform maintenance-state checks, ownership/participant/school/relation checks, protected reads, or mutation.

The implementation decision is a minimal local helper in each affected independently deployed function. This avoids a new cross-package runtime dependency and keeps deployment and rollback blast radius explicit.

## 7. Local Tests

The permanent verifier uses a mocked trusted WeChat context plus authoritative `users` documents; it never trusts a client-supplied status. Final results:

- 11 protected cloud functions and 46 protected actions covered;
- disabled, pending, invalid-status, missing-user, and identity-binding mismatch cases fail closed before protected work;
- active-user positive controls retain existing business behavior;
- all six existing-account `authUser` actions reject non-active records, while missing-user onboarding remains reachable;
- public product detail, school list/search/detail, first-account bootstrap, and safe disabled-state detection remain available under their approved semantics;
- disabled responses are restricted to the safe envelope and do not expose `OPENID`, raw records, database errors, or stacks;
- rollout tooling regression covers environment roles, target confirmation, exact function-set comparison, function allowlists, private paths, and status-only compare-and-set mutation.

The main `npm run verify` gate now runs both the 81-check project verifier and this permanent revocation verifier. Feedback regression completed 39 checks without SMTP delivery.

## 8. Staging Real Disabled Test

PASS at `2026-09-01T12:30:08.094Z` against masked staging `jichu-***022f`:

- one pre-existing, explicitly fingerprinted staging actor was used;
- the only data mutation was the actor's authoritative `status: active → disabled → active` using an exact `_id + openid + expected status` compare-and-set;
- direct `wx.cloud.callFunction` calls bypassed the client UI;
- 42 disabled-account business/auth calls were denied by the server;
- 6 active read/smoke checks passed before the transition and the same 6 passed after restoration;
- 4 public/onboarding controls passed;
- all 9 collection snapshots were exactly equal before and after;
- Feedback mail attempts were 0 and production writes were 0.

All 11 staging packages were independently downloaded and verified. Staging initially lacked `manageProduct` and `productViewAction`; the controlled tool created only those two with their approved runtime/handler/resource configuration. The other nine functions retained exact rollback packages.

## 9. Staging Restore

PASS. The actor manifest is `restored-and-verified`: original status `active`, restored full-record SHA-256 exactly equals the PRE full-record SHA-256, the non-status projection is unchanged, and `leftoverStatusMutationCount=0`. The older Step 4B-1 actor fixture also audited with leftover 0. No staging user, school, product, conversation, message, appointment, favorite, view, or Feedback record was deleted.

## 10. Production Deployment Manifest

Production PRE identified exactly the 11 approved source changes; `createProduct` and `schoolQuery` matched both the Git base and local tree and were excluded. A tooling defect initially compared the same function set in order-sensitive array order and stopped before any production write. It was corrected to exact, order-independent membership and covered by the permanent verifier; live re-audit then passed.

| Function | Old source SHA-256 | New source SHA-256 | Result |
|---|---|---|---|
| `authUser` | `4e21bc0dc7a3…` | `0e04cd70c4a8…` | deployed + verified |
| `productQuery` | `27c4495a91c0…` | `1114c547be19…` | deployed + verified |
| `userQuery` | `65b120ccecb9…` | `69ca063e920e…` | deployed + verified |
| `messageQuery` | `c4472a128fac…` | `a5bebcdb2897…` | deployed + verified |
| `appointmentQuery` | `1747a0333a75…` | `9a0239cdd7ce…` | deployed + verified |
| `manageProduct` | `163a5bfd627d…` | `1c24e63e488f…` | deployed + verified |
| `favoriteProduct` | `0214cf9d702a…` | `c5bc6ead80fe…` | deployed + verified |
| `productViewAction` | `88b605183190…` | `ebc36c5ec6f4…` | deployed + verified |
| `messageAction` | `301999900a3f…` | `d1942437a591…` | deployed + verified |
| `appointmentAction` | `13e9fcc3d225…` | `b2e5b0c7e4c5…` | deployed + verified |
| `feedbackAction` | `2f34e04a346b…` | `e06fb4484c1a…` | deployed + verified |

For every entry, the manifest contains full old/new file hashes, the exact old package, configuration fingerprints, deployment reason, and rollback location. Dependency drift and configuration drift are both false.

## 11. Production Rollout

PASS. After local, staging, restore, fixture-leftover, source-diff, secret-scan, PRE snapshot, and rollback gates passed, the 11 functions were deployed sequentially in the manifest order. Each function was immediately re-read, its complete package downloaded, its source/files checked, and its configuration fingerprint compared. A later independent 11-function verification repeated the remote package and configuration checks; all entries are `deployed-and-verified` at `2026-09-01T12:53:15.609Z`.

No production user was created, disabled, restored, or otherwise mutated. Production validation used deployed source equivalence, local deterministic disabled tests, staging real-disabled tests, and production active-user read-only/zero-write checks.

## 12. Regression

Production active-user read-only runtime PASS:

The historical positive-path result is persisted privately at `tmp/disabled-account-production-historical-readonly-runtime.json`; the favorite result is persisted at `tmp/disabled-account-production-active-readonly-runtime.json`.

- `authUser.current`, historical conversation list, message history, appointment list, and authoritative public profile succeeded;
- public-profile forged school input was ignored and internal identity/school fields remained absent;
- favorite page 1/2, stable order, total/hasMore, status filtering, invalid pagination fallback, safe DTO, forged identity isolation, invalid action rejection, and client direct-database denial passed (13 checks);
- business writes, console errors, and exceptions were all 0.

The existing production security suite passed 18/18 probes. Forged identity, malformed IDs, and unknown actions were rejected across authentication, product, favorite, message, appointment, view, school, and user functions. Before/after counts and projected digests for its eight established collections were equal; no database write API, transaction, migration, fixture, or deletion ran.

Final local regression PASS includes:

- project 81; disabled revocation 11 functions / 46 actions; Feedback 39;
- Phase 18 core/auth-market/school-change/logout: 91 / 16 / 79 / 28;
- Phase 19/20/21/22/23: 50 / 78 / 64 / 42 / 133; Phase 22A 6 groups and 22B 19;
- Phase 24/auth/login/pair: 89 / 71 / 35 / 52;
- Phase 25 lifecycle/race/diagnostics/rollback: 67 / 899 / 69 / 37;
- schools 5 groups, school selection 128, product-school binding 51, product views PASS;
- Final Release Step 3B 26, Step 3C-1 12+8, and Step 3C-2 UX PASS.

## 13. Data Integrity

Production PRE (`2026-09-01T12:38:28.536Z`) and POST (`2026-09-01T12:59:06.742Z`) count/full-record digest snapshots match exactly:

| Collection | PRE count | POST count | Digest |
|---|---:|---:|---|
| `users` | 8 | 8 | exact |
| `products` | 72 | 72 | exact |
| `favorites` | 7 | 7 | exact |
| `conversations` | 26 | 26 | exact |
| `messages` | 209 | 209 | exact |
| `appointments` | 25 | 25 | exact |
| `schools` | 2952 | 2952 | exact |
| `productViews` | 28 | 28 | exact |
| `feedbacks` | 1 | 1 | exact |

`PUBLIC MARKET ZERO` remains true: 57 offline, 12 sold, 3 deleted, 0 available, 0 reserved. Schools remain 2952 active, 0 pending, 0 missing/extra/different, and 0 identity/status/duplicate conflict. Function configuration is unchanged and only the 11 approved source hashes changed.

## 14. Performance Observation

Each active-required invocation now performs one fresh deterministic `users` document lookup before protected work. No cross-request or client status cache was introduced because immediate revocation takes priority. Staging direct-call and production active read-only suites completed without timeout or functional error. This hotfix did not run a load benchmark and makes no latency-improvement claim; the bounded indexed read is accepted as the necessary security cost.

## 15. Rollback Readiness

PASS. Production preparation downloaded and hash-verified the complete old package for all 11 functions before the first write. Rollback tooling requires the exact manifest, target confirmation, emergency flag, owner authorization phrase, frozen rollback hashes, and unchanged configuration. It restores one function at a time and re-verifies the remote package.

Staging rollback has nine old packages plus an explicit delete-created-function strategy only for the two staging-only functions that were absent before the test. No rollback was executed because rollout verification, active-user runtime, security probes, and data integrity all passed. Any rollback would remove the revocation fix and therefore remains an owner-authorized emergency action, not an automatic cleanup.

## 16. Remaining Security Debt

The small `requireActiveUser` pattern is intentionally duplicated across independently packaged functions. Broader helper consolidation, `messageAction`/chat file size, Node 16 migration, dependency debt, storage capability-URL risk, DTO/maintenance duplication, and performance refactoring remain post-release work. None was expanded into this security patch. A fresh Post-Final-Release public-repository/privacy/maintainability/security audit is still required before any README or WeChat-review readiness decision.

## 17. Final Decision

**PASS — DISABLED ACCOUNT REVOCATION HOTFIX COMPLETE.** Local authoritative-status tests, real staging disabled identity, exact staging restoration, controlled production deployment, independent remote-package verification, active-user regression, 18/18 production zero-write probes, nine-collection PRE/POST integrity, secret scan, and rollback readiness all passed.

The Git commit containing this report is the seal for the implementation; its immutable SHA cannot be embedded in its own contents. The task's final output records the pushed commit and confirms `main == origin/main`, ahead/behind `0/0`, and a clean working tree. No tag is created.
