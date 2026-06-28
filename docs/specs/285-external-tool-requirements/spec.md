# 285 — external-tool-requirements

_Created 2026-06-28._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** shipped 2026-06-28 — external-tool requirements + consent-gated assisted install land end-to-end. A plugin
declares `externalTools` (a system binary it needs but Tachyon does NOT provision); the engine DETECTS each
spoof-resistantly (clean-PATH realpath + `isTrustedExecPath`, the detect probe runs the RESOLVED trusted binary, never
a manifest path), surfaces present/missing at install, records the consented requirement in the lockfile, materializes
the `_tachyon-external` resolver shim, and resolves a trusted path via `.tachyon/bin/_tachyon-external <plugin>
<name>`. The ASSISTED INSTALL runs a per-package-manager argv NORMALIZED to trusted clean-PATH realpaths (`sudo` + the
PM) in a VISIBLE terminal (`createTerminal` shellPath/shellArgs — argv-direct, no shell) where the OS's own sudo
prompts; Tachyon never sees the password; looser non-pinned trust tier; never auto-uninstalls. Lanes A (manifest +
parse; detection + argv guardrails), B (lockfile req; resolver + shim/bundle; buildAssistedInstall), C (engine record +
shim; ConsentExternalTool; PluginsPanel assisted-install action + drawer). The implementation codex dueto
(NEEDS-REVISION) folded in full: 2 BLOCKERs (detect ran a manifest path before consent → runs the resolved abs;
validateInstallArgv basename-only → bare-exact + run-time normalization to trusted realpaths), 2 HIGH (bundle gate +
clone-rehydrate the shim; busy-guard + in-flight serialization on the privileged action), 1 MEDIUM (shell-quoted
display). ~30 unit tests incl. regressions. Verified: full suite 1801 green, typecheck + build clean. With spec 284,
a transcription plugin (whisper-cli external + ffmpeg external + a `ggml` model data-artifact) is now buildable.

## Intent

A plugin's skill often needs an **external system tool it does not provision** — a heavy, native, or package-managed
binary like `whisper-cli` or `ffmpeg`. This is a third kind of dependency, distinct from both existing ones:

- **spec 265 provisioned tools** — a single binary Tachyon FETCHES, pinned by `{url, sha256}`, content-addressed,
  launcher-exec'd. Only fits tools with clean per-platform release binaries (e.g. osv-scanner). Whisper.cpp has none —
  its clean cross-platform distribution is a package-manager wheel / a system install, not a pinned binary.
- **spec 276 plugin dependencies** — plugin→plugin (the manifest's `dependencies`; `ConsentVM.requires?:
  DependencyState[]`). Not plugin→system-binary.

Today the engine has **no surface** for "this plugin needs binary X on your machine." The consequence is a band-aid:
the skill discovers the gap only at RUN time and hand-rolls a hint — late, per-plugin, inconsistent — and there is no
consent-gated way to actually install the missing dependency.

This spec adds a first-class **external-tool requirement** (manifest key `externalTools` — deliberately NOT `requires`,
which collides with the spec-276 consent shape). A plugin declares each required external binary with how to **detect**
it and a per-package-manager **install argv** (structured argv, never a shell string). The engine then:

1. surfaces present/missing in the **install consent preview** (before any change) and in **doctor/status**;
2. offers a consent-gated **assisted install** that runs the declared argv in a **visible terminal via a Tachyon-owned
   PTY runner** (spawns argv directly with the TTY attached — never `sh -c`), where the operating system's OWN
   authentication (`sudo`/polkit) prompts for the password. **Tachyon never captures, stores, forwards, or prompts for
   the credential**; it observes only the process lifecycle/exit;
3. gives the skill a uniform, spoof-resistant resolver (`_tachyon-external <plugin> <name> --json` → trusted absolute
   path + status, or fail-closed `unavailable`).

"Done": the preview lists missing externals with the exact (shell-quoted-for-display) argv; the user can approve an
assisted install that authenticates through the OS and ends with the tool detected at a TRUSTED absolute path; doctor
reports present/missing; the skill resolves fail-closed; an unknown platform degrades to declared manual guidance
without crashing.

**Trust posture (stated honestly, by design).** An assisted install runs the user's system package manager (often as
root, running the package's own postinstall scripts). It is a **looser trust tier than a provisioned tool**: NOT pinned,
NOT checksummed, NOT content-addressed. The dedicated consent ack says exactly that and shows the exact argv. The
integrity guarantee is "the OS package manager + the named package," not a sha256. Mechanical guardrails (below) bound
the SHAPE of what can run, but we do not pretend to audit the package itself.

## Design decisions (folded from the 2026-06-28 codex dueto — NEEDS-REVISION → all folded)

- **D1 — manifest key `externalTools`, not `requires`** (BLOCKER: `requires` collides with spec-276 `ConsentVM.requires`
  and the manifest's `dependencies`). Lockfile: `externalTools?: ExternalToolLock[]`; consent:
  `externalTools?: ExternalToolState[]`.
- **D2 — install is structured argv, executed argv-based, never a shell string** (BLOCKER). Declaration:
  `install: { <pm>: { argv: ["sudo","apt-get","install","-y","ffmpeg"] } }`. A Tachyon-owned PTY runner spawns the argv
  directly with the TTY attached (no `sh -c`); the consent fingerprint binds the **exact argv**; the preview renders it
  shell-quoted **for display only**.
- **D3 — mechanical command guardrails** (HIGH; the consent "you saw it" is necessary, not sufficient): reject control
  chars; cap argv length/count; the install argv may contain at most a leading `sudo` then the package-manager
  executable; that executable's family MUST match the declared `<pm>` key; resolve the PM executable to a trusted
  absolute realpath (clean PATH, not workspace/cwd). No shell metacharacters are interpreted (argv exec guarantees it).
- **D4 — spoof-resistant detection** (HIGH; PATH-default is spoofable): resolve the binary to an absolute realpath under
  a CLEAN PATH; reject cwd/workspace-local hits unless explicitly allowed; apply the host-path ancestry/ownership/
  writability trust check (the `toolLauncher.ts` pattern); run any `detect` argv via `execFile` (no shell) with a
  timeout + output cap.
- **D5 — the skill resolver `_tachyon-external <plugin> <name> --json`** (HIGH): returns the trusted absolute path +
  status; NOT a launcher/refcounted provisioner, but a cwd-independent, spoof-resistant resolve-or-fail-closed.
- **D6 — install lifecycle states + serialization** (MEDIUM): `started | exited | canceled | timed-out |
  detected-present | still-missing`; a cancel action; re-detect after ANY exit; exit-nonzero-but-now-detected →
  satisfied-with-warning; serialize installs per `{pm, package}`; a hanging/interactive install is cancelable.
- **D7 — the lock records the consented external requirement** (MEDIUM) as its OWN entry kind (not a provisioned tool;
  no pinning, no refcount, never uninstalled), so doctor/status are stable if the manifest later drifts.
- **D8 — per-tool `manual` guidance** (LOW): a required string/URL used when no assisted argv matches the detected
  platform; unknown platform shows actionable manual guidance, never just "missing".

## Acceptance criteria

- [ ] **Scenario: declare + detect at the install preview**
  - **Given** a manifest `externalTools: { whisper-cli: {...}, ffmpeg: {...} }`, each with `detect?` + `install: { <pm>: { argv } }` + `manual`
  - **When** the install is previewed
  - **Then** each tool shows present/missing via spoof-resistant detection (D4), and for the missing ones on the detected PM the exact argv (shell-quoted for display) — before any change
- [ ] **Scenario: assisted install authenticates through the OS, never Tachyon, via argv**
  - **Given** a missing tool with an install argv for the detected PM, and the user grants the dedicated assisted-install ack
  - **When** Tachyon runs it
  - **Then** the argv runs in a **visible terminal via the Tachyon PTY runner (spawned argv-directly, no shell)**; the password (if needed) is prompted by `sudo`/polkit and entered by the user into the OS prompt; **no Tachyon code path reads/stores/logs/forwards the password**; Tachyon records lifecycle/exit and re-detects
- [ ] **Scenario: mechanical guardrails reject a malformed/spoofed command**
  - **Given** an install argv with control chars, an over-long argv, or whose first non-`sudo` executable does not match the declared `<pm>` family (or resolves outside a trusted realpath)
  - **When** the install is previewed/attempted
  - **Then** it is rejected fail-closed with the reason — never executed
- [ ] **Scenario: honest trust labeling**
  - **Given** an assisted install is offered
  - **When** the consent is shown
  - **Then** the dedicated ack discloses: runs the system package manager (possibly as root), runs package postinstall scripts, is NOT pinned/checksummed, will NOT be auto-uninstalled, and shows the exact argv
- [ ] **Scenario: no auto-uninstall**
  - **Given** a plugin whose assisted install added a system package
  - **When** the plugin is removed
  - **Then** no system package is uninstalled (shared); the lock's external-requirement entry is dropped, the package stays
- [ ] **Scenario: lifecycle — hang / cancel / nonzero-but-present / concurrent**
  - **Given** an assisted install that hangs on a prompt, or is canceled, or exits nonzero after the tool is actually present, or a second install of the same `{pm, package}` is requested
  - **When** each occurs
  - **Then** respectively: it is cancelable; cancel → `canceled`; re-detect → satisfied-with-warning; the duplicate is serialized, not run twice
- [ ] **Scenario: unknown platform degrades**
  - **Given** no install argv for the detected platform/PM
  - **When** previewed
  - **Then** the requirement shows missing WITH the declared `manual` guidance, the assisted install is not offered, nothing crashes
- [ ] **Scenario: skill resolves fail-closed via the resolver**
  - **Given** a required tool absent (or present at an untrusted path)
  - **When** the skill calls `_tachyon-external <plugin> <name> --json`
  - **Then** it gets a fail-closed `unavailable` (naming the tool + how to get it), never a fabricated path/success
- [ ] external-tool requirements are distinct from provisioned tools (265) and plugin deps (276): no pinning, no launcher exec, no refcount, no marketplace resolution

## Non-goals

- **Capturing, storing, forwarding, or prompting for the sudo/root password inside Tachyon.** The OS owns auth
  (sudo/polkit in the visible terminal). Hard line.
- Executing the install through a shell (`sh -c`) or any string-interpolated command — argv only.
- Pinning / checksumming / content-addressing the installed system package — the looser tier by nature.
- Auto-uninstalling system packages on plugin removal.
- Provisioning the binary as a pinned artifact — that is spec 265.
- A universal package-manager abstraction — the author declares the exact per-PM argv; Tachyon detects the PM and runs
  the matching argv, nothing smarter.
- Auditing/sandboxing what the install argv (or the package's postinstall) actually does beyond the D3 shape guardrails.

## Open questions

_All resolved by the dueto into D1–D8 above; none deferred._ Residual implementation notes:

- The PTY runner's exact surface (a Tachyon tmux terminal vs the VS Code integrated terminal) is an implementation
  choice at plan time — the invariant is: visible, user-owned stdin, password never observed/logged, argv-spawned.

## Context / references

- spec 265 — provisioned tools (`src/plugins/toolProvisioning.ts` / `toolLauncher.ts`): the pinned-binary sibling +
  the host-path trust pattern (D4) + the consent/fingerprint pattern (D2 binds argv the way 265 binds the url/sha).
- spec 276 — plugin dependencies (`src/plugins/pluginDeps.ts`, `consentViewModel` `requires?: DependencyState[]`,
  manifest `dependencies`): the naming this spec must NOT collide with (D1).
- spec 284 — plugin-data-artifacts: the OTHER engine evolution the transcription migration surfaced (the model). Both
  284 and 285 land BEFORE the transcription plugin.
- The Tachyon terminal model (tmux-driven visible terminals) is the surface for the OS auth prompt.
- Motivating consumer (next spec): a transcription plugin — `whisper-cli` + `ffmpeg` (this spec) + a `ggml` model
  (spec 284).
