# 404 — pi-reviewer-safety — notes

## Measurements and decisions

- Pi v0.80.10 parses tool filters only as separate operands (`--exclude-tools <csv>` / `-xt <csv>`); equals forms are not accepted and reviewer preparation rejects them rather than preserving a command Pi would misparse.
- Real Pi active-tool measurement corrected the initial assumption that grep/find/ls are default tools. With `--exclude-tools bash,edit,write`, Pi's active built-ins are exactly `read`; a registered extension sentinel remains active. SDD 404 claims read + extension/Bridge availability, not nonexistent native search tools.
- A denylist is required because `--tools read,…` is an allowlist over built-in and extension tools and would suppress the dynamically projected Tachyon Bridge catalog.
- The canonical set is normalized for comparison, so explicit `write,bash,edit` is safe and preserved byte-for-byte. Partial, duplicate, extra and unsupported tool-control forms fail before Delivery preparation.
- Reviewer adaptation remains tied to authoritative `deliveryJoin.role === reviewer`. Ordinary Pi commands receive no restriction.
- Scope is shell-level: removing Pi's bash/edit/write built-ins does not create an OS sandbox and does not override independent Bridge authorization policies.

## Automated evidence

- Focused reviewer/runtime/Pi suite: 406 tests passed.
- Real Pi RPC startup published active tools through an extension: catalog was exactly `read,bridge_probe`; `bash`, `edit`, and `write` were absent.
- Build passed; engine boundary passed with 250 vscode-free daemon files; product invariants passed.
- Full suite: 4,889 passed, 3 skipped, with only the inherited baseline failures from SDD 399–403:
  - generated `grokauthfixBehavior` invokes the pre-existing failing typecheck (`verifyFullLock.test.ts` declaration gap);
  - `verifyFullQuiet.test.ts` expects the pre-`t-6a9bc4` `verify:full` package script.
- Direct typecheck reports only the inherited `verifyFullLock.test.ts` declaration defect.

## Human Dev Host evidence

- Target: worktree build `d8d8c18e`, isolated SDD 404 fixture, 2026-07-18.
- Control `pi-full-demo` (`cmd: pi`) exposed bash/edit/write and created the requested probe, proving ordinary Pi remains unrestricted; the probe was then removed.
- `pi-reviewer-demo` ledger recorded `cmd: pi --exclude-tools bash,edit,write`, exact Pi session `08d2fc36-5052-4126-bcac-fe4d2aa835d0`, private home and wired Bridge generation 28.
- Durable Activity recorded one successful native `read` of README and no bash/edit/write tool calls. The agent reported all three mutators unavailable, `FILE_CREATED: NO`, `VERDICT: PASS`; independent filesystem inspection confirmed the probe absent.
- This combines human runtime-posture proof with unit coverage of automatic authoritative Delivery reviewer injection; the fixture itself used the exact resulting command rather than manufacturing a canonical Delivery lifecycle.

## Review notes

- The Bridge guard now permits only `none` or the exact canonical reviewer posture. Every other Pi tool filter remains fail-closed.
- Pi permission profile v3 records `full` and `reviewer-read-only`, but no general permission-mode UI is implied.
- Future Pi built-in tool additions require remeasurement: a new mutating built-in would not automatically enter this denylist.

## Verification log

### 2026-07-18T17:25:12Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/agentManager.test.ts test/unit/runtimeProfile.test.ts test/unit/piRuntimeOnboarding.test.ts test/unit/piSession.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants` — pass

## Dogfood log

### 2026-07-18T17:25:20Z — pass (1/1) — source: tasks.md — commit: 59c6325bd429f48869e4c0a4cbfa42ccb5d458dc
- `node scripts/dogfood/pi-reviewer-safety.mjs` — pass
