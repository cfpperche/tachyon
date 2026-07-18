# Tasks — 408 Pi OAuth coordination

## Interim Tachyon safety

- [x] Serialize Pi admission across different agent names at the final tmux creation boundary.
- [x] Refuse a second live Pi process and release the slot after confirmed session removal/death.
- [x] Apply the guard to Spawn, Resume, Restart, and Fork while preserving same-name restart.
- [x] Add concurrent admission, release, same-name lifecycle, and live-Fork refusal coverage.
- [x] Document the temporary one-live-Pi limitation and OAuth gap.

## Upstream Pi

- [x] Add the official `PI_CODING_AGENT_AUTH_FILE` path contract and documentation.
- [x] Thread explicit `authPath` through CLI runtime, SDK, service, package-command, migration, and default storage paths.
- [x] Add compatibility, precedence, multi-home shared-path, and one-refresh concurrency tests.
- [x] Run upstream focused tests, lint/typecheck, and export a reviewable commit/patch.
- [x] Obtain explicit human authorization before pushing the upstream branch.
- [ ] Human opens the required upstream issue in their own voice and obtains maintainer `lgtm` contribution approval.
- [ ] Reopen/resubmit the upstream PR only after `lgtm`.
- [ ] Obtain/identify a published Pi version containing the hook.

## Tachyon

- [ ] Reserve and inject the official auth-file environment key for Pi harnesses.
- [ ] Validate the canonical source no-follow and stop seeding active private auth copies.
- [ ] Gate managed launch on a Pi version that supports the hook.
- [ ] Add harness, config, lifecycle, sibling-isolation, malformed-source, and missing-source tests.
- [ ] Update `docs/runtimes/pi.md` and parity documentation.
- [ ] Add and run real concurrent Pi OAuth dogfood with secret-redacted evidence.

## Closure

- [ ] Run focused suites and `npm run typecheck` in both repositories.
- [ ] Run Tachyon `npm run verify:full:quiet`; classify unrelated baseline failures.
- [ ] Review security, crash, compatibility, and no-secret behavior.
- [ ] Obtain explicit authorization before integration, push, or release actions.
- [ ] Mark SDD/task shipped with exact commit and dogfood evidence.
