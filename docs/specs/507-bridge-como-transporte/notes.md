# 507 — bridge-como-transporte — notes

_Created 2026-08-14._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **Fatia 3 (`t-15dbb9`):** `stateMigration` did not need the four imported symbols. The caller
  registry entry is a structural persisted shape and is now declared locally; the three location
  functions collapse into two transport-owned operations, `tokenFileNames` and
  `clientGenerationStateKey`. The migration provider now carries that storage shape beside its lazy
  `provide` operation, so the supervisor contract gains one composition member rather than a second
  independently optional setting.
- Persistence compatibility is executable in both applicable directions without changing the
  format: the collection fixture writes the pre-inversion filenames and generation key as frozen
  literals, while the apply fixture reads the newly installed state through the current transport
  functions. Deliberately prefixing the composed bridge-token filename made the focused test fail in
  both directions (old token not collected; new token not found), and restoring it passed. No
  behavioral assertion changed.
- Slice measurement: **27 bindings · 10 imports · 2 consumers → 23 bindings · 7 imports · 1
  consumer**. `stateMigration.ts` has zero imports from `bridge/`; all persisted filenames, keys and
  envelope fields remain byte-for-byte unchanged.

- **Fatia 2 (`t-f37763`):** `extensionOperationService` used only three members of `BridgeDeps`:
  `manager`, `attentionOf`, and `waiters`, solely to call `executeWait`. That use case already declares
  the exact structural shape it consumes, so the service now passes its local object directly instead
  of borrowing the adapter's dependency bag. No new port member was needed for this edge.
- The service's context gained exactly **one** member, `approvalResolutionChannel`, because the operation
  use case needs the channel value but must not choose which transport door received the operation. The
  engine-control adapter owns `APPROVAL_CHANNEL_VSCODE_COMMAND`, proves it with
  `satisfies ApprovalResolutionChannel`, and supplies it during composition. The Bridge channel module
  re-exports that adapter-owned value for its exhaustive channel list and existing consumers.
- Slice measurement: **29 bindings · 12 imports · 3 consumers → 27 bindings · 10 imports · 2 consumers**.
  No behavioral assertion changed; the only test edit supplies the new composition value.
- Review correction: the use case keeps the injected value named `approvalResolutionChannel`; it does
  not alias it to the adapter-specific constant name. The static channel guard accepts that identifier
  only in this typed composition seam, while its real-file red injection still proves a literal actor is
  rejected at the door.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
