# 269 — tool-launch-policy

_Created 2026-06-26._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

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

**Scope of the safety claim (ratified honesty, per codex):** "enforced via the launcher." A launch policy makes a
flag impossible to omit or override *through the launcher*. It does **not**, on its own, stop an agent from
executing the raw content-addressed binary directly (the lockfile exposes `installPath`, mode `0500`). Closing
that residual — making the on-disk binary non-directly-executable so the validated-fd launcher is the only
entrypoint — is a declared **acceptance question** of this spec (OQ1), not an afterthought; the feature must not
advertise "bypass-proof" until OQ1 is resolved one way or the other.

**Done** = a plugin can declare `tools.<name>.launchPolicy { env?, args?, denyArgs?, mode: "force" }`; install
surfaces it in the per-tool consent ("this tool will always launch with these enforced env vars / args"),
fingerprint-binds it, and records it in the lockfile; the launcher injects the env + args and fails closed on a
conflicting agent arg; and a fetched-tool exec that tries to skip the policy through argv is refused. The
raw-path residual is either closed (OQ1) or explicitly documented as out of the claim.

## Acceptance criteria

- [ ] **Scenario: a plugin declares an enforced launch policy**
  - **Given** `tools.<name>.launchPolicy = { env: { FOO: "bar" }, args: ["--safe"], denyArgs: ["--confirm-actions",
    "--action-policy"], mode: "force" }`
  - **When** the manifest loads
  - **Then** it validates fail-closed: a small string→string `env` map, an argv vector, a `denyArgs` list, no
    control chars, capped sizes; unknown/malformed fields are rejected (a pre-269 Tachyon already rejects the
    unknown `launchPolicy` field — forward-safe).

- [ ] **Scenario: consent surfaces the forced policy + the fingerprint binds it**
  - **Given** an install with a launch policy
  - **When** the consent drawer renders
  - **Then** it states, per tool, "always launches with enforced env: FOO=bar; args: --safe; refuses:
    --confirm-actions, --action-policy" — and the policy is part of the install fingerprint (a policy change →
    a new fingerprint → re-consent).

- [ ] **Scenario: the lockfile records the consented policy (immutable, hot-path source)**
  - **Given** the install applied
  - **When** the lockfile is read
  - **Then** each `ToolLock` carries its `launchPolicy`; parse is fail-closed (corrupt policy → refuse, never a
    silent unpoliced launch). The launcher reads the **lockfile** policy (not the manifest) — matching the
    existing lockfile-only hot path.

- [ ] **Scenario: the launcher injects env even when the parent env omits/contradicts it**
  - **Given** a tool with `launchPolicy.env = { AGENT_BROWSER_CONFIRM_ACTIONS: "…" }`
  - **When** the agent invokes the launcher with that env unset (or set to empty)
  - **Then** the launcher spawns with an **explicit** env where the policy values win — the flag is on regardless
    of the caller's env. (`spawnSync` currently passes no `env` → inherits; this spec makes it explicit.)

- [ ] **Scenario: the launcher refuses a conflicting agent arg (fail closed, not last-wins)**
  - **Given** `denyArgs` includes `--confirm-actions`
  - **When** the agent passes `--confirm-actions ""` (or its own `--action-policy`)
  - **Then** the launcher **refuses to exec** with a clear error (auditable), rather than relying on the tool's
    flag-vs-env precedence. Policy `args` are applied in a position the agent cannot neutralize.

- [ ] **Scenario: the raw-path residual is resolved or scoped (OQ1)**
  - **Given** the content-addressed binary at `.tachyon/bin/<name>/<sha>/<exe>`
  - **Then** EITHER the on-disk file is made non-directly-executable so only the launcher's validated-fd exec runs
    it (closing the bypass), OR the docs/consent explicitly scope the guarantee to "launcher invocations" and the
    spec never claims "bypass-proof". (Decide in the design; the launcher already does Linux procfd exec — assess
    whether mode `0400` + `fexecve` is viable.)

- [ ] **Scenario: agent-browser fixture (the motivating case)**
  - **Given** the agent-browser plugin declares a launch policy forcing the write-confirmation env
  - **When** a headless agent issues a write through the launcher
  - **Then** the write is held/auto-denied (`confirmation_required`) and **cannot be made ungated through argv** —
    the spec-268 gate is now mechanical end-to-end.

## Non-goals

- A general per-process sandbox / seccomp / network policy for tools (this is env + argv shaping only).
- Arbitrary env injection without consent UI — every enforced env/arg is shown + fingerprinted + consented.
- Runtime mutation of a policy (a policy change is a plugin update → re-consent, like any tool change).

## Open questions

- **OQ1 — raw-path execution.** Close it (non-directly-executable binary + launcher-only fd exec; verify
  `fexecve` works at mode `0400` on Linux, and the macOS/script fallbacks) or scope the claim. This is the
  difference between "bypass-proof" and "enforced for launcher invocations."
- **OQ2 — `args` placement + dedup.** Where do policy `args` go relative to agent argv (prepend? after a `--`?),
  and how to handle an agent passing the same non-denied flag (dedup vs reject)?
- **OQ3 — env precedence semantics.** Policy env strictly overrides parent env for its keys (chosen); confirm no
  legitimate case needs the inverse, and that `denyArgs` + forced env together can't be played against each other.
- **OQ4 — consent granularity.** Is the forced policy its own ack line, or folded into the existing per-tool
  consent? (Lean: a visible line in the existing per-tool section, no extra ack — it's part of the tool's identity.)
