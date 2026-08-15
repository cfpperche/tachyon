# File picker inventory — Preact kit vs VS Code native

**Task:** `t-7d1739`  
**Agent:** `filepickinv`  
**Date:** 2026-08-05  
**Scope:** levantamento only — no product code changes.

Owner trigger: **Import image into pin** opened a native VS Code dialog that, in this environment, looks like a typed path box (default directory + `..`). That is `vscode.window.showOpenDialog`, not `showInputBox` — on Linux / remote / simple-file-dialog VS Code often renders open-dialog as path entry rather than a full OS file browser.

---

## 1. Already have a reusable Preact component?

### Verdict: **yes — `KitFilePicker`**

| Item | Location |
| --- | --- |
| Component | `src/webview/shared/ui/kit/KitFilePicker.tsx:24` (`export function KitFilePicker`) |
| Props | `src/webview/shared/ui/kit/KitFilePicker.tsx:7` (`KitFilePickerProps`) |
| Kit export | `src/webview/shared/ui/kit/index.ts:26` |
| Catalog entry | `packages/webview-ui/src/webview/shared/ui/README.md:57` — “File selection” |
| Tokens / CSS | `src/webview/shared/design-system.css:308–318` (`.kit-file-picker*`) |

### What it already does

- Themed **dropzone** + **“choose from your computer”** that clicks a hidden `<input type="file">` (`KitFilePicker.tsx:58–88`).
- Props: `title`, `description`, `accept`, `disabled` / busy label, `error`, custom idle/dragging/browse labels, optional **Cancel**.
- Callback: `onFile(file: File)` — caller reads bytes in the webview (e.g. `arrayBuffer` → base64) and posts a domain message. No host dialog for the pick itself.
- Design-system styling; single-file only (`files?.[0]`).

### Production consumers today

| Surface | File:line | What is imported |
| --- | --- | --- |
| Agent Studio — portable profile JSON | `src/webview/agent-studio-shell/App.tsx:155` (`ProfileBundlePicker`) | `.json` ≤ 256 KB → base64 to host |
| Agent Studio — SOUL / identity text | `src/webview/agent-studio-shell/App.tsx:207` (`SoulImportPicker`) | `.md`/`.markdown`/`.txt` ≤ 64 KB → base64 to host |

Tests assert the kit is the only surface-level file input: `test/unit/agentStudioProfileActions.test.ts` (reads `KitFilePicker.tsx`, expects `<KitFilePicker` in the shell).

### What it does **not** do (gaps)

| Gap | Why it matters |
| --- | --- |
| **No folder / directory mode** | CWD “Browse” needs a **path string**, not a `File` blob. HTML `type="file"` does not replace `canSelectFolders: true`. |
| **No filesystem path return** | Returns browser `File` contents. Host still needed when the product must store or resolve an absolute path. |
| **No multi-select** | Always first file only. |
| **No workspace tree browser** | Does not list workspace dirs via host messages; relies on the browser/OS file chooser behind `<input type="file">`. |
| **Not used for pin/task Import** | Those still call host `importImage` → `showOpenDialog` (below). |

So: do **not** treat this as “no component.” Content-import migration can reuse `KitFilePicker` as-is. Path/directory selection needs a different piece (or keep native).

### Related partial pieces (not a full file picker)

| Piece | File:line | Already does | Missing for “full product picker” |
| --- | --- | --- | --- |
| **Path text + Browse** (cwd) | e.g. `command-studio-shell/App.tsx:256–259`, `terminal-studio-shell/App.tsx:231–234`, `agent-studio-shell/App.tsx:1525–1534` | Free-typed path field + button that posts `browse` | Browse still hosts `showOpenDialog` folders; no kit folder control |
| **`VisualsPanel` drop affordance** | `src/webview/rich-doc/VisualsPanel.tsx:71–87` | UI “Paste, drop, import…” button | `onImport` only; **Import** still host-native; paste/drop handled by TipTap / `attachImage` |
| **Paste/drop image path** | pin `App.tsx:274–278`, task `App.tsx:383–387`; TipTap `rich-doc/tiptap.ts:93–94` | Webview `File` → base64 → `attachImage` **without** native dialog | Import **button** still bypasses this and uses host open dialog |
| **`QuickPicker`** | `src/webview/shared/ui/QuickPicker.tsx:1–5` | In-webview filterable list (replaces `showQuickPick` when candidates are already known) | Not a filesystem browser |

Documented host pattern (still accurate for residual native uses): `packages/webview-ui/src/webview/shared/studio/README.md:42–43` — “Native picker round trip: webview asks, host runs `showOpenDialog`…”.

---

## 2. Where native VS Code pickers are still used

### 2a. `vscode.window.showOpenDialog` (product) — all five call sites

Ordered by how much they hurt product polish (owner hit first).

| # | File:line | Product flow | User is choosing | Surface | Webview vs host |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/cockpit/pinStudioDomain.ts:37–43` | Pin Studio → **Import image into pin** (header Import / VisualsPanel) | Image file (`png/jpg/jpeg/webp/gif`) | Pin Studio webview → domain `importImage` → host dialog → `fs.readFileSync` | **Webview-triggered host** — migratable; paste/drop already content-based |
| 2 | `src/cockpit/taskStudioDomain.ts:60–66` | Task Studio → **Import image into task** | Same image filters | Task Studio webview → `importImage` | Same shape as pin |
| 3 | `src/cockpit/taskStudioDomain.ts:46` | Task Studio → **Import static task prototype** | HTML/HTM file ≤ 512 KB | Task Studio → `importPrototype` | Webview-triggered host; content import like soul/profile |
| 4 | `src/cockpit/studioRegistry.ts:68–74` (`browseForCwd`) | Command Studio + Terminal Studio → **Browse** next to Working directory | **Folder** (path) | Command / Terminal shells (`browse` domain message) | Webview-triggered host; needs **path**, not `File` |
| 5 | `src/cockpit/agentStudioDomain.ts:438–444` (`browse`) | Agent Studio → **Browse** working directory | **Folder** (path) | Agent Studio `browse` | Same as #4; duplicate of `browseForCwd` logic |

Wiring for #1–#3:

- Pin UI: `src/webview/pin-studio/App.tsx:455`, `:494` → `importImageMessage()` → `pinStudioDomain.importImage`.
- Task UI: `src/webview/task-studio/App.tsx:569–570`, `:683` → `importImage` / `importPrototype`.

`STUDIO_REGISTRY` assigns #4: `studioRegistry.ts:90–98` (`command` / `terminal` → `handleBrowseDomainMessage`).

### 2b. `showSaveDialog`

**None** in `src/` (product).

### 2c. `showInputBox` used as a path picker

**None.** Only non-path uses:

| File:line | Purpose |
| --- | --- |
| `src/extension.ts:3466–3470` | Clone agent **name** |
| `src/extension.ts:3597–3601` | Create PR **title** |

The owner’s “typed path + `..`” UI is therefore **#1 `showOpenDialog`**, not `showInputBox`.

### 2d. `showQuickPick` with file-ish labels (not open-dialog debt)

These pick among **known candidates**, not the OS filesystem. Listed for completeness; not the same problem class as open-dialog content import.

| File:line | Flow | What is chosen | Migrate to Preact file picker? |
| --- | --- | --- | --- |
| `src/extension.ts:635–641` | Worktree / pipeline **Review changes** (`reviewWorktreeDiff`) | One path from known `ChangedFile[]` → open `vscode.diff` | **No** as file-picker work. Optional later: in-webview `QuickPicker` if this UX moves into Control; host command palette remains fine |
| `src/extension.ts:497–500`, `2551–2554`, `2565–2568`, `3051–3054` | Multi-root / bootstrap “Which folder?” | Configured workspace or open `workspaceFolders` entry | **No** — workspace binding, not file content |
| Other `extension.ts` quick picks (templates, agents, runtime offers, pipelines, …) | Command palette / host flows | Non-file entities | **No** |
| `src/workspace/notify.ts:34–38` | Notification multi-choice | Labels from caller | **No** |

Mocks only: `test/mocks/vscode.ts:151` (`showOpenDialog`), `:176` (`showQuickPick`).

---

## 3. Recommended migration order

Assumption: reuse **`KitFilePicker` + existing content pipelines** first; do not invent a second dropzone.

| Order | Work | Why | Est. shape |
| --- | --- | --- | --- |
| **1** | Pin **Import image** (`pinStudioDomain.ts:37` + pin `App.tsx` Import / VisualsPanel) | Owner hit; paste/drop already uses `attachImage` with webview `File` | Open `KitFilePicker` (or feed Import into same `attachFile` path); drop or stop calling host `importImage` for browse |
| **2** | Task **Import image** (`taskStudioDomain.ts:60`) | Clone of pin; same filters and attach pipeline | Same as #1 |
| **3** | Task **Import prototype** (`taskStudioDomain.ts:46`) | Content import of HTML — same class as soul/profile kit usage | `KitFilePicker` `accept` for HTML → base64/text domain message (new or extended protocol; host reads buffer from message instead of path) |
| **4** (optional polish) | Align `VisualsPanel` import affordance with kit dropzone language/styling | Reduces dual “cloud-upload” patterns | Visual/API only after #1–#2 |
| **5** (separate decision) | CWD folder browse (#4–#5 open dialog) | Not solvable by current `KitFilePicker`; needs path-aware design | See “Do not migrate (yet)” |

**Sizing note for the parent:** content imports (#1–#3) look like **one or two ordinary tasks**, not a full SDD — the kit and the pin/task `attachImage` paths already exist. Folder-path UX is the only piece that may need a small design pass (host-backed directory list vs keep native).

Agent Studio already demonstrates the end state for **content**: kit in webview, host receives bytes (`importSoul` / profile import), not a path from `showOpenDialog`.

---

## 4. What should **not** migrate (or not as “replace with KitFilePicker”)

| Case | Reason |
| --- | --- |
| **CWD folder Browse** (command / terminal / agent studios) | Product needs an **absolute path** for process cwd. Webview sandbox cannot enumerate arbitrary disk trees or return a trustworthy path from a `File` alone. Native `showOpenDialog({ canSelectFolders: true })` is a legitimate host capability. A Preact replacement would be a **host-backed directory browser** (list dir → message → kit tree), not `KitFilePicker` as written. Prefer keep native until that design is deliberate. |
| **`showQuickPick` entity picks** (agents, templates, runtimes, pipelines, workspaces) | Not file pickers. Where a webview already owns candidates, prefer existing `QuickPicker` (Activity/Fleet already do). Palette-only host commands should stay on VS Code UI. |
| **Worktree “Review changes” file list** (`extension.ts:635`) | Selecting among a known change set to open **native diff** (`vscode.diff`). Host-native is correct; not content import. |
| **`showInputBox` name/title** | Not paths; leave alone. |
| **100% elimination of every native dialog** | Unexamined blanket migration would either (a) break cwd path selection or (b) reimplement OS folder picking poorly inside a webview. Trust-worthy inventory stops at content-import debt + optional later folder UX. |

### Hybrid already in the product (do not “fix” paste/drop)

Pin/Task already accept images via **paste and drop** without native dialog (`attachImage`). Only the explicit **Import** control is native. Migration of Import should **join** that path, not invent a third one.

---

## 5. Actor × trigger snapshot (for whoever implements)

| Actor | Trigger | Effect today |
| --- | --- | --- |
| Human in Pin/Task Studio | Click Import / Visuals drop button | Webview `importImage` → host `showOpenDialog` → read path → store attachment |
| Human in Pin/Task Studio | Paste or drop image on editor | Webview `File` → `attachImage` + base64 → host store (**no** open dialog) |
| Human in Agent Studio | Import soul / profile | Webview `KitFilePicker` → base64 domain message → host |
| Human in Agent/Command/Terminal Studio | Browse cwd | Webview `browse` → host folder `showOpenDialog` → `cwd` value message |
| Human via command palette | Review worktree changes | Host `showQuickPick` of paths → `vscode.diff` |

A green “Import” that only tests paste will not cover the open-dialog door — fail the native path before deleting it.

---

## 6. Bottom line

1. **Reusable Preact file picker exists:** `KitFilePicker` in the kit; used for Agent Studio content imports; **not** wired to pin/task Import.
2. **Native open-dialog debt is five product call sites** — three content imports (pin image, task image, task HTML prototype) and two folder-path browsers (shared command/terminal + agent cwd). No save dialog; no path `showInputBox`.
3. **Migrate content first** (pin image → task image → prototype) onto `KitFilePicker` + existing byte/base64 messages. **Keep native folder open-dialog** until a path-aware design is chosen. Do not claim 100% migration without that design.
