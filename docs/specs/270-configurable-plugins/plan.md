# 270 — plan

## The touch-points (engine + webview)

- `src/plugins/manifest.ts` — add + validate `config?: ConfigDecl` and top-level `docsUrl?` to `PluginManifest`;
  fail-closed (well-formed JSON Schema, `format` ∈ {"json"}, `default` validates against `schema`, `docsUrl`
  `https://`-only, size caps, reject unknown sub-fields). The untrusted marketplace boundary.
- `src/plugins/toolPlan.ts` / install preview — carry the config descriptor + docsUrl into the install plan so
  consent can show "ships configuration + docs link". Config is **not** added to the install fingerprint (edits ≠
  drift).
- `src/plugins/lockfile.ts` — persist a `configDescriptor?` (format + resolved path + schema ref/hash) + `docsUrl?`
  per installed plugin; fail-closed parse. The card view-model reads the lockfile (hot path), so the buttons'
  presence must be derivable from it.
- `src/plugins/viewModel.ts` — extend `InstalledPluginVM` with `config?: { path: string }` and `docsUrl?`; derive
  the **Config**/**Docs** actions from their presence.
- `src/webview/PluginsPanel.ts` + the Preact webview — render Config/Docs buttons; Config → open the on-disk file
  in an editor with schema association; Docs → `vscode.env.openExternal` (`https://`-guarded at click). Post-apply:
  on a successful apply of a config-declaring plugin, auto-open its config editor.
- `default` materialization — on install, seed the config file from `default` if absent so the plugin works before
  the human edits.

## Data shape

```ts
interface ConfigDecl {
  format: "json";                 // v1: JSON only (YAML editor-only later)
  schema: JsonSchema;             // validates the config; bounds the editor; size-capped
  default?: unknown;              // must validate against `schema`; seeded on install
}
// PluginManifest gains:  config?: ConfigDecl;  docsUrl?: string /* https:// only */;
```

Validation (fail-closed): `schema` is a well-formed JSON Schema within the manifest size caps; `default` (if
present) validates against `schema`; `docsUrl` matches `^https://` and contains no control chars; unknown
sub-fields rejected.

## Build order (bottom-up, each tested)

1. **manifest.ts** — parse + validate `ConfigDecl` + `docsUrl`; unit tests (valid; bad format; malformed schema;
   default-fails-schema; non-https/`command:`/`file:` docsUrl; oversize; unknown sub-field).
2. **lockfile.ts** — `configDescriptor?` + `docsUrl?` round-trip + fail-closed parse; unit tests.
3. **toolPlan/preview** — thread descriptor + docsUrl into the plan; assert config is **excluded** from the install
   fingerprint (an edited config does not change the fingerprint → no spurious drift); unit tests.
4. **viewModel.ts** — derive Config/Docs actions from lockfile descriptor; pure unit test (buttons appear iff
   declared).
5. **webview wiring** — Config opens the file + schema association; Docs `openExternal` https-guarded; post-apply
   auto-nav only on success; default seeded. (Per the logic-in-vscode-layer lesson: keep the decision logic —
   button derivation, https guard, auto-nav predicate — in a **pure, unit-tested** module; the webview/extension
   layer only wires it.)

## Co-development with 271 (vertical slice)

Per codex: do **not** ship all of 270 in isolation. Implement 270's manifest/lockfile/viewModel/editor primitives
together with 271's launcher enforcement so the agent-browser trust policy proves whether the config path,
schema association, lockfile metadata, and post-install nav are actually sufficient. Two specs on paper, one
vertical slice in the tree.

## Verify (mechanical)

`env -u TMUX npx vitest run` over the touched unit suites (manifest / lockfile / toolPlan / viewModel /
the new pure button-derivation module) — exact file list pinned in tasks.md once the modules land.
