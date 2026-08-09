# 269 — tool-launch-policy

_Created 2026-06-26._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** A launcher-enforced `tools.<name>.launchPolicy { env?, args?, denyArgs?, mode:"force" }` flows
manifest → consent (fingerprint-bound) → lockfile → launcher. The launcher (`toolLauncher.ts`) force-sets an
explicit env (policy wins over a hostile parent env), refuses a conflicting agent arg (`denyArgs` ∪ the forced
flag-names → `POLICY_CONFLICT`, fail closed), and prepends forced args. Built bottom-up across manifest.ts /
lockfile.ts (re-validated by the same parser, fail-closed) / toolPlan.ts / engine.ts (fingerprint) /
consentViewModel.ts + App.tsx / toolLauncher.ts. Two codex duetos folded: round 1 (5 SHOULD — forced-arg
neutralization, empty-env consistency, env canonicalization, loader/exec-hijack env denylist, denyArgs-alias
honesty), round 2 (DYLD_* prefix coverage + compact-flag doc) → final **SHIP**. OQ1 resolved honestly: the claim
is **"enforced via the launcher"**, NOT bypass-proof (file-mode hardening is infeasible + insufficient against a
same-user shell agent; true bypass-proofing = agent sandboxing, separate future research). Loader/exec-hijack env
(`LD_*`/`DYLD_*`/`PATH`/`NODE_OPTIONS`/…) is rejected at parse. Full gate green (1622 vitest + tsc×2 +
engine-boundary + esbuild). The agent-browser-specific write-gate fixture (scenario 7) lands with spec 268.

**Verify:** `env -u TMUX npx vitest run test/unit/pluginManifest.test.ts test/unit/pluginLockfile.test.ts test/unit/pluginToolPlan.test.ts test/unit/pluginToolLauncher.test.ts test/unit/pluginConsentViewModel.test.ts`

## Intent

Let a plugin declare a **launcher-enforced launch policy** for a provisioned tool — a set of env vars + args the
`_tachyon-tool` launcher **always** applies (and conflicting agent argv it **refuses**) — so a tool runs with its
mandated safety flags **regardless of how the agent invokes it**. This is the spec-265-family primitive that turns
a soft, skill-mandated safety flag into a mechanical one. Its first consumer is the `agent-browser` v2 form-driving
gate (spec 268): `AGENT_BROWSER_CONFIRM_ACTIONS` must be on for every write, not just when the agent remembers to
export it. But it is **general** — any provisioned tool that must always launch with certain flags (a scanner
forced into a safe mode, a CLI pinned to an allow-list) is the same shape.

Today the launcher resolves the lockfile-pinned tool, re-validates the content-addressed binary's hash through a
fd, then `spawnSync`s it with the agent's argv and **inherited env** (`toolLauncher.ts`) — the injection gap. This
spec closes it: a manifest-declared `launchPolicy` flows manifest → consent (fingerprinted) → lockfile → launcher,
and the launcher builds an **explicit** env (`process.env` + policy env) and **rejects** any agent arg that would
override a policy-controlled flag.

**Scope of the safety claim (ratified honesty — OQ1 resolved 2026-06-26):** "enforced **via the launcher**", NOT
"bypass-proof". A launch policy makes a flag impossible to omit or override *through the launcher* — the path an
agent uses by default. It does **not** stop a non-cooperating agent from running the tool's bytes outside the
launcher, and **no file-permission trick can**: the agent runs **same-user with a shell**, so it can always read
the binary (owner-readable), `cp`+`chmod +x`+exec a copy, or just install the upstream tool itself. (Making the
on-disk binary non-executable was considered and **dropped**: it is incompatible with the launcher's validated-fd
exec — `/proc/self/fd/N` execve still requires the file's execute bit — and Node exposes no `memfd`/`fexecve` to
work around it.) True bypass-proofing requires **sandboxing the agent** (so its only path is the launcher), a
separate containment layer, not this feature. So the claim is honestly scoped; the residual is documented, not
advertised away.

**Done** = a plugin can declare `tools.<name>.launchPolicy { env?, args?, denyArgs?, mode: "force" }`; install
surfaces it in the per-tool consent ("this tool will always launch with these enforced env vars / args"),
fingerprint-binds it, and records it in the lockfile; the launcher injects the env + args and **fails closed on a
conflicting agent arg**. The guarantee is "enforced for launcher invocations"; the same-user raw-exec residual is
documented as out of scope (it needs agent sandboxing, not file perms).

## Acceptance criteria

- [x] **Scenario: a plugin declares an enforced launch policy**
  - **Given** `tools.<name>.launchPolicy = { env: { FOO: "bar" }, args: ["--safe"], denyArgs: ["--confirm-actions",
    "--action-policy"], mode: "force" }`
  - **When** the manifest loads
  - **Then** it validates fail-closed: a small string→string `env` map, an argv vector, a `denyArgs` list, no
    control chars, capped sizes; unknown/malformed fields are rejected (a pre-269 Tachyon already rejects the
    unknown `launchPolicy` field — forward-safe).

- [x] **Scenario: consent surfaces the forced policy + the fingerprint binds it**
  - **Given** an install with a launch policy
  - **When** the consent drawer renders
  - **Then** it states, per tool, "always launches with enforced env: FOO=bar; args: --safe; refuses:
    --confirm-actions, --action-policy" — and the policy is part of the install fingerprint (a policy change →
    a new fingerprint → re-consent).

- [x] **Scenario: the lockfile records the consented policy (immutable, hot-path source)**
  - **Given** the install applied
  - **When** the lockfile is read
  - **Then** each `ToolLock` carries its `launchPolicy`; parse is fail-closed (corrupt policy → refuse, never a
    silent unpoliced launch). The launcher reads the **lockfile** policy (not the manifest) — matching the
    existing lockfile-only hot path.

- [x] **Scenario: the launcher injects env even when the parent env omits/contradicts it**
  - **Given** a tool with `launchPolicy.env = { AGENT_BROWSER_CONFIRM_ACTIONS: "…" }`
  - **When** the agent invokes the launcher with that env unset (or set to empty)
  - **Then** the launcher spawns with an **explicit** env where the policy values win — the flag is on regardless
    of the caller's env. (`spawnSync` currently passes no `env` → inherits; this spec makes it explicit.)

- [x] **Scenario: the launcher refuses a conflicting agent arg (fail closed, not last-wins)**
  - **Given** `denyArgs` includes `--confirm-actions`
  - **When** the agent passes `--confirm-actions ""` (or its own `--action-policy`)
  - **Then** the launcher **refuses to exec** with a clear error (auditable), rather than relying on the tool's
    flag-vs-env precedence. Policy `args` are applied in a position the agent cannot neutralize.

- [x] **Scenario: the safety claim is honestly scoped (OQ1 resolved — scope, don't overclaim)**
  - **Given** the content-addressed binary stays executable (`0500`) because the launcher's validated-fd exec
    requires the execute bit
  - **Then** the docs + consent describe the guarantee as "enforced for launcher invocations" and **never** claim
    "bypass-proof"; the same-user raw-exec residual (copy+exec / install-upstream) is documented as out of scope
    (it needs agent sandboxing). No file-mode hardening is shipped (it was infeasible without breaking exec).

- [x] **Scenario: agent-browser fixture (the motivating case)** _(spec 268: a write is held by the launcher-forced policy; `--confirm-actions ""` refused — live-proven)_
  - **Given** the agent-browser plugin declares a launch policy forcing the write-confirmation env
  - **When** a headless agent issues a write through the launcher
  - **Then** the write is held/auto-denied (`confirmation_required`) and **cannot be made ungated through argv** —
    the spec-268 gate is now mechanical end-to-end.

## Non-goals

- A general per-process sandbox / seccomp / network policy for tools (this is env + argv shaping only).
- Arbitrary env injection without consent UI — every enforced env/arg is shown + fingerprinted + consented.
- Runtime mutation of a policy (a policy change is a plugin update → re-consent, like any tool change).

## Open questions

- **OQ1 — RESOLVED (2026-06-26): scope the claim, don't overclaim.** File-mode hardening is infeasible (the
  validated-fd exec needs the execute bit; Node lacks `memfd`/`fexecve`) AND insufficient (a same-user shell agent
  can always copy+exec or install upstream). The guarantee is "enforced via the launcher"; true bypass-proofing =
  agent sandboxing, a separate future research item, not this feature.
- **OQ2 — `args` placement + dedup.** Where do policy `args` go relative to agent argv (prepend? after a `--`?),
  and how to handle an agent passing the same non-denied flag (dedup vs reject)?
- **OQ3 — env precedence semantics.** Policy env strictly overrides parent env for its keys (chosen); confirm no
  legitimate case needs the inverse, and that `denyArgs` + forced env together can't be played against each other.
- **OQ4 — consent granularity.** Is the forced policy its own ack line, or folded into the existing per-tool
  consent? (Lean: a visible line in the existing per-tool section, no extra ack — it's part of the tool's identity.)
