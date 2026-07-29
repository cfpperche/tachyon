# One settings authority: removing `contributes.configuration`

**Task:** `t-60934c` · **Status:** investigation, NO implementation · **Author:** claude-reviewer, 2026-07-29

---

## 0. Verdict

**Yes — all eleven contributed settings can go, and the extension can ship with no
`contributes.configuration` at all.** The bootstrap problem that would normally block this does not
apply here, for a reason that is already true in the code rather than something this proposal has to
build (§3).

One dependency survives and must not be confused with the above: Tachyon *reads* VS Code's **`git.path`**
(the built-in Git extension's setting) as a fallback. That is consuming someone else's configuration,
not contributing our own, and it can stay while our eleven keys go.

---

## 1. The eleven keys, key by key

| Key | Default | VS Code scope | Read by | When | Verdict |
|---|---|---|---|---|---|
| `tachyon.maxAgents` | `8` | window | `Workspace.ts` via `getSetting` | live | **Migrate — already duplicated (§2)** |
| `tachyon.agentMemoryMax` | `""` | window | `Workspace.ts` via `getSetting` | per spawn | Migrate to `tachyon.yml` |
| `tachyon.taskNotifications.enabled` | `true` | window | `extension.ts` direct | live | Migrate to `tachyon.yml` |
| `tachyon.taskNotifications.events` | 5 events | window | `extension.ts` direct | live | Migrate to `tachyon.yml` |
| `tachyon.taskNotifications.suppressOwnChanges` | `true` | window | `extension.ts` direct | live | Migrate to `tachyon.yml` |
| `tachyon.taskNotifications.dedupeWindowMs` | `30000` | window | `extension.ts` direct | live | Migrate to `tachyon.yml` |
| `tachyon.activity.codeTheme` | `"auto"` | window | `Cockpit.ts:2813` direct | render | Migrate — **presentation, global file** |
| `tachyon.worktrees.revealInWorkspace` | `true` | window | `extension.ts:438` direct | on reveal | Migrate to `tachyon.yml` |
| `tachyon.gitPath` | `""` | window | `worktree/gitBinary.ts` | before git runs | **Migrate with care (§3)** |
| `tachyon.agentPane.enabled` | `true` | window | `AgentPanePanel.ts` direct | UI activation | Migrate — global file |
| `tachyon.sidebar.cardTemplate` | `{}` | **application** | `SidebarPrototype.ts`, `Cockpit.ts:1204` | render | Migrate — global file, **Settings Sync loss (§5)** |

Note the split in *how* they are read: only three (`gitPath`, `maxAgents`, `agentMemoryMax`) go
through `EngineHost.getSetting`. The other eight call `vscode.workspace.getConfiguration` **directly**
from `extension.ts`, `AgentPanePanel.ts`, `SidebarPrototype.ts` and `Cockpit.ts`, bypassing the host
abstraction entirely. Those eight are VS Code-only code paths today and are the bulk of the work.

---

## 2. The duplication that already exists

`maxAgents` is authored in **two places right now**:

- `tachyon.yml` → `settings.maxAgents`, parsed and validated in `loadConfig.ts` (`:450`, `:1417-1422`,
  refusing anything that is not an integer ≥ 1);
- `tachyon.maxAgents` in VS Code settings, read at `Workspace.ts` via `getSetting("tachyon",
  "maxAgents", 8)`.

Two authorities for one value, with precedence decided by whichever caller wins — this is the
concrete instance of the problem the task is about, and it is not hypothetical. **Determining and
documenting the current precedence is a prerequisite for step 1**, because the migration must
preserve the value the human currently experiences, not the one we assume they get.

`tachyon.yml` also already owns `settings.companion.*` (tabTools, allowedHosts, lanAccess) and
`settings.agentNotifications.idleAfterMinutes`, both authored through Control → Settings. **The
pattern this proposal recommends is therefore already shipping and proven** — this is an extension of
an existing mechanism, not a new one.

---

## 3. The chicken-and-egg, and why it is smaller than it looks

The task asks for the minimum bootstrap if zero settings is impossible. It is possible, and the
reason is already in the code:

**`DaemonEngineHost.getSetting` does not read VS Code.** It reads a *snapshot* — `this.settings.workspaceFolder`
/ `workspace` / `global`, with folder > workspace > global precedence — behind an `assertSettingAllowed`
allowlist. The persistent engine is already fed configuration rather than reading it. So "Tachyon core
must not depend on VS Code" is **already true at the engine boundary**; what this proposal changes is
only *who authors the values*, not who reads them.

That leaves the genuine ordering questions:

- **`gitPath`** is needed before git runs. But nothing in the boot path needs git to *find* a config
  file: `tachyon.yml` is read as a plain file and a global Tachyon file lives at a fixed path under
  the extension's global storage. So git is not a prerequisite for reading settings; settings are a
  prerequisite for git. The order works.
- **`agentPane.enabled`** and **`cardTemplate`** are needed when no workspace may be open at all.
  These belong in the **global Tachyon file**, not `tachyon.yml`, precisely because they must be
  answerable with zero workspaces.
- **Nothing needs a value before a file at a fixed path can be read.** That is the whole bootstrap.

**Minimum bootstrap: zero contributed settings.**

---

## 4. Recommended architecture

Two authorities, split by a rule that is about *scope of meaning*, not convenience:

- **`tachyon.yml` → per-workspace behaviour.** `maxAgents`, `agentMemoryMax`, `taskNotifications.*`,
  `worktrees.revealInWorkspace`. These describe how *this project* runs, belong in the repo, and are
  reviewable and shareable with the team.
- **Global Tachyon file → per-person presentation and host wiring.** `activity.codeTheme`,
  `agentPane.enabled`, `sidebar.cardTemplate`, `gitPath`. These describe how *this human's machine*
  behaves, must answer with no workspace open, and must never be committed to someone's repo.

Both are edited only through Control → Settings. Both are validated fail-closed by the same loader
discipline `tachyon.yml` already has — an invalid value is refused with a named error and the last
known-good is kept, never silently defaulted. Writes are transactional (temp + rename), matching what
the profile and runtime-config stores already do.

**No secrets.** Credentials stay where they are — this is configuration only, and the task says so.

---

## 5. Risks, and the adversarial pass on my own design

- **Settings Sync loss is real and is the one genuine regression.** `sidebar.cardTemplate` is
  `scope: application`, meaning it syncs across a human's machines today. A global Tachyon file does
  not. Anyone relying on that sync loses it. This is a **human decision**, not a detail to absorb
  quietly.
- **Recovery when Control cannot open** is where my own design is weakest, and it deserves to be
  stated rather than defended. Today a broken setting is fixable in the VS Code settings UI, which
  works even when Tachyon is unhealthy. Move everything into Tachyon's own surface and the repair
  path depends on the thing that is broken. Mitigations: both files stay plain text and
  hand-editable at documented paths; the loader refuses with a named error and keeps last-known-good
  rather than dying; and `agentPane.enabled` must **fail toward enabled** so a bad value cannot hide
  the surface that would fix it. I would not ship the removal without that last rule.
- **Remote WSL/SSH/Containers**: VS Code settings can be remote-scoped; a global Tachyon file lives
  on whichever side the extension host runs. For remote work the *host* side is the correct side, and
  that matches where the extension already runs — but it means a human's local preferences do not
  follow them into a remote. Same class of loss as Settings Sync, same decision.
- **Multi-root**: `tachyon.yml` is per-folder, which is *better* than the current window-scoped VS
  Code settings, not worse. This is an improvement the migration gets for free.
- **Two sources of truth during migration** is the failure this must avoid. The plan below removes
  each contributed key in the same step that adds its replacement — never a release where both are
  live and precedence has to be guessed.

---

## 6. Steps

1. **Determine and document the current `maxAgents` precedence** (§2). Prerequisite: the migration
   must preserve observed behaviour, not assumed behaviour.
2. **Add the global Tachyon file** with schema, fail-closed validation and transactional write.
   Nothing reads it yet.
3. **Migrate the four `EngineHost.getSetting` keys** (`maxAgents`, `agentMemoryMax`, `gitPath`), each
   removing its `contributes.configuration` entry in the same commit, with a one-time import of any
   existing value.
4. **Migrate the eight direct `getConfiguration` readers**, routing them through the host abstraction
   instead of reading VS Code — this is the bulk of the work and the part that makes the surface
   uniform.
5. **Remove `contributes.configuration` entirely** from `package.json`.
6. **Control → Settings gains the migrated keys**, grouped by the workspace/global split.

Steps 3 and 4 are per-key and independently landable. Step 5 is the point of no return.

---

## 7. Human decisions strictly necessary

1. **Accept losing Settings Sync for `sidebar.cardTemplate`** (and remote-scoped preferences
   generally), or keep exactly that one key contributed. Keeping one key means keeping
   `contributes.configuration`, which forfeits the goal — so this is genuinely either/or.
2. **Accept that repair-when-broken moves into Tachyon's own surface**, mitigated by hand-editable
   plain-text files and a fail-toward-enabled rule for `agentPane.enabled`.
3. **Confirm the workspace/global split in §4** — specifically that `gitPath` is per-machine rather
   than per-project, which is what makes it global.

---

## 8. What this investigation did not do

- Did not measure the current `maxAgents` precedence — it is step 1 for a reason, and guessing it
  here would have put an assumption in a document meant to remove one.
- Did not enumerate every read site of the eight direct consumers, only the files.
- Changed no product code, per the task.
