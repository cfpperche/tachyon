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
Draft, planned. Implement TDD + codex dueto, ship a release. The cheapest of the post-214
threads but a real UX fix with concrete demand (not speculative — pinned + re-raised).
