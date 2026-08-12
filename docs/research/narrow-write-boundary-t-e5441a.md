# A narrow write boundary after t-5313dc — t-e5441a

_Measured 2026-08-12. Measurement and design only; no product code was changed._

## Verdict

There is a useful boundary, but not one boundary that Tachyon can honestly promise for all four
runtimes today.

The narrow rule is worthwhile: **an agent may write its own worktree and the shared operational
roots it actually needs, but may not write `src/` or `test/` in the primary checkout**. Codex can
express the useful shape with its whole-process workspace sandbox and Grok can express it with a
fail-closed custom profile. Claude cannot cover its non-Bash `Edit`/`Write` path in the permission
mode Tachyon uses, and Pi has no sandbox. Tachyon cannot repair either hole from inside its own
extension process: an agent shell is a peer process with the same user authority.

Recommendation: **detect and report for every runtime now**, with runtime-specific prevention as an
optional stronger capability for Codex and Grok. Do not call the common product guarantee
confinement. The proposed detector should report a primary-checkout mutation with overlap/provenance and
before/after state; it should not try to block or automatically revert it.

Operationally, the asymmetry must not become a hidden runtime-dependent promise. The default and the
only cross-runtime product statement remains detection/reporting. Codex/Grok prevention should ship,
if chosen, only behind an explicit launch capability such as “protected writes (Codex/Grok)” that
names the runtime and refuses unsupported Claude/Pi launches. It must never silently turn itself off,
reuse the generic word “isolated”, or let two otherwise identical agent cards imply the same
guarantee. If the product does not want a visibly asymmetric capability, defer prevention entirely;
do not weaken its definition to admit all four runtimes.

This partly overturns the task's initial bet. Detection is the only portable answer, but prevention
is neither impossible nor necessarily expensive for two runtimes. It is a useful runtime-specific
hardening, not a cross-runtime product boundary.

## What agents really write outside their worktrees

### Corpus and limits

The sample is the 2026-08-12 task-attempt ledger and the temporary-agent lifecycle around it. The
ledger records 18 released temporary attempts during the day; the task was opened against the 15
already-dismissed worktrees visible to its author at that point. Dismiss removes the worktree and
its live Activity record, so a retrospective filesystem scan cannot enumerate every syscall or
attribute every surviving file to one agent. That is itself an important result: the current store
is insufficient for a complete after-the-fact write audit.

I therefore counted a path only when it had one of these durable proofs:

1. a surviving runtime record names the path;
2. the task/doorbell/continuity ledger records the write through its production door;
3. Git's linked-worktree layout requires and retains the shared path;
4. a surviving dated artifact exists in a runtime- or gate-specific directory.

Host-wide mtime totals (`~/.npm`: 11,755 files, `~/.cache`: 16,056, `/tmp`: 45,090) were **not**
treated as attribution. Other agents, Tachyon, VS Code, and tests were concurrent. They prove those
roots are active, not who wrote each file.

### Measured path classes

| Outside root | Measured examples | Writer / trigger | Required? |
|---|---|---|---|
| Primary checkout shared Git directory, `/home/goat/tachyon/.git/` | `worktrees/<agent>/HEAD`, `index`, logs; branch refs, reflogs and object database during commit/integration | `git` subprocess run by the agent | Yes. Every linked worktree's `.git` is a text pointer into this directory. Denying it breaks normal `git add`/`commit`. |
| Workspace operational store, `/home/goat/tachyon/.tachyon/` | task `.json`, `.journal`, `.attempts`; `doorbells.jsonl`; `handoff-notes.jsonl`; continuity; evidence; managed-worktree/session records | Mostly Tachyon/Bridge in response to agent calls; some harness/runtime processes | Yes for normal collaboration and delivery evidence. It is outside the agent worktree even when the agent never opens it directly. |
| Private runtime homes under `.tachyon/` | `harness/<agent>/` Codex/Claude SQLite, history, config and model cache; `bridge-mcp/<agent>.grok/` Grok config/session/cache files | Runtime process and Tachyon materialization | Yes while that runtime is used. Survival after dismiss is uneven; existing task `t-23ee99` measured Codex/Claude retention and Grok loss. |
| Activity and terminal capture under `.tachyon/` | `activity/<agent>-<session>.jsonl`, state JSON, `pane-transcripts/<agent>.log`, `activity/session-owners.jsonl` | Tachyon readers/recorders caused by the running agent | Yes for observation, provenance and recovery; these are host writes, not proof of a runtime file-tool write. |
| `/tmp` | Claude scratchpad and file-history snapshots; `tachyon-verify-full-*` reports/logs; `tachyon-bridge-ws-*` and `ws-headless-*` test fixtures | Runtime, gate and test subprocesses | Yes with the present tools/gate. The Claude history record contains concrete scratchpad paths; today's gate fixtures survive with dated files. |
| User caches | `~/.npm/_npx/...` packages and npm cache content used by runtime wrappers/tests | `npx`/npm subprocesses | Sometimes. The files are measured today, but per-agent attribution is unavailable; a boundary must either admit the configured cache or relocate it. |
| Primary checkout tracked files | `/home/goat/tachyon/src/webview/cockpit/App.tsx`, `/home/goat/tachyon/src/cockpit/sectionNav.ts`, `/home/goat/tachyon/test/unit/vitestBudget.test.ts`, and `/home/goat/tachyon/package.json` appear in Claude's durable file-history snapshot; `t-5313dc` separately records the real cross-checkout write | Claude file-history/runtime state, with the incident established by `t-5313dc` | No. `src/` and `test/` are the candidate prevention target; `package.json` proves that target is deliberately narrower than “all tracked files.” |

The list changes the design in two ways. First, allowing only the worktree is not viable: shared Git
and `.tachyon` are not incidental exceptions. Second, allowing the entire primary checkout merely
to reach `.git` and `.tachyon` destroys the boundary. The grants must be exact sibling roots, not
their common parent. It also shows the candidate's limit: it protects the code/test directories
from the observed incident family, but not `package.json`, `scripts/`, `docs/`, or other tracked
primary files.

## Can each runtime impose the narrow rule?

Installed versions on this pass were Claude Code 2.1.229, Codex CLI 0.146.1, Grok 1.0.3 and Pi
0.80.10. The enforcement baseline is parity dimension 22 and
[`runtime-write-discovery-isolation-t5313dc.md`](runtime-write-discovery-isolation-t5313dc.md): none
currently earns a Tachyon-consumed, all-write-path, fail-closed check mark. The question here is
narrower: can its native mechanism protect the primary `src/` and `test/` while admitting the
measured roots?

| Runtime | Narrow boundary verdict | Why |
|---|---|---|
| Claude | **No, not under Tachyon's current permission posture.** | The OS sandbox covers Bash/subprocesses, while `Edit`/`Write` remain permission-tool paths. `t-5313dc` measured `Write` crossing the declared directory under `bypassPermissions`. A Bash-only deny would leave the exact non-Bash door that produced the evidence. Disabling bypass or removing mutating non-Bash tools could make a different product mode enforceable, but that is a permission-mode change, not this narrow projection. |
| Codex | **Yes, as runtime-specific prevention; not consumed today.** | `workspace-write` confines the whole generated-command process to CWD plus exact `writable_roots`. The agent worktree is CWD; add the exact common `.git`, workspace `.tachyon`, and any explicitly selected cache/scratch roots. Do **not** add `/home/goat/tachyon`. Primary `src/` and `test/` stay outside the writable set. Codex already admits `/tmp`/`$TMPDIR` unless excluded. The remaining product work is to prove real `git commit` and the full gate through this launch profile; dimension 22 remains `~` until then. |
| Grok | **Yes, as runtime-specific prevention; not consumed today.** | A custom profile extending `workspace` can add exact `read_write` roots and exact absolute `deny` entries for primary `src` and `test`. The sandbox covers in-process tools and children. Unlike a built-in profile, an explicitly requested custom profile with a non-empty deny refuses startup when it cannot enforce. On Linux, exact denies avoid the documented post-launch hole of glob expansion. Cost: a Tachyon-owned per-agent profile and lifecycle continuity across create/restart/resume/fork. |
| Pi | **No.** | Pi has no built-in sandbox. Removing `bash`, `edit`, and `write` prevents useful implementation rather than confining it. A container/VM/OS wrapper could impose a boundary, but then the enforcing component is the wrapper, not Pi or Tachyon as currently shipped. |

This is why dimension 22's four-runtime result must be said first: Codex and Grok have mechanisms,
but Tachyon consumes neither; Claude's mechanism has a named non-Bash hole; Pi has none. A design
that starts by calling all four confined would repeat the defect the dimension records.

## Can Tachyon impose it without a runtime sandbox?

No. Not as a prevention boundary.

Tachyon can choose CWD, construct environment variables, wrap selected commands, inspect files,
and refuse a launch. Once it starts an unsandboxed runtime, however, that process and every shell it
spawns run as the same OS user. They can open the primary checkout directly, invoke another binary,
or bypass a Tachyon-owned wrapper. Bridge permission handlers are not a mandatory mediation point:
the ACP measurement already found runtimes that write without emitting a permission request. Git
hooks are also the wrong layer: they see Git operations, not `open(2)` from an editor or shell.

Only an authority below the runtime process can prevent the write: Landlock/bubblewrap/Seatbelt, a
container/VM, mount/ACL separation, or an equivalent OS primitive. Tachyon may configure and launch
such a mechanism, but then it **is using a runtime/external sandbox**. Without one, “prevent” is a
convention with a preflight check, not confinement.

The actor × trigger consequence is explicit:

| Actor × trigger | Without OS enforcement |
|---|---|
| Interface creates/restarts/resumes/forks an agent | Tachyon can attach policy and start a detector, but cannot mediate later direct writes. |
| Agent creates a temporary agent | Same; the child must inherit both the declared policy and the detector baseline. |
| Tachyon crash-recovers/rematerializes a session | It must restore the same detector/baseline; otherwise the recovery door is unobserved. |
| Agent uses shell, built-in edit/write, MCP, or a spawned child | Only whole-process OS enforcement covers all four; Bridge/tool hooks cover subsets. |

## Prevention versus detection

### What detection can truthfully promise

A detector can promise: “Tachyon observed that protected primary-checkout paths changed while this
agent session was alive, and recorded the before/after state.” It cannot promise the write was
blocked, that attribution is certain merely from timestamps, or that the tree is safe to revert.

The cheapest useful design is session-scoped observation of the primary checkout's **entire tracked
tree**, excluding the deliberately mutable `.git` and `.tachyon` operational roots. Detection need
not inherit prevention's narrow `src/`/`test/` scope; Git already supplies the broader inventory.

1. At spawn/restart/resume/fork, record primary `src/` and `test/` Git state plus content identity.
2. Watch those directories while the session lives, retaining path and time as a lead, not proof of
   authorship.
3. At stop/crash/dismiss/delivery, compare against the baseline through the same canonical Git
   door. If changed, append an immutable incident record containing session, runtime, worktree,
   before/after tree or blob IDs, paths, timestamps, and whether another live actor overlapped.
4. Surface the incident to the human and task journal. Never auto-revert: the primary checkout may
   contain legitimate human or sibling work.

Attribution is the cost center. A plain watcher says **what and when**, not **who**. Strong attribution
requires OS audit/eBPF/fanotify or launching each runtime in a distinguishable security context;
that is much closer to sandbox machinery. The first version should therefore report
“mutation overlapped session X” and list concurrent actors, not accuse an agent from mtime alone.

This detector is useful because the real defect is rare and severe and the product already owns
lifecycle and durable reporting doors. It does not need to inventory `/tmp`, caches or `.tachyon`;
those are measured allowances, not protected targets.

### Decision

Adopt **detect-and-report as the portable policy and default behavior**. Separately evaluate a Codex
`workspace-write` launch profile and a Grok fail-closed custom profile as explicit opt-in,
runtime-named prevention. An unsupported runtime must refuse that option; it must not fall back to
detection while preserving the prevention label. Their
acceptance test must traverse the production launch for create, restart, resume, fork and crash
recovery; prove own-worktree edit, commit and full gate green; and prove primary `src/` and `test/`
writes red through shell and native edit tools. Until those tests exist, describe them as feasible
mechanisms, not shipped boundaries.

Do nothing is worse than detection: the current durable evidence cannot reliably reconstruct all
writes after dismiss, while the primary-checkout incident already happened. Uniform prevention is
also the wrong recommendation: it would either exclude Claude/Pi or restore the false promise that
`t-5313dc` just removed.

## Evidence used

- [`runtime-write-discovery-isolation-t5313dc.md`](runtime-write-discovery-isolation-t5313dc.md) and
  [`../runtimes/parity.md`](../runtimes/parity.md), especially dimension 22.
- `.tachyon/tasks/*.attempts` for the 2026-08-12 attempt/release population.
- `.tachyon/managed-worktrees.json`, `.tachyon/sessions.json`, task journals, doorbells, continuity,
  activity records, pane transcripts and surviving per-runtime homes in the primary checkout.
- Claude's durable file-history snapshot, which names both runtime scratch and primary-checkout
  tracked paths.
- Installed runtime help/docs for the versions stated above, including Grok's custom-profile
  fail-closed and exact-deny behavior.
