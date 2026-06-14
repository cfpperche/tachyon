# 215 — tachyon-terminals-block — notes

## Origin
Pin `p-e191d4` (dogfood) — an experienced user, twice, couldn't see why `agents:` houses
terminals. The README now explains the *why* (one lifecycle → one kind-tagged map), but the
maintainer's follow-up was sharper: **the explanation lands, yet the config key can still
confuse extension users.** The friction is cirurgical — the UI/Studio already split Agents vs
Terminals; only the `tachyon.yml` key reads `agents:` for both. So: add a `terminals:` block,
keep the engine's unified model, stay backward compatible. (AskUserQuestion 2026-06-14 →
"Bloco terminals: (spec)".)

## Confirmed product decisions (2026-06-14)
- `terminals:` top-level block; entries = agent entries with kind forced to `terminal`; `kind`
  and `instructions` keys rejected inside it. Merged into the single `config.agents` record.
- agents↔terminals name collision = error. Backward compatible; NO auto-migration.
- Studio Terminal tab writes new terminals to `terminals:`; edits rewrite in the entry's current
  block (never move a legacy `agents:` terminal). Brand/key `agents:` stays (it's the product).
- Engine untouched — pure config-surface + Studio-write + Init + docs.

## Status
**SHIPPED v0.15.0** (2026-06-14). TDD + codex dueto (2 rounds: NO-SHIP→fixes→SHIP). A real UX
fix with concrete demand (pinned + re-raised), delivered as a pure config-surface change.

## codex dueto
- **Round 1** — NO-SHIP, 5 findings: (MAJOR) `addAgent` collision only checked `agents:` → could
  write a cross-block dup; (MAJOR) editing a `terminals:` entry on the Agent tab silently kept it
  a terminal (form said agent); (MAJOR-ish) schema divergence — `agents.minProperties:1` broke
  empty-agents+terminals, terminals entry too loose; (MINOR) `kind`/`instructions` double-errored;
  (MINOR) stale initLogic comment. All fixed (2b0b98b): sectionOf-based collision across blocks;
  studioSubmit rejects a kind flip + tabs locked in edit mode; schema minProperties moved into the
  anyOf branches + terminals entry `$ref`s the agent entry; AGENT_KEYS recognizes kind/instructions
  everywhere (single explicit error); comment fixed.
- **Round 2** — SHIP (Ajv-verified the schema cases, typecheck + targeted suite, no remaining/new).
