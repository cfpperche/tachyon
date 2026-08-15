# 507 — bridge-como-transporte — notes

_Created 2026-08-14._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **Fatia 5 (`t-de69d6`):** `Workspace` now declares an eleven-member `WorkspaceBridgePort` and
  receives its implementation. Five members are the already-extracted authentication/rebind
  mechanism from slice 4; six replace the final six imports (`createServer`, `derivePort`, approval
  channel, notice preparation/composition, and token healing). Together with the three members from
  slices 1–3, the SDD exposes **14 members total**, below the written ~15 ceiling. The pre-existing
  large MCP adapter dependency bag is passed through the single `createServer` composition member;
  it was not copied into or counted as a new port.
- Production composition moved to `bridge/daemonMain.ts`: it chooses `workspaceBridgePort`, then
  passes it through the transport-neutral daemon runner/service into `Workspace`. Headless tests use
  the sibling `createWorkspaceForTest` composition helper. Thus create, daemon restart, and test
  creation all enter through an explicit composition root; resume/rebind remains inside the supplied
  transport mechanism and does not create another server.
- Slice measurement: **6 bindings · 4 imports · 1 consumer → 0 bindings · 0 imports · 0
  consumers**. The focused auth handshake/rebind proof, daemon-entry proof, and 108-test headless
  Workspace suite passed without changing a behavior assertion.

- **Fatia 4 (`t-d5392e`):** connection credentials and caller-registry custody now live in
  `WorkspaceBridgeTransport`; `Workspace` composes that transport through `Bridge` and receives only
  values/snapshots at its entry points. Rebind construction, settings parsing, wired-record
  classification, and the reload-initiator key are likewise transport operations exposed through the
  existing `Bridge` binding. The contract gained five static composition members on `Bridge`, keeping
  the SDD total at eight rather than leaking the seventeen mechanism symbols back into the engine.
- The authentication proof freezes the pre-inversion token filenames, token bytes, caller-instance
  state key/value, and HMAC secret key/value as literals. It then performs a real MCP handshake with a
  minted agent bearer, observes the immutable resolved caller snapshot, and drives an `auto` rebind
  through stop, resume, and generation stamp. No behavior assertion changed.
- Slice measurement: **23 bindings · 7 imports · 1 consumer → 6 bindings · 4 imports · 1 consumer**.
  The six remaining edges are exactly the reserved slice-5 set (`Bridge`, `notifyAgent`,
  `agentTokenHeal`, and the approval channel).

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
