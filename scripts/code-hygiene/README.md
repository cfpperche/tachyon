# code-hygiene (internal repo tool)

On-demand scan for **unused-export / orphan-file candidates** (knip) and **textual clones** (jscpd).

| This is | This is **not** |
|---------|------------------|
| Project tooling under `scripts/` | A Tachyon product plugin |
| Invoked by humans / agents in this checkout | A skill under `.agents/skills` or `.claude/skills` |
| Advisory report only | Part of `verify:full` or a commit gate |

Compare to **dep-audit**: that is a formal Tachyon *plugin*. This harness is only for maintainers of **this** repository.

## Run

Requires `node_modules` (`npm ci`). First run may `npm install --no-save` knip/jscpd into the worktree so they share this checkout’s TypeScript (isolated `npx` knip breaks here).

```bash
npm run hygiene:scan
# equivalent:
node scripts/code-hygiene/scan.mjs
```

Default report: `.tachyon/code-hygiene/report.md` (gitignored via `.tachyon/`).

```bash
node scripts/code-hygiene/scan.mjs --out /tmp/hygiene.md
node scripts/code-hygiene/scan.mjs --skip-knip
node scripts/code-hygiene/scan.mjs --skip-jscpd
node scripts/code-hygiene/scan.mjs --exit-code   # exit 1 when candidates exist
```

## How it works

1. **Entrypoints** — parsed from `esbuild.mjs` `entryPoints` (extension, engine, webviews, resolvers, …).
2. **knip** — reachability from those entries over `src/**/*.{ts,tsx}` only (`scripts/` / `test/` excluded to avoid CLI/test noise).
3. **jscpd** — textual clones under `src/` (default min-lines=10, min-tokens=50).

## How to read the report

| Signal | Means | Next step |
|--------|--------|-----------|
| knip file / export | No static importer from esbuild entrypoints | Grep string refs, `package.json` contributes, Bridge/MCP names, tests |
| jscpd clone | Textual similarity above thresholds | Decide if a shared helper is worth it; runtime adapters often stay parallel |

**Never delete from the report alone.**

## Out of scope

- Auto-delete / auto-refactor  
- Plugin packaging or skill materialization  
- Wiring into `verify:full` (optional consumer-side `--exit-code` only)  
- Semantic “same business rule” beyond textual clones  
