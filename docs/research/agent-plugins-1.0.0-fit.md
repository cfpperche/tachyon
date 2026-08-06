# Agent Plugins 1.0.0 — how much of the Tachyon plugin format fits the portable core

_Measured 2026-08-06 by `plugstd` for `t-9f97fc`. Reading and measurement only. Nothing was adopted and
nothing was implemented._

**Recommendation: do NOT adopt.** The cost of each of the three paths is in
[§8](#8-the-three-paths-with-their-cost). The reason in one sentence is in
[§9](#9-the-recommendation).

---

## 1. Method, and what "measured" means here

The specification was read from the source repository, not from the landing page.

| Source | What was read | Identity |
|---|---|---|
| `github.com/agentplugins/agent-plugins-spec` | `spec/1.0.0.md` (640 lines, all sections), `README.md`, `MAINTAINERS.md`, `GOVERNANCE.md`, `FUTURE_CONSIDERATIONS.md`, both JSON schemas | HEAD `bd383552095128f6effe895b9257cfd580a6d179`, 2026-08-06 |
| `agentskills.io/specification` | The `SKILL.md` frontmatter contract, referenced normatively by §7.1 | read 2026-08-06 |
| This repository | `src/plugins/manifest.ts`, `mcp.ts`, `mcpConfig.ts`, `skill.ts`, `paths.ts`, `engine.ts` (`loadPlugin`/`discover*`/renderers), `lockfile.ts` `TargetKind`, `adapters/claude.ts`, `adapters/codex.ts`, `adapters/hooks.ts` | worktree `plugstd` |
| SDD 486 | `spec.md` and `notes.md` | for question 2 |
| This machine | The three installed runtime binaries, and the 15 installed plugin manifests | see §6 |

Three numbers in this document come from the machine, not from a document. They are marked
**MEASURED**. Everything else is a reading of a text.

---

## 2. Corrections to the framing

The task body summarizes the standard from one reading. Five points need correction. Four are small.
One changes the answer.

### 2.1 The summary is right about who owns the standard

`MAINTAINERS.md` lists the Technical Steering Committee: Clare Liguori (Amazon), Roshan Sadanani
(Cursor), Harald Kirschner (Microsoft), Gav Verma (OpenAI), Jonathan Hefner (Vercel). The Lead Core
Maintainer is Jonathan Hefner. The framing correction in the task holds. This is not an OpenAI
standard.

### 2.2 A search result says 1.0.0 is unpublished. It is wrong

A web search on 2026-08-06 returned the claim that "Agent Plugins Specification 1.0.0 is a working
draft and has not been published". The repository refutes it. `spec/1.0.0.md` line 5 reads
**"Status: Published"**. `README.md` reads "Agent Plugins Specification 1.0.0 is the current published
release". Read the repository, not the summary.

### 2.3 `plugin.json` does not name its version in a `version` field

The task says `plugin.json` "identifies the plugin and the Agent Plugins version it targets". That is
true, but the mechanism matters. The targeted version is the **required `$schema`** field, whose value
MUST be the exact string `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` (§5.2). The
`version` field is the PLUGIN's own version, and it is optional.

The client MUST NOT fetch that schema while loading (§5.2). The identifier selects a local
implementation. It is a version token, not a network address.

### 2.4 The manifest is CLOSED, and it cannot declare components

This is the largest structural difference, and the task body does not state it.

`plugin.json` permits exactly ten top-level fields: `$schema`, `name`, `version`, `description`,
`author`, `homepage`, `repository`, `license`, `keywords`, `extensions` (§5.2). §6.1 then says
directly: "`plugin.json` cannot override these locations or contain inline component configuration."

A Tachyon manifest is the opposite. `tachyon-plugin.json` declares thirteen fields, and seven of them
declare components: `blocks`, `gitHooks`, `tools`, `data`, `externalTools`, `config`, `views`
(`manifest.ts:213`). Our manifest is a declaration document. Theirs is an identity card.

### 2.5 "The standard does not cover permissions or trust" is right, but not "no security"

The quoted sentence is accurate. `FUTURE_CONSIDERATIONS.md` confirms it, and names seven gaps:
permission and approval UX, provenance verification, secret handling, enterprise controls, audit
trail, dependency resolution, and plugin testing.

But the standard is not silent on safety. It carries four normative rules that a reader should not
miss:

1. **Path containment** (§4.1). Every package path MUST resolve inside the plugin root. Symlinks may
   not escape. The failure boundary is graded: a bad `plugin.json` rejects the plugin, a bad
   `SKILL.md` skips one skill.
2. **Transport safety** (§7.2.1). A non-loopback MCP URL MUST use HTTPS. A URL MUST NOT carry user
   information or a fragment.
3. **No secrets in the package** (§7.2.1, §9.2). "Plugins MUST NOT embed credentials or other secrets
   in `headers`", and the same rule applies to `env`.
4. **Reserved variables** (§9.2). A server `env` MUST NOT define `PLUGIN_ROOT` or `PLUGIN_DATA`. The
   client supplies both, after the configured `env` is applied.

Rules 1 and 3 are the same rules our own loaders enforce. We reached them independently.

---

## 3. The portable core, stated exactly

A plugin is a directory. It has one required manifest and components in fixed locations.

```text
my-plugin/
├── plugin.json                 # required, closed schema, 10 fields
├── skills/<name>/SKILL.md      # component type 1
├── mcp.json                    # component type 2
└── com.example.client/         # extension directory, client-owned
```

§7 states the limit in one line: "Agent Plugins v1 defines exactly two component types: **skills** and
**MCP servers**."

The Design Decisions section names what was excluded and why: "Other proposed component types — such
as commands, hooks, agents, rules, and LSP servers — remain too client-specific for a stable portable
contract and are outside the v1 format until their formats converge."

### The extension namespace gives a place, not portability

This point decides question 1, so it is stated on its own. §8 says:

> Agent Plugins assigns no portable discovery, validation, loading, or failure semantics to client
> extension data or files. Each client defines the contents and behavior of its own namespace.

A reverse-domain namespace is a reserved directory name and a reserved manifest key. It carries no
meaning to any other client. Putting a Tachyon hook in `com.example.tachyon/hooks/` makes the hook
LEGAL inside a conformant package. It does not make the hook readable by Cursor, by codex, or by
anyone else. The standard is explicit that the client owning the namespace defines everything.

So "adopt partially with an extension namespace" buys file-layout legality. It buys zero
interoperability for the things placed in the namespace.

---

## 4. Contribution-by-contribution map

Tachyon has two lists, and the task named the second one. The manifest declares twelve fields. The
lockfile's `TargetKind` (`lockfile.ts:22`) names the four things Tachyon MATERIALIZES into a place
something else reads: `settings-hook`, `skill-dir`, `mcp-server`, `view`. Both lists are mapped below.

Legend: **FITS** = expressible in the portable core with no loss. **REWRITE** = the same idea exists,
with a different schema. **NAMESPACE** = it can only live in a client extension, with no portability.
**NONE** = the standard has no place for it at all.

| Tachyon contribution | Where it lives today | Portable core | Verdict | Cost to make portable |
|---|---|---|---|---|
| skill (`skill-dir`) | `skills/<name>/SKILL.md` in the payload; materialized to `.claude/skills/`, `.agents/skills/`, `.grok/skills/` | §7.1, `skills/` | **FITS** | Two small parser changes; see §4.1 |
| MCP server (`mcp-server`) | `mcp.json` at the plugin root, `{ "servers": [...] }` | §7.2, `mcp.json`, `{ "$schema", "mcpServers": {} }` | **REWRITE** | Same file name, different schema, plus two semantic blockers; see §4.2 |
| hook (`settings-hook`) | `blocks.<runtime>/hooks.json`, each runtime's NATIVE shape | absent by decision | **NAMESPACE** | High, and it buys nothing; see §4.3 |
| `gitHooks` | manifest declaration; materialized to `.git/hooks` through a Tachyon dispatcher | absent, not even mentioned | **NONE** | Not applicable |
| `tools` | pinned per-platform artifact, sha256 on artifact AND on the extracted binary, launch policy | absent; nearest future slot is "Provenance verification" | **NONE** | Not applicable |
| `data` | pinned read-only artifact, content-addressed | absent; same future slot | **NONE** | Not applicable |
| `externalTools` | detect, assisted install per package manager, manual guidance | absent; the nearest thing is the Agent Skills `compatibility` free-text field | **NONE** | Not applicable |
| `config` | a human-owned payload file plus an optional JSON Schema file | absent; nearest future slot is "Secret and sensitive value handling" | **NAMESPACE** | Medium, no portability |
| `views` | HTML entry, surface, fleet scope, action allowlist | absent, and no future slot names it | **NAMESPACE** | Medium, no portability |
| `dependencies` (`name@range`) | manifest | absent; a named future consideration | **NONE** | Not applicable |
| `runtimes` | manifest; decides which runtimes the plugin installs into | absent; the standard assumes one client | **NONE** | See §4.4 |
| `docsUrl` | manifest, HTTPS only | `homepage` | **FITS** | Rename |
| `name` | lowercase kebab, leading letter required | 1-64 chars, `a-z 0-9 - .`, alphanumeric at both ends, no `--` or `..` | **REWRITE** | Widen our charset, or narrow theirs on read |
| `version` | required, strict semver | optional, semver only RECOMMENDED, and a client MUST NOT reject a non-semver value | **REWRITE** | Relax on read, keep strict on author |
| `description` | required, single line | optional | **FITS** | None |

**Count over the fifteen rows: three map cleanly, three need a rewrite, three can only sit in a private
namespace, and six have no place at all.**

### 4.1 Skills — the one clean fit

Our skill layout already matches the standard. `skills/<name>/SKILL.md`, one skill per immediate
subdirectory, no recursive search (`engine.ts` `discoverSkills`). §7.1 asks for exactly that.

Our frontmatter parser (`skill.ts`) reads only `name` and `description`, and it ignores every other
key. That is the permissive behavior a third-party skill needs. A skill carrying `license`,
`compatibility`, `metadata`, or `allowed-tools` loads here without complaint.

Our rule "the frontmatter `name` MUST equal the directory name" (`engine.ts` `discoverSkills`) is not
an extra restriction. The Agent Skills specification states the same rule: "Must match the parent
directory name."

Two real divergences, both small:

- **Leading character.** `SKILL_NAME_RE` in `skill.ts` requires a leading letter. Agent Skills allows
  `a-z` and `0-9`. A conformant skill named `3d-render` is REJECTED here.
- **Size cap.** We cap `SKILL.md` at 64 KB and `skills/` at 64 entries. The standard sets no cap. A
  cap is a client decision, so this is legal, but it can reject a conformant package.

Neither divergence is measured against a real skill. No installed skill on this machine uses a leading
digit.

### 4.2 MCP servers — same file name, incompatible schema

Both formats put a file called `mcp.json` at the plugin root. The contents disagree on every level.

| Aspect | Tachyon (`mcp.ts`) | Agent Plugins 1.0.0 (§7.2) |
|---|---|---|
| Top level | `{ "servers": [ ... ] }`, an ARRAY; any other key is fatal | `{ "$schema", "mcpServers": { ... } }`, an OBJECT keyed by name; any other key is fatal |
| Server identity | a `name` field inside each entry | the member name |
| Transport field | `transport`, values `stdio` or `http` | `type`, values `stdio`, `streamable-http`, or `sse` |
| Remote transports | one `http`, no distinction | Streamable HTTP and legacy HTTP+SSE are DIFFERENT values |
| `command` | a bare token, or a leading `${PLUGIN_ROOT}/…` | a bare token, or a `./…` plugin-relative path. Placeholder expansion in `command` is FORBIDDEN |
| `args` | literals, or a leading `${PLUGIN_ROOT}/…` | `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand at EVERY occurrence |
| `env` values | MUST be an exact `${VAR}`, and the variable MUST have the key's own name | literal strings. `PLUGIN_ROOT`/`PLUGIN_DATA` keys are forbidden |
| `cwd` | not represented | supported, with three legal forms |
| `headers` | MUST reference a `${VAR}`; a literal is rejected | literal only. Expansion is FORBIDDEN |
| URL scheme | `http:` or `https:` | HTTPS, except a loopback host |

Two of those rows are not translation problems. They are opposite rules.

**Blocker A — secrets.** Our `env` rule exists so that no secret is ever written to disk, and so that
a value maps losslessly onto both runtimes. The codex renderer proves why: it emits
`env_vars = ["KEY"]`, which forwards a variable BY NAME from codex's own environment
(`adapters/codex.ts:59-83`). It cannot express a literal value at all.

The standard requires the opposite: a literal, with no expansion of any kind
(§9.2, "Clients MUST NOT perform any other placeholder or environment-variable expansion").

The consequence is concrete and it runs in both directions:

- A legal standard server with `"env": { "LOG_LEVEL": "debug" }` is REJECTED by `mcp.ts` `validEnv`.
- A legal Tachyon server with `"env": { "API_TOKEN": "${API_TOKEN}" }` is legal JSON under the
  standard, but a conformant client passes the eleven characters `${API_TOKEN}` to the subprocess.

The second case is the dangerous one. It fails silently, and it fails as a broken credential.

**Blocker B — `PLUGIN_DATA` does not exist here.** §9.1 requires a client that launches a stdio server
to supply a writable per-plugin directory, to create it before launch, and to preserve it across plugin
updates. Tachyon has no such directory. Our `tools` and `data` directories are content-addressed and
read-only by design.

**A defect found while measuring this.** Our `${PLUGIN_ROOT}` is validated in `mcp.ts` and it is never
substituted, and the variable is never exported. The MCP renderers pass `command` through verbatim
(`adapters/claude.ts:44-57`, `adapters/codex.ts:59-83`), and the only plugin-root substitution in the
repository is the HOOKS one, which uses a different name, `${TACHYON_PLUGIN_ROOT}`
(`adapters/hooks.ts:21`, applied at `:231`). Filed as **`t-b6180e`**, kind `bug`, with the evidence.
It is invisible today because no installed plugin ships an `mcp.json` (§6).

### 4.3 Hooks — the case that looks like a namespace and is not

A Tachyon hook contribution is `blocks.<runtime>` pointing at a directory that holds that runtime's
NATIVE `hooks.json`. The manifest comment states the design: "a Tachyon plugin is an AGGREGATE of each
runtime's NATIVE config block (no cross-runtime abstraction)" (`manifest.ts:10-12`).

So a hook is already client-specific twice over. It is specific to Tachyon, and inside Tachyon it is
specific to one runtime. Placing it under `com.example.tachyon/` satisfies §8, and it changes nothing
else. No other client can read a claude hooks block from our namespace, and Tachyon itself would read
the same bytes it reads today from a different path.

The standard's own reason for deferring hooks is the same reason we never made them neutral: the
formats have not converged.

### 4.4 `runtimes` — the field with no counterpart, and why

The standard says "Client" in the singular. §11.1 defines a conformant client as one process that
loads a directory and runs its components.

Tachyon is not that. Tachyon serves three runtimes at once, and a plugin declares which of them it
supports. `resolveCompat` then reports which declared runtimes are actually present in the workspace
(`manifest.ts:1180`).

This is the architectural difference underneath every row of the table, and it is stated fully in §5.

---

## 5. The difference that decides the study: Tachyon PROJECTS, it does not LOAD

The standard's model is one process reading a directory:

> A client is "a tool that discovers, installs, loads, and executes plugin components" (§3).

Tachyon's model is different. The install engine copies the payload to
`.tachyon/plugins/<name>/`, and then materializes each contribution into the place a DIFFERENT program
reads:

- a skill directory is copied into `.claude/skills/`, `.agents/skills/`, `.grok/skills/`
- a hook entry is merged into the runtime's settings file
- an MCP server is merged into `.mcp.json` or into `[mcp_servers.<name>]` in `.codex/config.toml`

The lockfile exists because each of those merges must be exactly reversible (`lockfile.ts`
`TargetKind`, and `mcpConfig.ts` `currentMcp`, which leaves a user-edited server as an orphan rather
than clobbering it).

The reader of a Tachyon plugin is never Tachyon. It is claude, or codex, or grok.

This has one consequence, and it answers the product question by itself: **conforming to the standard
would not remove one line of translation work.** A perfectly conformant third-party plugin still has to
be rewritten into each runtime's native configuration before any runtime can use it. The standard tells
us how to READ the package. The whole cost is in the WRITE.

---

## 6. Who consumes this, today, on this machine — MEASURED

The task asks the right question: who benefits? Three measurements answer it.

### 6.1 codex 0.146.1 already implements the standard — MEASURED

The codex binary installed on this host contains an Agent Plugins manifest reader.

Method: `strings` and `grep -a` over
`~/.nvm/versions/node/v24.11.1/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
No codex process was started for this, apart from `codex plugin --help`.

Found:

- a module path `core-plugins/src/agent_plugin_manifest.rs`
- a struct `RawAgentPluginManifest` with nine members, and `RawAgentPluginAuthor` with
  `name`/`email`/`url` — the standard's manifest, exactly
- the literal `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, and a prefix match on
  `https://agent-plugins.org/schemas/`
- the diagnostics `ignoring unknown Agent Plugins manifest field` and
  `ignoring non-object Agent Plugins 'extensions' field` — which is precisely the non-fatal behavior
  §5.2 and §8.1 require
- the error `Agent Plugins root 'plugin.json' must contain a JSON object`
- the extension namespace `com.openai`
- alongside it, the paths `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, and
  `.cursor-plugin/plugin.json` — codex reads three client-specific formats AND the portable one

`codex plugin --help` reports the install surface: `add`, `list`, `marketplace`, `remove`. Distribution
and installation are codex's, exactly as the standard reserves them.

**This is the version running on this host right now.** It is the version the 2026-08-06 measurement
incident left installed (`docs/specs/486-plugin-apply-vs-install/notes.md`, "Measurement residue").

### 6.2 claude 2.1.223 and grok 0.2.118 do not — MEASURED

Same method, same date.

| Runtime | `agent-plugins` | `.claude-plugin` | `plugin.json` |
|---|---|---|---|
| claude 2.1.223 | **0** | 74 | 65 |
| codex 0.146.1 | 1 | present | 63 |
| grok 0.2.118 | **0** | 3 | 11 |

claude and grok both implement claude's own plugin format, `.claude-plugin/plugin.json`. That path is
NOT the standard's, which requires `plugin.json` at the plugin ROOT (§5.1). Neither binary mentions the
standard.

Two of the three runtimes Tachyon serves have not adopted it. One has.

### 6.3 What the installed fleet actually declares — MEASURED

Counted in `/home/goat/tachyon/.tachyon/plugins/` on 2026-08-06. Fifteen plugins.

| Fact | Count |
|---|---|
| plugins installed | 15 |
| plugins shipping a `skills/` directory | 12 |
| skills, total | 12 (one each) |
| plugins shipping an `mcp.json` | **0** |
| plugins declaring `externalTools` | 7 |
| plugins declaring `tools` | 3 |
| plugins declaring `data` | 2 |
| plugins declaring `config` | 2 |
| plugins declaring `gitHooks` | 2 |
| plugins declaring `dependencies` | 2 |
| plugins declaring `blocks` (runtime hooks) | 1 |
| plugins declaring `views` | 1 |

The decisive number: **exactly one of the fifteen — `sdd` — declares nothing outside the portable
core.** It ships one skill and metadata, and nothing else. Every other plugin would lose function if it
were reduced to `plugin.json` plus `skills/` plus `mcp.json`.

Three plugins — `secrets-guard`, `verify-gate`, `terrarium` — have NO portable content at all. They
ship hooks, git hooks, and a view.

The MCP path is worse than unused: it is untested in production. Zero plugins exercise the code whose
schema the standard would ask us to change. That is also why the `t-b6180e` defect survived.

---

## 7. The verdict on each question in the task

### Q1 — how much of our format fits the portable core?

**Three of fifteen mapped facts fit, and one of four `TargetKind`s.** The full map is in §4.

Of the four things Tachyon materializes, `skill-dir` fits, `mcp-server` needs a schema rewrite, and
`settings-hook` and `view` have no portable expression.

Skills fit, and they fit well enough that a third-party skill loads here today with two narrow
exceptions (§4.1). MCP servers are the same idea with an incompatible schema and two opposite rules
(§4.2). Hooks, git hooks, tools, data, external tools, config, views, dependencies, and runtimes have
no portable expression.

The task asked whether hooks, tools, and views "fit in the namespace or are incompatible". The answer
is neither, and the third option is the one that matters: they fit in the namespace, and the namespace
carries no portability (§3). §8 states that the standard assigns no discovery, validation, loading, or
failure semantics to anything in a client namespace.

### Q2 — what does SDD 486 gain or lose?

**It loses nothing. It gains one vocabulary confirmation and no name.**

486 separates installed / applied to the workspace / delivered to an agent. The standard reserves
"distribution, installation, permissions, user experience" to the client. So the two do not overlap,
and 486 is safe from the standard by construction.

The task asks whether 486 could adopt the standard's names instead of inventing synonyms. **It cannot,
because the standard does not define the names 486 needs.** The words checked, one by one:

- "install" — used, never defined. §3 names it inside the definition of Client. §9.1 says "installed
  plugin instance" and "uninstalled" without defining either. There is no install lifecycle to borrow.
- "apply", "un-apply" — absent in 486's sense. The word "apply" appears three times, and every time it
  means "apply a rule" (§4.1, §9.2, §11.3).
- "enable" — absent. "disable" appears once, at §7.2.2: a client "MUST disable MCP for that plugin"
  when `mcp.json` is invalid. That is a load-failure action, not a human decision. The user-facing
  sense appears only in `FUTURE_CONSIDERATIONS.md`, as a field of an audit event schema that a future
  version MAY define.
- "plugin root", "manifest", "component", "extension namespace" — defined (§3), and 486 does not need
  them.

One term IS worth taking. §3 defines **Component** as "a skill or MCP server entry supplied through a
component type standardized by this specification". 486's own table calls the same thing a
"contribution" (`spec.md`, the `TargetKind` table). The concepts match, and adopting "component" for
what a plugin supplies would align our word with a published standard at zero cost.

The word is a suggestion, not a finding. 486 loses nothing if it keeps "contribution".

`notes.md` records one decision that touches this: the applied record lives at
`.tachyon/plugins-applied.json` as a SIBLING of `.tachyon/plugins/`, because "a plugin name may contain
a dot". That assumption is FALSE today — `NAME_RE` in `manifest.ts:16` forbids dots — and it would
become TRUE if we ever adopted the standard's name rule, which permits them (§5.5). The decision is
right either way. The stated reason only becomes true after an adoption that this document recommends
against.

### Q3 — would adopting the format make third-party plugins consumable here?

**No. And the reason is not the manifest.**

The manifest is the cheap part. A conformant `plugin.json` reader is small: ten fields, a closed
schema, one name regex, non-fatal handling of unknown keys, and the containment rule we already have in
`paths.ts`. Call it 150 to 200 lines against `manifest.ts`'s 1188, because none of the expensive
parsing — tools, data, external tools, launch policy, views — exists in the standard at all.

The `mcp.json` reader is not cheap, and the cost is not in the parser either. It is in the two opposite
rules of §4.2. Reading a conformant `mcp.json` means either dropping our secret-by-reference guarantee,
or rejecting conformant plugins that use a literal `env`. There is no third option, because the two
rules contradict.

But the deciding reason is §5. Tachyon does not load plugins. It projects them into three runtimes'
native configurations. A conformant package still needs every line of that translation. Reading
`plugin.json` removes no work; it only replaces our own manifest read, which already works.

And the consumer question answers itself in the wrong direction. A third-party Agent Plugins package
ALREADY reaches this machine today — through codex, which reads the standard itself and installs
through its own marketplace (§6.1). Tachyon adding a reader would duplicate a path that codex owns and
maintains.

**A third-party plugin published for Cursor or for codex is not installable here without translation.
The task says that if the answer is no, the rest is academic. The answer is no.**

### Q4 — and the reverse direction?

**The cost is real, and the payoff is one plugin.**

To publish a Tachyon plugin as a conformant package we would need, at minimum:

1. A root `plugin.json` with the required `$schema`. Our `tachyon-plugin.json` then either duplicates
   its metadata or moves under `extensions`.
2. A resolution of the `mcp.json` name collision. Two different schemas cannot share one path. Either
   we rename our payload file, or we adopt theirs and rewrite `mcp.ts` and both renderers.
3. A reverse-domain namespace based on a domain we control (§8 says SHOULD). **Not measured: whether
   this project owns a suitable domain.** That is a question for the maintainer, not a finding.
4. Our plugin names widened, or third-party names narrowed on read (§4, `name` row).

And then the cost that is not code: **`tachyon-plugin.json` becomes a public contract.** Today its
shape is ours, and `manifest.ts` changes when a specification says so — spec 250, 251, 264, 265, 269,
270, 271, 284, 285, 289, 349 all changed it. Published under a namespace, each of those changes becomes
a compatibility event for whoever installed the plugin elsewhere.

The payoff, measured: of fifteen installed plugins, **one** (`sdd`) is fully expressible in the
portable core, and **three** have no portable content at all (§6.3). The other eleven would publish as
a skill with their tools, data, external tools, or config silently missing — which is worse than not
publishing, because the skill would install and then fail at first use.

### Q5 — where our experience is larger than the standard

The standard names its own gaps in `FUTURE_CONSIDERATIONS.md`. Four of the seven are places where this
repository has already paid for an answer. This is the part worth keeping, and the part worth
contributing if the project ever participates.

| Standard's future item | What Tachyon already has | Evidence |
|---|---|---|
| Permission and approval UX | Install ≠ apply ≠ delivered to an agent, each with an owner and a moment | SDD 486 `spec.md` |
| Permission and approval UX | The client's switch is NOT the arming decision. codex holds a project hook at `Review` behind a `trusted_hash` in `~/.codex/config.toml`; grok holds one behind folder trust in `~/.grok/trusted_folders.toml` | `486/notes.md`, A1b, measured 2026-08-06 (`t-5d219f`) |
| Permission and approval UX | A hook set can be FROZEN at session start. On codex and on grok a removed hook keeps firing, and a REPLACED hook file still runs the original command. claude re-reads live | `486/notes.md`, A1b part (i) |
| Provenance verification | Author-pinned artifacts with a sha256 on the download AND a second sha256 on the extracted binary; an optional host-binary hash gate | `manifest.ts` `ToolDecl`, `ToolArchive` |
| Provenance verification | A launcher-enforced launch policy: forced env, forced args, refused args, scrubbed env, and a parse-time refusal of loader-hijacking variables (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, …) | `manifest.ts` `parseLaunchPolicy`, `DANGEROUS_ENV_KEYS` |
| Secret and sensitive value handling | Secrets by reference, never by value. An `env` value MUST be an exact `${VAR}` naming its own key, because that is the only shape both runtimes can express losslessly | `mcp.ts` `validEnv`; `adapters/codex.ts` `env_vars` |
| Dependency resolution | `name@range` with self-dependency rejection and duplicate detection | `manifest.ts` `parseDep` |
| Audit-trail standardization | The lockfile as an exact removal identity, including content-aware removal that leaves a user-edited server as an orphan rather than overwriting it | `lockfile.ts`, `mcpConfig.ts` `currentMcp` |

The strongest single item is the third row, and it is not in the standard's list at all. The standard
assumes a client's decision reaches the component. Our measurement shows that on two of three runtimes
it does not, until the session restarts. Any future permission model that ignores this will describe a
switch that does not switch.

---

## 8. The three paths with their cost

Each path is stated with the cost and the named consumer, as the task requires.

### Path A — adopt the format

**What it means.** Root `plugin.json` with `$schema`. Our `mcp.json` schema replaced by the standard's.
`PLUGIN_ROOT` and `PLUGIN_DATA` supplied and expanded per §9. Everything else under a reverse-domain
namespace.

**Cost.**
- A `plugin.json` reader and validator: small, 150 to 200 lines.
- `mcp.ts` rewritten, plus both renderers, plus the lockfile's MCP removal identity. The secret rule
  must be resolved in one direction or the other; there is no compatible middle (§4.2, Blocker A).
- A new `PLUGIN_DATA` directory with a lifecycle: created before launch, writable, preserved across
  updates, removed on uninstall. We have no such concept (§4.2, Blocker B).
- Every existing plugin repository re-published with a second manifest.
- `tachyon-plugin.json` becomes a public contract (Q4).
- The `${PLUGIN_ROOT}` defect (`t-b6180e`) must be fixed first, because the standard makes the variable
  a client obligation.

**Consumer.** Nobody on this machine. Tachyon does not load plugins, so it gains no code path it does
not already have (§5). codex already reads the standard by itself (§6.1).

### Path B — adopt partially, with an extension namespace

**What it means.** Ship a conformant `plugin.json` and `skills/`, and put hooks, tools, data, external
tools, config, and views under `com.<domain>.tachyon/`.

**Cost.** Everything in Path A except the MCP rewrite, plus the namespace layout, plus a domain we must
control and must keep stable. Roughly half of Path A.

**Consumer.** A future third-party author who wants one package readable by both codex and Tachyon —
and only for its skills. §8 guarantees that everything in our namespace stays invisible to every other
client (§3). Of our fifteen installed plugins, one would publish complete and three would publish
empty (§6.3).

### Path C — do not adopt

**What it means.** Keep `tachyon-plugin.json` and our `mcp.json`. Record the measurement. Re-read the
standard when 1.1 defines hooks, or when claude and grok adopt it.

**Cost.** Two follow-ups, both small, and neither is adoption:

1. **`t-b6180e`** — the unsubstituted `${PLUGIN_ROOT}` in the MCP payload. This is a defect whether or
   not the standard exists. Filed with evidence.
2. **The `mcp.json` name collision** is a latent trap. Our file and the standard's file have the same
   name, the same location, and incompatible schemas. If any Tachyon plugin repository is ever also
   published as an Agent Plugins package, one of the two readers silently gets the wrong document. No
   task is filed for this, because renaming a payload file is a migration, and the collision is
   harmless while nobody publishes both. It is written here so the next reader finds it.

**Consumer.** The maintainer, who keeps a format that serves three runtimes and pays nothing for a
standard that serves one client. And the eleven plugins that would lose function under Path A or B.

---

## 9. The recommendation

**Do not adopt.** Path C.

The one-sentence reason: **the standard defines how to READ a plugin package, and every cost Tachyon
pays is in WRITING one — into three runtimes' native configurations — so conforming would change our
input format and remove none of our work.**

The three supporting facts, each measured rather than argued:

1. Of fifteen installed plugins, one is fully expressible in the portable core and three have no
   portable content at all (§6.3).
2. A third-party conformant plugin is NOT installable here without translation, because Tachyon
   projects rather than loads (§5). The task states that if this answer is no, the rest is academic.
   It is no.
3. The standard has already reached this machine without us. codex 0.146.1 reads root `plugin.json`
   against the 1.0.0 schema (§6.1). Adding our own reader would duplicate a path codex owns.

**What would change this verdict.** Two events, and each is observable without new work:

- The standard defines hooks as a component type. `FUTURE_CONSIDERATIONS.md` does not list hooks, and
  the Design Decisions section says they stay out "until their formats converge". Watch the version
  number, not the discussion.
- claude or grok ships a reader for root `plugin.json`. Today neither binary contains the string
  `agent-plugins` (§6.2). One `grep -a` on a new release re-runs that measurement in a second.

Until then, the honest position is the one the standard itself takes: the portable core is small on
purpose, and everything Tachyon has learned this year lives in the space the standard reserves to the
client.

---

## 10. What I could not measure

Said out loud, as the contract requires.

1. **Whether codex 0.146.1 reads the standard's `mcp.json`.** The binary contains both `mcp.json` and
   `.mcp.json` in adjacent string data, and a string table gives no boundary. The manifest reader is
   proven. The MCP half is not. Deciding it needs a real conformant plugin installed into codex, which
   would write to the maintainer's `~/.codex/config.toml`. Not done, and out of scope.
2. **Whether this project owns a domain suitable for a reverse-domain namespace.** §8 says a client
   SHOULD base its namespace on a domain it controls. This is the maintainer's answer, not a
   measurement.
3. **Whether any published Agent Plugins package exists in the wild.** Not searched. The recommendation
   does not depend on it: even a large ecosystem would still need the translation described in §5.
4. **Whether claude's `.claude-plugin/plugin.json` and the standard's root `plugin.json` share a
   schema.** Only the path difference was measured. The two paths are certainly different (§6.2).
5. **The behavior of a conformant client that receives our `env: {"K": "${K}"}`.** §9.2 says no
   expansion, so the literal reaches the subprocess. That is a reading of the text, not an observation
   of a client.
6. **No visual evidence.** This work has no UI surface, so the headless browser harness does not apply.

---

## Sources

- Specification repository: `https://github.com/agentplugins/agent-plugins-spec`, HEAD
  `bd383552095128f6effe895b9257cfd580a6d179`, read 2026-08-06.
- Agent Skills specification: `https://agentskills.io/specification`, read 2026-08-06.
- Landing page: `https://agent-plugins.org/`, read 2026-08-06.
- Runtime measurements: this host, 2026-08-06 — claude 2.1.223, codex 0.146.1, grok 0.2.118.
- Prior measurement reused, not repeated: `docs/specs/486-plugin-apply-vs-install/notes.md` (`t-5d219f`).
