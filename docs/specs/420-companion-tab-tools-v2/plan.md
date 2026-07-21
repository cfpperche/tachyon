# 420 — companion-tab-tools-v2 — plan

_Draft with design (`t-a5154a`). Refine after ratify._

## Approach

1. **Contract first** — freeze tabId, @e, envelope, safety in `spec.md` (this design).
2. **Wire shape** — extend `CompanionTabCommand` / `CompanionTabResult` in ADE `src/companion/protocol.ts`
   and mirror in `tachyon-companion` packages/protocol; bump `protocolVersion` when incompatible.
3. **Channel** — `CompanionTabChannel` carries `tabId` on every request; extension routes to
   `chrome.tabs` by id (not `active: true` only).
4. **Bridge tools** — `src/bridge/tools.ts` `user_browser_*`: require `tabId`, accept `ref` and/or
   `selector`; always JSON-envelope results.
5. **Snapshot refs** — content script builds outline + side table `ref → selector/xpath/unique path`;
   engine may pass only `ref` and extension resolves.
6. **Safety** — central gate before enqueue act: domain allowlist → secret strip on reads → confirm
   classifier for sensitive mutations → append mutation log after result.
7. **P0 tools** then dogfood fixture multi-tab; then P1 tools per board order.

## Key decisions (see spec — probe-adjusted)

- Opaque companion tabId on wire; Chrome id internal  
- Document token validation before mutate  
- @e scoped to document generation; no silent CSS fallthrough  
- Envelope with unknown_outcome + retrySafe  
- Layered confirm (not heuristic-only)  
- Redacted rotating mutations.jsonl (gitignored)  
- New SDD 420; 414 stays shipped  

## Files likely touched (implementation, not this design commit)

| Area | Paths |
|---|---|
| Protocol | `src/companion/protocol.ts`, companion monorepo `packages/protocol` |
| Channel | `src/companion/CompanionTabChannel.ts`, tab handle registry in extension |
| Tools | `src/bridge/tools.ts`, Workspace wiring |
| Settings | `settings.companion.allowedHosts` (schema + YamlConfigEditor) |
| Extension | tab router by handle, content script refs, confirm UX |
| Audit | mutation log writer + redaction + rotation |
| Config/tests | unit tests channel + tools; dogfood fixture under `test/fixtures/` |
| Evidence | `.tachyon/companion/mutations.jsonl`, screenshots path (existing) |

## Risks

| Risk | Mitigation |
|---|---|
| Chrome tab ids recycle / navigate | Opaque handle + document token; fail stale_tab |
| Ref stale after DOM morph | Scope @e to document generation; reject stale_ref |
| Confirm false negatives/positives | Layered policy; fail closed on ambiguous consequential |
| Unsafe retry after timeout | unknown_outcome + retrySafe=false default |
| Log leaks secrets / git pollution | Redaction schema + gitignore + rotation |
| Protocol skew ADE ↔ extension | protocolVersion fail-closed; mixed-version tests |
| Network tool privacy | Default off or redact heavy; no cookie/auth headers |

## Delivery slices

Match board `t-ca13aa` order #2–#17 after design lands. Do not start P1 before `t-4ffb40`.

## Verification / dogfood

- Unit: protocol encode/decode, gate, envelope helpers  
- Integration: tab channel with mock extension  
- Human dogfood: multi-tab race (`t-4ffb40`)  
- **Verify / Dogfood** lines land in `tasks.md` when foundation lands  
