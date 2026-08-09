# 404 — pi-reviewer-safety

_Created 2026-07-18._

**Status:** shipped

**Closure:** Canonical read-only Pi Delivery reviewer posture shipped in `f9e4b5d0`; dogfood closure landed in `bf5077c0` after real tool-catalog and human reviewer/control validation.

**Verify:** `npx vitest run test/unit/agentManager.test.ts test/unit/runtimeProfile.test.ts test/unit/piRuntimeOnboarding.test.ts test/unit/piSession.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants`
**Dogfood:** `node scripts/dogfood/pi-reviewer-safety.mjs`

## Intent

Delivery reviewers are supposed to receive a runtime-native least-privilege command. Claude gets plan mode and Codex gets a read-only sandbox, but Pi currently receives only an advisory and starts with its mutating built-ins (`bash`, `edit`, `write`) enabled. Pi therefore cannot honestly serve as a read-only Delivery reviewer despite exposing native tool filtering.

Give Pi Delivery reviewers a measured shell-level read-only posture by injecting `--exclude-tools bash,edit,write`. Preserve Pi's native `read` tool and extension/Bridge tools, reject conflicting user filters before reservation/spawn, and narrow Pi's existing Bridge fail-closed guard so only this proven built-in exclusion is compatible. Ordinary non-reviewer Pi agents remain unchanged and fully capable.

## Acceptance criteria

- [x] **Scenario: Pi Delivery reviewer is automatically restricted**
  - **Given** a structurally literal Pi command for a Delivery segment whose role is reviewer
  - **When** Tachyon prepares the reviewer command
  - **Then** it injects `--exclude-tools bash,edit,write` immediately after the Pi runtime token and persists that effective command
- [x] **Scenario: safe explicit posture is preserved**
  - **Given** a Pi reviewer command already excluding exactly `bash`, `edit`, and `write`
  - **When** Tachyon prepares it
  - **Then** the command remains byte-for-byte unchanged
- [x] **Scenario: conflicting tool filters fail before side effects**
  - **Given** a Pi reviewer command with `--tools`, `--no-tools`, `--no-builtin-tools`, incomplete/duplicate exclusions, or an exclusion set that does not prove all three mutators disabled
  - **When** reviewer preparation runs
  - **Then** it refuses before Delivery reservation, credential mint, home materialization, or tmux mutation
- [x] **Scenario: Bridge remains available in read-only mode**
  - **Given** the canonical reviewer exclusion and the staged Pi Bridge extension
  - **When** Pi starts
  - **Then** Tachyon accepts the wiring, Pi keeps extension tools active, and the reviewer can call Delivery/notification tools
- [x] **Scenario: native mutators are absent while inspection remains**
  - **Given** real Pi with the reviewer exclusion
  - **When** its active tool catalog is inspected
  - **Then** `bash`, `edit`, and `write` are absent while native `read` and a probe extension tool remain
- [x] **Scenario: ordinary Pi agents are unchanged**
  - **Given** a Pi spawn that is not a Delivery reviewer
  - **When** it starts normally
  - **Then** Tachyon does not inject reviewer exclusions
- [x] Runtime profile and parity docs describe the scope as Delivery reviewer shell-level safety, not OS sandboxing or universal Bridge read-only enforcement.

## Non-goals

- OS/filesystem/network sandboxing or blocking every mutation reachable through an authorized Bridge tool.
- Applying reviewer safety solely because an agent is named `reviewer` or has a prose role; this contract is tied to the authoritative Delivery segment role.
- A general user-configurable Pi permission mode or approval-prompt adapter.
- Restricting ordinary Pi agents, changing project trust, or mutating Pi settings/keybindings.
- Fork, configurable harness resources, or OAuth coordination.

## Open questions

- None. Pi v0.80.10 documents `--exclude-tools` as a native denylist applying to built-in, extension and custom tools. The canonical denylist names only Pi's mutating built-ins, so it leaves dynamically projected Bridge tools enabled without requiring a brittle complete allowlist.
