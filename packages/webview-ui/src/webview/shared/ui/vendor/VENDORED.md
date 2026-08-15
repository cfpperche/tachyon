# VENDORED.md — provenance for `shared/ui/vendor/`

_spec 342, T8. This directory holds unmodified-BEHAVIOR shadcn/ui + Radix component source. This file
records exactly where it came from and what was adapted, so a future upgrade knows what to re-diff against._

## Generation

- **Source:** shadcn/ui's public component registry, fetched DIRECTLY over HTTPS —
  `curl https://ui.shadcn.com/r/styles/new-york-v4/<component>.json` — NOT the `shadcn` CLI. The CLI's
  `init`/`add` flow assumes a `components.json` + an existing Next.js/Vite-shaped project (path aliases, a
  `tailwind.config.*`) that doesn't match this project's custom multi-entry esbuild setup; the registry JSON
  fetched here IS the CLI's own data source (the identical upstream `.tsx` content the CLI would have written
  to disk), so this is equivalent provenance with a wiring cost this project's structure can actually absorb.
  See `notes.md`'s T3 deviations entry for the full reasoning.
- **Registry style:** `new-york-v4` (shadcn's Tailwind-v4-targeting style variant).
- **Fetch date:** 2026-07-03. The registry has no versioned commit-hash artifact of its own (it's served
  live from shadcn's site, not a pinned git ref) — the fetch date + the exact URLs above ARE the provenance
  record. Re-fetching later may return different content if shadcn updates the registry; re-diff against
  this date before assuming a later fetch is a strict superset.
- **Components vendored (5, per the T3 compat gate's batch 1):** `tooltip`, `dropdown-menu`, `select`,
  `popover`, `dialog`.
- **Exact generation command** (re-run this + re-diff to check for upstream drift):
  ```sh
  for c in tooltip dropdown-menu select popover dialog; do
    curl -s "https://ui.shadcn.com/r/styles/new-york-v4/$c.json" -o "$c.json"
  done
  ```
  Each `<c>.json`'s `.files[0].content` field is the vendored `.tsx` source (before the adaptations below).
- **No `components.json`.** The CLI would normally write one recording style/aliases/Tailwind config
  choices; since the CLI never ran, there is none — this file + `packages/webview-ui/src/webview/shared/tailwind-theme.css` (the
  `@theme inline` semantic-token mapping every shadcn component's Tailwind classes resolve against) ARE the
  config baseline. `tailwindcss`/`@tailwindcss/cli` are v4 (CSS-native config — no `tailwind.config.js`
  exists in this project at all, vendored or otherwise).

## Adaptations from upstream (applied uniformly, every file)

1. Dropped the Next.js `"use client"` directive (meaningless outside Next's RSC boundary).
2. `import { X as XPrimitive } from "radix-ui"` (the registry's current meta-package import) →
   `import * as XPrimitive from "@radix-ui/react-x"` (this project's exact-pinned, per-package classic
   imports — see Radix versions below). The meta-package and the classic per-package imports are the SAME
   upstream code; only the import specifier shape differs.
3. `import { cn } from "@/lib/utils"` → `import { cn } from "./lib/utils"` (a local copy of shadcn's
   standard, unmodified `cn` helper — `shared/ui/vendor/lib/utils.ts`).
4. `lucide-react` icons (`CheckIcon`, `ChevronRightIcon`, `ChevronDownIcon`, `ChevronUpIcon`, `CircleIcon`,
   `XIcon`) → this project's own codicon-backed `Icon` component (`shared/ui/Icon.tsx`) — no new
   icon-library dependency for 6 glyphs Tachyon already ships via `@vscode/codicons`.
5. `dialog.tsx` ONLY: `DialogFooter`'s optional "outline" Close button no longer imports the registry's own
   `Button` (which this project doesn't vendor) — inlined as plain Tailwind classes over the same bridged
   `border`/`input`/`accent` tokens.

No other changes. Each vendored file's own header comment repeats the adaptations specific to it.

## Pinned runtime dependencies (exact, per `package.json`)

| Package | Version | License |
| --- | --- | --- |
| `@radix-ui/react-tooltip` | 1.2.11 | MIT |
| `@radix-ui/react-dropdown-menu` | 2.1.19 | MIT |
| `@radix-ui/react-select` | 2.3.2 | MIT |
| `@radix-ui/react-popover` | 1.1.18 | MIT |
| `@radix-ui/react-dialog` | 1.1.18 | MIT |
| `class-variance-authority` (cva) | 0.7.1 | Apache-2.0 |
| `clsx` | 2.1.1 | MIT |
| `tailwind-merge` | 3.6.0 | MIT |
| `tailwindcss` (dev) | 4.3.2 | MIT |
| `@tailwindcss/cli` (dev) | 4.3.2 | MIT |
| `puppeteer-core` (dev, compat-gate driver) | 25.3.0 | Apache-2.0 |
| `axe-core` (dev, a11y contract checks) | 4.12.1 | MPL-2.0 |

**Upgrade discipline (spec F9):** any version bump of the 5 `@radix-ui/react-*` packages above MUST rerun
the T3 compat gate (`npm run test:browser`) and update the results table in `../../../../docs/specs/342-vendored-ui-components/notes.md`,
even if the vendored `.tsx` source itself is unchanged — a Radix internals change can silently flip a
currently-passing component (or fix a currently-failing one; see the `it.fails` regression probes in
`test/browser/uiGate.test.ts`).

## shadcn/ui LICENSE

shadcn/ui itself (the registry + generated component templates) is MIT-licensed. No per-file upstream
license header was present in the fetched registry content, and none is invented here — this VENDORED.md
file IS the license/provenance record for the whole directory, per shadcn/ui's own distribution convention
(the registry ships components as source to be owned/modified by the consuming project, not as a
traditionally-licensed library with per-file headers).
