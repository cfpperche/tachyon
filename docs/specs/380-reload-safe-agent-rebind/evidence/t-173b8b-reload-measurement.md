# t-173b8b — reload and engine-upgrade measurement

_Measured on 2026-08-10 against tree `f4891df669ddac52f86856874d6ac2b44588f94b`._

## Result

The reported loss is not caused by an ordinary VS Code window reload. Since SDD 382, a same-version
reload only detaches and reattaches the editor shell; the persistent engine, Bridge, tmux sessions,
agent processes, and in-flight turns remain alive. The current process-boundary test models Extension
Host death and proves that the replacement shell attaches to the same engine PID and instance.

Installing a new Tachyon version changes the result. On the first activation of the new extension,
`ensureDaemonEngine()` detects a different bundle and performs a controlled engine upgrade. The
supervisor stops the old engine and starts the new one. The new engine advances the Bridge generation;
under the default `auto` policy, SDD 364/380 deliberately runs each wired survivor through
`preflight -> stop -> dead (or hard kill) -> resume`. Resume restores the conversation and Bridge
client, but it does **not** preserve the in-flight turn or its pending tool result.

This is directly visible in today's production records for the 0.76.0 -> 0.77.0 installation:

- `supervisor/transitions.jsonl`: transition prepared at `2026-08-10T23:03:50.597Z` and committed at
  `23:03:51.541Z`, with a new engine PID and instance.
- `state/bridge-client-rebind/audit.jsonl`: generation 239 found two running survivors; `claude` was
  stopped, hard-killed after 15 seconds, and resumed; `claude-fork-1` was stopped, observed dead, and
  resumed. Both ended in `resume_ok`, but both active turns were interrupted.
- Focused current-tree verification passed: seven selected reload-safe/reconstruction tests across
  `agentManager.test.ts` and `bridgeClientRebind.test.ts`.

Therefore SDD 380 prevents a zombie or permanently dead resumable agent, but it does not solve the
owner's loss. The task should not close without code: the destructive boundary is **engine upgrade**,
not ordinary reload.

## Interception boundary

| Actor and trigger | Tachyon can intercept? | Current consequence |
|---|---:|---|
| Agent calls Bridge `run_host_action(reloadWindow)` | Yes | Already refuses while another agent is active. This is an agent guard, not the human installation path. |
| Human uses a future Tachyon-owned reload action | Yes | Tachyon can check `working` before calling the editor command. No such human reload door exists today. |
| New shell activates a different bundled engine | **Yes** | Tachyon owns `ensureDaemonEngine -> upgradeDaemonEngine` and can preflight immediately before stopping the old engine. This is the interceptable destructive door from the incident. |
| Human runs `Developer: Reload Window` | No | VS Code owns the command and offers extensions no veto. A same-version reload is safe under SDD 382. |
| Human installs/updates a VSIX in Extensions UI, selects another version, or runs `code --install-extension` | No | Installation happens outside Tachyon. Tachyon first regains control when the new shell activates and requests the engine upgrade. |
| Human clicks VS Code's `Reload Required` / restarts the Extension Host | No | Editor-owned. The shell reload itself is safe; a subsequent Tachyon engine upgrade is separately interceptable. |
| Human disables/uninstalls Tachyon, kills VS Code/systemd/tmux, reboots, or the engine crashes | No | No warning can be guaranteed from extension code on these external or failure paths. |

The product must not claim that it blocks installation or `Developer: Reload Window`. It can only
guard the engine transition that the newly activated Tachyon shell itself controls. External process
kills and a user bypassing Tachyon remain explicitly unprotected.

## Proposal — two pieces

1. **Expose the existing `working` snapshot at the engine-upgrade preflight.** Add one bounded,
   read-only control query from the new shell to the still-running old engine, returning only names
   whose existing attention state is `working`. Do not persist history, add an agent state, count
   events, or change rebind. If an older engine cannot serve the query, return `unknown`; do not
   manufacture an empty roster.
2. **Gate the controlled engine stop with one modal warning.** If that query is non-empty, do not call
   the supervisor stopper until the human chooses either **Keep current engine** (default/cancel) or
   **Upgrade anyway**. Name the working agents in the message. For `unknown`, show the same modal and
   say that active work could not be checked. The override is mandatory in both cases.

This guard sits at the only product-owned destructive door and covers extension installations even
though Tachyon cannot intercept the installation or editor reload that preceded activation. Ordinary
same-version reload needs no new warning because it no longer threatens work.
