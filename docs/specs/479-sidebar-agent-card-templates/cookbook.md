# Cookbook — the sidebar agent card template (SDD 479)

How a project chooses which elements its **agent cards** show, and in what order. Contract:
[`spec.md`](./spec.md). Written from the refusal messages themselves, so the docs and the diagnostics
cannot drift apart.

## When to use

- Your fleet reads the same way every day and some badges are noise for how *this* project works.
- Worktree-heavy work: you want `branch` first, before anything else in the badge row.
- You want a quieter card without giving up the signals that explain why an agent stopped moving.

## When not to use

- **Terminal rows.** V1 is agent cards only. A terminal row renders the default card whatever you
  configure — not "not yet implemented", a rule the resolver enforces.
- Restyling. Colors, spacing, typography and the badge vocabulary stay the product's.
- Hiding an emergency. You *can* omit `auth-required`; the product will put it back on the row that
  has it (see § What you cannot hide).

## Where it lives

`tachyon.yml`, under `settings:` — it travels with the repo, so every teammate and every
agent-authored checkout reads the same card.

```yaml
settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch, verify, harness]
```

That is a complete, valid template. `version` is required.

## The three regions

| Region | What sits there | Components |
|---|---|---|
| `header` | the row's top line | `status-dot`, `name`, `model`, `model-provenance`, `metrics-pill` |
| `meta` | the badge row under it | `sub`, `hidden-count`, `branch`, `config-invalid`, `attention`, `awaiting-human`, `auth-required`, `verify`, `evidence`, `external-tools`, `harness`, `resume`, `fork`, `continuity`, `persistence-hooks` |
| `footer` | below the badges | `focus`, `metrics-lanes`, `actions` |

A component only appears in the region it belongs to; listing `branch` under `header` is refused by
name. Order within a region is exactly the order you write.

The disclosure chevron is not a component and cannot be hidden: it reveals child *rows*, so hiding it
would make collapsed children unreachable.

## Silence inherits, `[]` obeys

```yaml
      meta: [branch, verify]     # header and footer keep the default
      footer: []                 # explicitly empty: hides focus, lanes AND actions
```

A region you do not mention keeps the default. That is deliberate — reordering badges should not
silently delete your actions row. An empty list is a sentence, and it is honored.

## Two components that travel with their host

`model` renders inside the name, and `model-provenance` renders inside `model`. List the host too:

```yaml
      header: [status-dot, name, model, model-provenance]   # ok
      header: [status-dot, name, model-provenance]          # refused — the host is missing
```

Hiding `model` hides its provenance marker with it, which is the only sensible reading.

## What you cannot hide

Four components carry states a row cannot recover from on its own:
`auth-required`, `config-invalid`, `awaiting-human`, and `verify` **when it failed**.

Omit them and they still appear — but only on the rows actually in that state, and only then. The
badge's tooltip says so: *"Your card template omits this badge — Tachyon is showing it because this row
is in that state."* A passing or stale verify gate is information, not an emergency, and stays hidden
if you hid it.

## When you get it wrong

The template is refused **whole** — never half-applied — and the rest of `tachyon.yml` keeps working:
your agents, commands and runbooks are untouched. The sidebar renders the default card and shows a
warn-toned banner, *"Card layout ignored — showing the default"*, with a button to open the file. The
warning names the exact key:

```text
settings.sidebar.cardTemplate.meta[1]: unknown component 'cpu-graph' — the catalog is status-dot, name, …
settings.sidebar.cardTemplate.header[1]: 'branch' belongs to the meta region, not header
settings.sidebar.cardTemplate.meta[2]: duplicate component 'branch' in the meta region
settings.sidebar.cardTemplate.version: unknown template version 7 (this Tachyon understands version 1)
settings.sidebar.cardTemplate: unknown key 'sidebarWidth' (allowed: version, header, meta, footer)
```

Every problem is reported at once, so one save shows you the whole list.

## Not available yet

`options:` (e.g. `model: { maxChars: 24 }`) is named in the design but no component honors one, so the
key is **refused by name** rather than accepted and ignored — tracked as `t-045d44`. Per-runtime
overrides (`runtimes: { claude: … }`) arrive in phase 3, and the live preview in phase 4.

## Recipes

**Worktree-heavy work — branch first, quiet everything else.**

```yaml
settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch, verify, attention]
```

**A dense fleet — the name and what it is doing, nothing else.**

```yaml
settings:
  sidebar:
    cardTemplate:
      version: 1
      header: [status-dot, name]
      meta: []
      footer: [focus, actions]
```

Failure states still surface on the rows that have them.
