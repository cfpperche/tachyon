# Spec 250 — Sourcing (Step 5b): where a plugin comes from

_Design agreed 2026-06-23 (maintainer + codex design dueto). v1 = git-based, remote-only. The registry/marketplace (resolve `name@version` → a git ref) is v2, built ON TOP of this — the fetch stays git._

## Goal

Take a **remote source-spec** → produce a local plugin **dir** that the existing `loadPlugin(dir)` + install engine consume. The dir is a transient, verified download **cache** (never a "local source"); the engine then copies the validated payload into the workspace (committed by default). No local-path source in v1.

## Two layers

1. **Resolver (pure, no I/O — this increment):** parse a source-spec string → a normalized `GitSource` struct (or accumulated errors). Fully unit-testable without a network or a git binary.
2. **Fetcher (I/O — next increment):** given a `GitSource`, clone/fetch into the global content-addressed cache, verify, and return the plugin dir for `loadPlugin`.

## Source-spec grammar (v1, locked)

```
github:<org>/<repo>@<ref>[#path=<subdir>]
git+https://<host>/<path>/<repo>.git@<ref>[#path=<subdir>]
```

- **`github:`** is sugar → `git+https://github.com/<org>/<repo>.git`.
- **`@<ref>` is REQUIRED** — a tag, branch, or 40-hex commit SHA. No silent default-branch install (D1: floating must be explicit). A user who genuinely wants the default branch writes `@HEAD` (recorded as a floating intent, distinct from the resolved SHA the fetcher will pin).
- **`#path=<subdir>`** (optional) — a contained POSIX-relative subdir; the plugin root (where `tachyon-plugin.json` lives) is that subdir. The `#path=` delimiter is unambiguous vs `@`/`/` inside refs and paths (D2; the `org/repo/path@ref` shorthand is rejected).
- Out of v1: SSH (`git+ssh://`, SCP-style `git@host:…`), local path, registry `name@version`.

## `GitSource` (resolver output)

```ts
interface GitSource {
  kind: "git";
  spec: string;          // the original source-spec, verbatim (provenance)
  remote: string;        // normalized clone URL, e.g. https://github.com/org/repo.git
  ref: string;           // the ref as written (tag / branch / SHA / "HEAD")
  refKind: "sha" | "named" | "head"; // sha=40-hex pinned; named=tag-or-branch; head=floating default
  subdir?: string;       // contained POSIX-relative path, when #path= given
}
```

## Decisions (ratified 2026-06-23)

- **D1 — `@ref` required; floating only via explicit `@HEAD`.** The resolver classifies the ref (`sha`/`named`/`head`); the lockfile later records both the written ref AND the fetcher-resolved SHA, so reinstall is byte-reproducible while update semantics stay honest.
- **D2 — subdir via `#path=`, not a path shorthand.** Contained-relative (reuses `paths.ts` containment: no `..`, no absolute, no backslash). The manifest lives directly inside the subdir.
- **D3 — cache is GLOBAL, content-addressed, verified on every use** (fetcher increment): `~/.tachyon/plugin-cache/git/<remoteHash>/<commitSha>/`; per-remote/SHA lock; clone to temp → verify → atomic rename; re-hash payload on every cache hit; mismatch → evict + refetch once → else fail-closed. Keeps the workspace repo 100% clean of the download.
- **D4 — supply-chain fail-closed (fetcher increment):** reject submodules/gitlinks; LFS pointers → fail with a clear message (no `lfs pull`); the existing `preflightPayload` (no symlinks, bounded bytes/files/depth) still gates the materialized dir.

## Integrity + lockfile provenance (fetcher increment, recorded here for the contract)

The lockfile `source` becomes a struct, and `integrity` hashes the **materialized payload** (the content hash `preflightPayload` already computes — NOT the git tree/commit, since subdir extraction means the SHA doesn't prove the installed bytes):

```jsonc
"source": { "type": "git", "spec": "...", "remote": "...", "ref": "v1", "resolvedCommit": "abc…", "subdir": "plugins/foo" },
"integrity": { "algorithm": "sha256", "payload": "sha256-…" }
```

Tag-movement policy (fetcher/updater): reinstall-from-lock uses the locked SHA (no re-resolve); update-from-branch re-resolves + shows old→new + preview; **a tag that now resolves to a different SHA is suspicious → requires explicit accept/force**.

## Risks → v1 mitigations (fetcher increment)

- **Auth hanging the extension** → git with interactive prompts disabled; emit `AUTH_REQUIRED: <host>`, never prompt inside a hidden process.
- **Huge repo before payload bounds apply** → `ls-remote` + shallow + sparse-checkout of `#path` + clone timeout + cache-entry size cap.
- **Remote trust** → the install preview must surface remote + ref + resolved SHA + subdir + the hooks/scripts being installed (remote install is higher-risk than a reviewed local dir).
- **Cache poisoning** → never install from cache without recomputing the payload hash; fail-closed on mismatch.

## Acceptance

- **This increment (resolver):** `parseSource(spec)` → a validated `GitSource` or accumulated errors; fail-closed; never throws; never touches the network/fs. Covers: `github:` sugar → normalized remote; `git+https://`; required `@ref` (reject when missing); ref classification (sha/named/head); `#path=` containment (reject `..`/absolute/backslash); rejected forms (SSH, local path, the `org/repo/path@ref` shorthand, bad host). Unit tests for each.
- **Next increment (fetcher):** clone→verify→cache→loadPlugin against a real git repo (smoke); lockfile `source`+`integrity`; submodule/LFS rejection; AUTH_REQUIRED surfacing.
