# 189 — tachyon-fixed-port-idempotent-registration — plan

_Drafted from `spec.md` on 2026-06-09. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

(1) `Bridge.start(preferredPort?)` — try the preferred port, on EADDRINUSE listen(0) and expose `usedFallback`; `derivePort(wsHash)` = 41000 + first-4-hex-digits % 2000. (2) loadConfig/schema gain `settings.bridgePort` (1024–65535). (3) adapters gain `claudeAlreadyRegistered`/`opencodeAlreadyRegistered` + per-offer `upToDate`; extension's connectRuntime: upToDate → no-op notify; else write merged content (tachyon key only) without modal and notify the delta. (4) extension reloads config before Bridge start, passes preferred port, warns on fallback; config watcher notifies that a bridgePort change needs a window reload. Integration test reads the Bridge URL via the clipboard (copyBridgeUrl) and asserts the derived port.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** none (extends existing modules).

**Modify:** `src/bridge/Bridge.ts` (preferred port + derivePort), `src/config/loadConfig.ts` + `tachyon.schema.json` (bridgePort), `src/registration/adapters.ts` (alreadyRegistered/upToDate), `src/extension.ts` (wiring, no-modal idempotent connect), unit tests (bridge/config/adapters), `test/integration/extension.test.js` (derived-port assert), `README.md`, `examples/tachyon.yml`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Always require explicit bridgePort in tachyon.yml

Rejected: demands config for the common case; hash-derived default gives zero-config stability and the override remains for collisions/preferences.

### Fixed single global port (e.g. 41000 for every workspace)

Rejected: two workspaces open simultaneously would collide; per-workspace derivation avoids it while staying deterministic.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Derived-port collision between two workspaces hashing into the same port — rare (2000 slots); the busy-port fallback + explicit override cover it.
- Port range 41000–42999 could clash with user services — documented; override exists.

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- Session friction report + node net EADDRINUSE semantics; spec 186/188 module layout.
