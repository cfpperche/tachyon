# Runtime write and discovery isolation — t-5313dc

_Measured 2026-08-11. Measurement and policy only; no product code was changed._

## Question and method

Tachyon currently describes an agent worktree as the place where the agent must make direct
changes, but the brief is not a filesystem boundary. This report asks, for each attested runtime,
what the installed binary actually exposes for (a) restricting writes and (b) selecting skill/config
discovery roots. It does not assume parity between runtimes.

Installed versions were read with each runtime's `--version`: Claude Code 2.1.227, Codex CLI
0.146.1, Grok 1.0.0 (`3cd0d0cbce`), and Pi 0.80.10. Evidence is the installed CLI help and installed
runtime documentation/source, cross-checked against vendor documentation where available. I did
not launch a Codex agent against the real workspace and did not reproduce the destructive
`.agents/skills` replacement from t-f842f0. The only runtime fixture was an empty directory under
`/tmp`, used for read-only `grok inspect --json`; it contained no workspace or user data.

## Result

| Runtime | Real write control | Real discovery-root control | What remains uncovered | Sources |
|---|---|---|---|---|
| **Claude 2.1.227** | `sandbox.enabled` gives OS-enforced Bash/subprocess confinement: CWD is writable by default; `sandbox.filesystem.allowWrite` adds roots. `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, and no `excludedCommands` are required for a fail-closed boundary. This sandbox covers Bash, not every Claude tool; Edit/Write remain governed by permission rules. `bypassPermissions` skips those permission checks, so it cannot be part of a claim that all write paths are confined. | `CLAUDE_CONFIG_DIR` relocates the user root. Project skills are fixed to `.claude/skills` from the launch directory through the repo root (and nested directories on demand). `--add-dir`/`additionalDirectories` adds file access and, exceptionally, skills; it does not replace the project root. `--plugin-dir` can load an explicit plugin tree. | Strong worktree confinement is available only with sandbox enabled **and** bypass disabled (or mutating non-Bash tools removed). Built-in sandbox unavailability otherwise warns and runs unsandboxed. Project discovery cannot be redirected to an arbitrary private root. | Installed `claude --help`; Anthropic [sandboxing](https://code.claude.com/docs/en/sandboxing), [permissions](https://code.claude.com/docs/en/permissions), [skills](https://code.claude.com/docs/en/slash-commands), and [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/claude-directory) docs. |
| **Codex 0.146.1** | `--sandbox workspace-write` / `sandbox_mode = "workspace-write"` makes the working root writable and accepts only explicit additional roots through `--add-dir` or `sandbox_workspace_write.writable_roots`. `/tmp` and `$TMPDIR` are writable by default but can be removed with `exclude_slash_tmp` and `exclude_tmpdir_env_var`. `danger-full-access` and `--dangerously-bypass-approvals-and-sandbox` explicitly remove the boundary. | `CODEX_HOME` relocates user config/profile state. Repository skills are runtime-fixed: `.agents/skills` in every directory from CWD to the repo root. `project_root_markers` changes how the repo root is found, not the skill directory name or a separate projection root. Individual discovered skills can be disabled by absolute `[[skills.config]]` entries; there is no measured setting that substitutes a private repository-skill root. | Write confinement is usable, but `/tmp` is extra unless explicitly excluded. The project discovery tree remains coupled to `<cwd>/.agents/skills`; therefore Tachyon must not replace that whole directory. A no-worktree launch with `cwd === workspaceRoot` still reaches the owner/plugin tree described by t-f842f0. | Installed `codex --help`; OpenAI [configuration reference](https://developers.openai.com/codex/config-reference/) and [skill locations](https://developers.openai.com/codex/skills/); t-f842f0 plus `src/harness/HarnessManager.ts` for Tachyon's current projection target. |
| **Grok 1.0.0** | `--sandbox workspace` confines the **entire Grok process** with Landlock/Seatbelt: writes are CWD + `GROK_HOME` + `/tmp` + `/var/tmp`. A custom profile can extend `workspace` and add `read_only`, `read_write`, and `deny`. Built-in profile application warns and continues if unavailable; an explicitly requested custom profile refuses startup on enforcement/config failure, so only a custom profile is a fail-closed product gate. | `GROK_HOME` relocates the user root. Project discovery is fixed across CWD-to-repo-root `.grok`, `.agents`, enabled `.claude`, and enabled `.cursor` roots. `[skills].paths` adds explicit roots; `[skills].ignore` hides paths; compat flags disable Claude/Cursor roots. None replaces the native `.grok`/`.agents` project walk. | A fail-closed custom workspace profile can enforce writes, but still necessarily permits private runtime state and temp dirs. Native project discovery remains ambient unless every unwanted path is explicitly ignored; there is no single replacement discovery root. | Installed `grok --help`; installed `/home/goat/.grok/docs/user-guide/18-sandbox.md` and `08-skills.md`; empty-fixture `grok inspect --json`. |
| **Pi 0.80.10** | **No built-in sandbox.** Pi states that built-in tools, extensions, and child processes run with the launching user's permissions. Tool filtering can remove `bash`, `edit`, and `write`, but it cannot support a writable-worktree agent while confining those writes. Real isolation must wrap the whole process in an OS/container/VM boundary. | `PI_CODING_AGENT_DIR` relocates user config; `PI_CODING_AGENT_SESSION_DIR` relocates sessions. `--no-skills` disables automatic discovery and repeatable `--skill <path>` adds explicit private roots. Without that pair, Pi scans `.pi/skills` and `.agents/skills` from CWD through ancestors to the repo/filesystem root. Equivalent `--no-*` + explicit-path controls exist for extensions, prompts, and themes. | Native write isolation is unavailable. Discovery can be made explicit, but that does not restrict what enabled tools or extensions write. Declaring Pi isolated without an external sandbox would be false. | Installed `pi --help`; installed Pi `docs/security.md` (also [upstream](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)) and [skill discovery](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md); installed `dist/core/tools/write.js`. |

The majority does expose something useful: Claude, Codex, and Grok can restrict writes, while Pi
cannot. But that is not parity. Claude's kernel boundary covers Bash rather than the whole runtime,
Grok's built-in profiles are not fail-closed, and none of the four offers a portable arbitrary
replacement for its repository discovery convention. Pi is the only runtime where discovery can be
fully disabled and rebuilt from explicit skill paths, yet it has no native write boundary.

## Proposed policy (two pieces)

1. **An explicit isolation capability contract at launch.** “Isolated” means the process starts in
   its agent worktree with a measured, fail-closed write boundary admitting only that worktree and
   declared runtime/scratch roots. Tachyon may advertise this for: Codex in `workspace-write` with
   unwanted temp roots excluded; Grok through a Tachyon-owned custom profile extending `workspace`;
   and Claude only with sandbox hard-failure, unsandboxed escape disabled, and `bypassPermissions`
   disabled (or all mutating non-Bash tools removed). Pi must be **refused** for required isolation
   unless the user launches Tachyon/Pi inside an explicitly supported external OS/container boundary.
   For ordinary, non-isolated launches, show a persistent runtime-specific warning rather than reuse
   isolation language. Discovery remains the runtime's documented CWD/repo convention: Tachyon owns
   only the entries it materializes and must compose or explicitly load them, never replace a shared
   project directory such as Codex's `.agents/skills`.

2. **A governed delivery exit.** Isolation covers direct agent writes, not landing. The agent
   produces and verifies a commit/tree inside its worktree; the t-7cb971 governed land door is the
   only path that moves that verified tree into the human checkout/main. Until that door exists, an
   isolation-required launch that is expected to deliver must refuse early (or be explicitly marked
   research/read-only), because confining writes without an authorized exit strands completed work.

## Actor × trigger coverage required by the policy

The capability decision must run for Interface and Agent launches across create, restart, resume,
fork, and crash recovery; Tachyon-triggered rematerialization must preserve the same boundary.
Resume/fork must not silently widen a saved session (Grok already refuses a changed resume profile).
Ad-hoc or no-worktree launches are visibly **not isolated**. Landing is a separate human/governed
trigger and never an exception granted to the running agent process.
