# Runbook — create, update and publish a plugin

_Written 2026-08-09, after I got the publish wrong and the maintainer had to send me a screenshot._

Covers the **`cfpperche/tachyon-plugins`** repository (local checkout at `/home/goat/tachyon-plugins`)
and how Tachyon consumes it.

## The mistake this exists to prevent

I committed, ran `git push origin main`, told the maintainer it was published — and it was not. The
Plugins panel kept showing `sdd v1.8.0 · up to date`.

**Pushing `main` publishes nothing.** Tachyon pins a **tag**:

```
github:cfpperche/tachyon-plugins@v2.4.0#path=sdd
```

With no new tag the installer has nothing to see. Publishing *is* cutting the tag.

## How Tachyon consumes it

`.tachyon/plugins.lock.json` — **not tracked in git**; it is this workspace's local state:

```json
"source": {
  "type": "git",
  "spec": "github:cfpperche/tachyon-plugins@v2.4.0#path=sdd",
  "ref": "v2.4.0",
  "resolvedCommit": "5861702527849fff2ce1896654d0e3e0012b3f6d",
  "subdir": "sdd"
},
"integrity": { "algorithm": "sha256", "payload": "0922…409d" }
```

Two consequences worth stating, because both cost time when learned the hard way:

- **The tag is the pointer; the commit and the sha256 are the proof.** Moving an existing tag to a
  different commit breaks integrity for anyone who already installed it. Never move a tag — cut the
  next one.
- **A plugin's version and the repository's tag are different things.** The repository is `v2.x.y`;
  each plugin carries its own `version` in `tachyon-plugin.json`. `sdd` going `1.8.0 → 1.9.0`
  produced repository tag `v2.4.0`.

An installed plugin is materialized at `.tachyon/plugins/<name>/`, and each runtime gets its own
target — `.claude/skills/<name>`, `.agents/skills/<name>`, `.grok/skills/<name>`.

## Update an existing plugin

```sh
cd /home/goat/tachyon-plugins
# 1. edit the plugin's files
# 2. bump ITS version, in its own manifest
#    sdd/tachyon-plugin.json → "version": "1.9.0"
git add -A && git commit
git push origin main          # runs the gate below — still does NOT publish
git tag -a vX.Y.Z -m "…"      # THIS publishes
git push origin vX.Y.Z
```

Then, in Tachyon: **Plugins** panel → update. The lock rewrites `ref`, `resolvedCommit` and
`integrity`.

**Confirm it landed:** the panel shows the plugin version and the tag. If it still reads `up to date`
on the old version, the tag was not pushed.

## The gate on push

`.githooks/pre-push` (the repo sets `core.hooksPath=.githooks`) runs
`./scripts/validate-manifests.sh` and refuses the push **when the destination is `main`/`master`**. A
push to a topic branch costs nothing.

Its header records why it exists, and it is worth reading before trying to work around it:

> `t-d8e772` — publishing had no forcing function: verify-gate v1.0.0 was tagged and released in a
> shape that could not install anywhere, and only a human trying to install it found out.

A broken package was discovered only by someone trying to install it, and after the tag the fix is a
republish. If the hook refuses, the package really is broken.

**Known limit, and it is the same hole I fell into:** the hook covers the push of `main`. It does
**not** cover the tag. Nothing stops tagging a commit that never went through `main`.

## Create a new plugin

A plugin is a directory at the repository root containing `tachyon-plugin.json`. The smallest real
example is `hello-marker/`, which exists precisely to exercise install/wire/update/remove without
touching security or project state. Copy its shape.

```json
{
  "name": "<name>",
  "version": "1.0.0",
  "description": "…",
  "runtimes": ["claude", "codex", "grok"],
  "docsUrl": "https://github.com/cfpperche/tachyon-plugins/tree/main/<name>",
  "blocks": { "claude": "claude/", "codex": "codex/" }
}
```

- `runtimes` is a verifiable promise: declare only what you tested. A runtime declared and not
  delivered is worse than one left out.
- A **skill** ships as `skills/<name>/SKILL.md` (+ `scripts/`, `templates/`) and the installer
  projects it into each runtime's directory. That is `sdd`'s shape.
- **Hooks, git-hooks and tools** ship through per-runtime `blocks`. That is `secrets-guard`'s shape.
- Run `./scripts/validate-manifests.sh` before committing; it is the same command the gate runs.

Then the same flow: commit → push `main` → **tag** → push the tag.

## Version semantics, in practice

| change to the plugin | plugin version | repository tag |
|---|---|---|
| fix that does not change the contract | patch | patch |
| new verb or option, compatible | minor | minor |
| verb removed, format changed, runtime dropped | major | major |

The repository's bump follows the **largest** bump among the plugins in that tag.

## Where this usually goes wrong

| symptom | cause |
|---|---|
| panel says `up to date` on the old version | the tag was not pushed — `git push origin vX.Y.Z` |
| install fails on integrity | an existing tag was moved; cut the next one instead |
| a runtime has no skill | `runtimes` declares a runtime the package does not deliver |
| push to `main` refused | the package does not load in Tachyon's parser; fix it, do not work around it |

## References

- `README.md` in `tachyon-plugins` — the catalogue and what each package combines
- `.githooks/pre-push` and `scripts/validate-manifests.sh` — the gate
- `.tachyon/plugins.lock.json` — what this workspace has installed, with commit and sha256
