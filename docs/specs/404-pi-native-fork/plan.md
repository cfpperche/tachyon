# 404 — pi-native-fork — implementation plan

## Runtime findings

Pi v0.80.10 supports `--fork <path|id>` and allows it together with `--session-id <new-uuid>`. `SessionManager.forkFrom()` creates a new JSONL in the destination session directory, rewrites the header to the new UUID/canonical cwd, sets `parentSession` to the source path, and copies the source active branch. Passing an absolute validated path avoids cross-private-home ID discovery.

Pi emits `session_start` for startup, new, resume and fork, exposing exact session ID/file/cwd through the extension context. The bundled extension can append the same bounded ownership rows consumed by Tachyon's existing ownership ledger.

## Design

1. Extend the bundled Pi extension with a no-secret `session_start` ownership recorder keyed by Tachyon-controlled environment variables.
2. Inject the ownership-ledger path for managed Pi extension launches; preserve Bridge behavior and reviewer restrictions.
3. Add Pi's native fork command shape to the resume adapter.
4. In Fork source resolution, require the latest positive Pi ownership row, validate its exact transcript through the existing bounded/no-follow Pi resolver, and carry its canonical path as the native fork source reference.
5. Mint a fresh UUID for the Pi destination. Materialize B's normal private runtime home before launch, compose `--session-id B --fork '<A-path>'`, then apply extension/Bridge wiring.
6. Persist B's exact UUID and private config home so ordinary Resume remains independent from A.
7. Compensate a newly-created Pi private home on pre-spawn/failed-spawn paths when no live recovery session remains; preserve existing worktree quarantine semantics.
8. Add adapter, extension, AgentManager, private-home, Bridge and real-Pi A→B→resume tests/dogfood.
9. Promote Pi Fork parity only after human Dev Host confirmation.

## Safety invariants

- Source authority is `(agent, canonical cwd, exact UUID, exact private-home transcript path)` from a positive extension event.
- Every source validation is re-run at commit after confirmation.
- `--fork` receives only a shell-quoted path returned by the no-follow header resolver.
- Destination UUID is minted before launch and must differ from source UUID.
- Target home is materialized through the same Pi private-home path as ordinary spawn; no source auth/settings/session directory is shared.
- No new fallback to newest transcript, terminal text, sibling cwd or global Pi home.
