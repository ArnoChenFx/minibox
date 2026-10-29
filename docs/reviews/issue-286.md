# Issue #286: implementation and follow-up decisions

Scope: the combined reviews of `3b9c71b..dc4f3b2` (#285/#286). This records concrete changes and the disposition of candidates; a scan warning is not a deletion instruction.

## Implemented

- Storage administrator identity is derived on authentication from the stored, unmodified admin policy. Narrowed/custom tokens, even with volume scopes, cannot independently create/delete volumes or select pools. Default Box provisioning remains internal. Admin storage still checks resource/host grants; other owner-only functions remain owner-only. Existing token records are covered without rewriting credentials.
- Template edits re-read under the name lock and reject changed snapshots. Recipe/image consistency and creator changes are compared, preventing stale writes. Visibility is checked before recipe resolution for token callers. Relabelled historical images are removed when possible, and unnamed images retained for running boxes do not become duplicate template cards.
- Full template forms explicitly clear fields; partial CLI patches still merge. Unchanged argv stays unchanged, and shell rendering quotes each argument, including empty strings and metacharacters.
- Backup record/size I/O failures are isolated and logged. Maintenance cannot roll back a completed archive or prevent startup. Realpath checks cover existing ancestors. Existing custom backup folders retain their permissions with a shared-folder warning; new directories and archive files stay private.
- Onboarding controls shrink within a narrow field, and action buttons wrap instead of forcing min-content overflow. Existing page-width/control browser assertions are retained.
- Task SSE uses a monotonic sequence watermark instead of retaining every sent sequence. Existing replay/reset/cancel tests protect its stream behavior.
- Volume usage drops levels for deleted records. Docker cold-cache inspection uses at most 12 workers while preserving order, cache logic and cancellation.
- The pure desired-tools parser moved into `src/tools/desired.ts`; Box creation no longer imports the tools service through the boxes service cycle.
- Closed Agent executors refuse fresh stream requests; close/ID comments now match map clearing. Existing cancel/exec-process behavior remains unchanged.
- Removed template-fork/onboarding source-spelling assertions backed by browser flows. Kept language-key checks. TAR escape tests consume production `parseTar`; removed the test-only `firstFileData` wrapper.
- Empty system-version responses can retry. Developer documentation names the openssl dependency. Token/API/storage/upgrade documents and translations explain the policy change.

## Candidates retained or deferred with reasons

| Review candidate | Decision |
| --- | --- |
| Copy raw file paths (L6) | Retain the raw path contract: it is also used for editor/file-manager paste. It is not an automatically executed command. A separate “copy shell-quoted path” feature needs an explicit UI choice; quoting every copied path would break current consumers. |
| Agent Runtime Feed queue / byte streams (L8) | Do not silently drop frames or change the wire protocol. End-to-end flow control requires a slow-consumer load test and decisions about cancel/error propagation and reconnect. The bounded task SSE change is independent; Feed remains an explicit follow-up, not claimed fixed. |
| Custom BACKUP_DIR mode (L10) | Preserve existing custom directory modes, warn for shared directories, keep new files 600. Existing DATA_DIR private-directory enforcement stays unchanged. |
| CI/QEMU cost and Action versions (L12) | Keep the multiarch build/embed and actual arm64 image checks. Cache-only build and architecture-specific load serve different purposes. No measured regression or missing Action version was established; do not remove architecture coverage to save hypothetical time. |
| localhost HTTP warning (L14) | Retain: the pairing command is copied to an agent host, and the console's localhost origin does not establish that its eventual transport is protected. |
| knip counts / exports | No bulk deletion. parseFrame in src/agent has production client/hub callers; test support functions are already test helpers. HTML/worker/subprocess/CLI/agent entry points must be configured before a future whole-repository unused-export baseline. |
| CSS patch-layer merge | Retain cascade order. Merge only with a focused computed-style regression matrix; selector repetition alone is not evidence that a rule is redundant. The confirmed onboarding layout is fixed locally. |
| Large files | Retain current module boundaries except the confirmed tools dependency cycle. File size alone does not justify unrelated refactors in this fix. |
| Embedded Rust relay | Retain checked-in embed and drift validation. Source size is not the same as incremental compressed Git object growth; changing generation timing would affect offline deployment and source builds without a demonstrated benefit. |
| Partial Chinese docs | Retain existing translation scope. Add the new policy to paired user docs rather than translating every missing historical page as part of a bug fix. |
| Bounded-key maps | Keep host/pool-keyed state without arbitrary eviction; losing those entries can duplicate alerts or weaken synchronization. Deleted-volume level state is the unbounded historical-key case addressed here. |

## Compatibility

Storage policy is an intentional authorization change, effective on reload for existing records. REST/MCP/CLI share the executor check. A request missing its ordinary scope may still be refused by the outer route gate before the administrator-identity gate; both are 403 and neither creates/deletes resources. Raw filesystem paths, Agent wire messages, backup format and unrelated owner-only operations are unchanged.

The follow-up candidates above are deliberately not described as proven security vulnerabilities or as completed flow-control/CI/translation work. Regression results and real-Docker coverage are recorded in the PR.
