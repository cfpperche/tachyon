# agent-focus-line dogfood (spec 390)

## Seeded focus sources

| Agent | Expected focus | Source |
|-------|----------------|--------|
| `grok` | Ship agent focus line… | **task** `t-f0c001` (assignee) |
| `solo` | Explore continuity-only… | **goal** (continuity) |
| `idle` | _(none)_ | omit |
| `helper` | Implement focus-line brief… | **brief** (ledger contract; stopped ad-hoc) |

## Human steps

1. Monorepo: **Tachyon: Dev Host** → F5 (pointer armed to this fixture)
2. Sidebar **Agents**:
   - Filters **On task** → only `grok`
   - **Has focus** → `grok`, `solo`, `helper`
   - **All** → all four
3. Confirm no `working` badge; no “spawned by / delegated by” text (tree indent only for helper under grok if lineage nests)
4. Optional: Start `grok` live and re-check focus still present

## Cleanup

```bash
npm run dogfood:dev-host -- point-clear
```
