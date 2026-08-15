# t-774369 — Task-scoped agent attachment primitive

**Author:** anexogrok · **Tree measured:** `f6eee173` (`6dc3d8fc`) · **Date:** 2026-08-15
**Kind:** decision packet. Measurement + proposal only. No implementation. Whether this enters the product is the owner's.

The card asked to generalize the spec 273/274 evidence store into a task-scoped attachment. After measuring this tree, that store cannot own the bytes. The task-scoped store already exists (spec 339, `TaskAttachmentStore`). What does not exist is a Bridge door onto it.

### Decision packet (the four questions)

| Question | Answer |
|---|---|
| Does the current store serve? | **The 273/274 evidence store does not** (agent-keyed, worktree-gated, no `taskId`, no card render). **The 339 task store does** — it already holds human-pasted images under `.tachyon/tasks/attachments/<task-id>/`. |
| What would be missing? | Only a Bridge write: agent-authenticated `attach_task_attachment` that stamps `producedBy` and writes blob + sidecar + `attachment:` body ref together. Not a new store. |
| Who owns the bytes? | **The Task.** `forgetAgent` does not touch `.tachyon/tasks/`. Dismissing the author leaves blob, sidecar, and body ref intact. |
| What if we do not build it? | **Nobody open is blocked today.** The gap is 35 days old, priority 2, named “low urgency”. Work already ships through four workarounds. That is an argument against building, not a gap in the measurement. See §6. |

---

## 1. What the spec 273/274 store is today, measured

There are two byte stores. The card named one. The human path already uses the other.

### 1.1 Evidence store (specs 273 / 274) — agent-scoped

| Question | Measured answer | File:line |
|---|---|---|
| Where it lives | `.tachyon/evidence/<agent>/<id>/` (posix, gitignored with all of `.tachyon/`) | `packages/engine/src/worktree/evidence.ts:39-42` |
| What it stores | One directory per evidence record: copied files (original basenames, de-collided) plus, after t-1d198e, `record.json` next to them | `evidenceArtifacts.ts:26-58`, `evidenceStore.ts:17-37` |
| Record shape | `WorktreeEvidence`: `id`, `targetAgent`, `producer`, `atCommit`, `producedAt`, `kind`, `severity`, `summary`, optional `detail`/`data`/`artifacts`. **No `taskId`.** | `evidence.ts:45-77` |
| Who writes | `Workspace.attachEvidence` via Bridge `attach_evidence`. Host stamps `id` / `producedAt` / `atCommit` / `schemaVersion`. `producer` is spec-351 resolved, not trusted verbatim. | `Workspace.ts:4680-4721`, `packages/bridge/src/tools/verification.ts:7-56` |
| Ingest | Worktree-relative refs only. `isSafeArtifactRef` rejects traversal / absolute / NUL. `lstat` + regular-file only (symlink/dir/special refused). `copyFileSync` into the managed dir. **No size cap on the copy.** Missing source fails the whole attach. | `evidence.ts:153-158`, `evidenceArtifacts.ts:37-54` |
| Write precondition | Target agent must have a **live worktree** and a resolvable HEAD. No worktree → refused. | `Workspace.ts:4681-4688` |
| Who deletes | `forgetAgent` does **not**. `FORGET_AGENT_FOOTPRINTS` is session/activity/credentials/transcript/profile — no evidence path. | `forgetAgent.ts:9-20, 48` |
| Cap | Spec 273 still says max 100 records/agent, oldest dropped (`appendCapped`). That cap runs only on the **ledger copy** (`SessionLedger.appendEvidence`). After t-1d198e, listing reads **disk** (`loadEvidenceRecords`), so the cap no longer removes files or captions. Disk is unbounded. | `evidence.ts:34-35, 132-137`, `SessionLedger.ts:335-341`, `Workspace.ts:4663-4666` |
| End of writer's life | `dismissTemporary` → `forgetAgent` → `ledger.remove(name)`. Before t-1d198e the caption lived in that ledger row and died with it; files stayed. Now `persistEvidenceRecord` writes `record.json` in the same directory as the files. `list_evidence` still reads after dismiss (HEAD falls back to the workspace). | `evidenceStore.ts:1-11, 35-72`, `verification.ts:62-64`, `Workspace.ts:4668-4671` |
| What it is for | Advisory, never a gate. Judgments / step-results / notes **about a worktree agent**, keyed to a commit, stale when HEAD moves. | `evidence.ts:1-6`, spec 273 |

Live primary checkout (2026-08-15, not this worktree): **128** agent directories under `.tachyon/evidence/`, **321 MB**, **8** `record.json` files (t-1d198e landed today; it migrated listed records and left the 103 orphans, as instructed). `acpfleet` (dismissed) still has folders and **0** `record.json`.

### 1.2 Task attachment store (spec 339) — already task-scoped

Shipped 2026-07-03, a week before this card was filed. This is the store the human drag/paste path already uses.

| Question | Measured answer | File:line |
|---|---|---|
| Where it lives | `.tachyon/tasks/attachments/<task-id>/blobs/<sha256>` | `TaskAttachmentStore.ts:15-39` |
| Metadata | Sidecar `.tachyon/tasks/details/<id>.json`: Tiptap `doc` + `attachments[]` + `bodyHash` + `taskUpdatedAt` | `TaskDetailStore.ts:10-26, 53-60` |
| Blob mechanics | Shared `RichDocAttachmentStore`: content-addressed sha256, 10 MB/image, allowlist `png/jpeg/webp/gif`, SVG refused, 50 MB soft limit per namespace, traversal rejected (`blobRef` must be 64-hex) | `richDoc/AttachmentStore.ts:20-24, 61-65, 175-198` |
| Who writes today | **Human only**, via Task Studio `put-image` / paste / drop / import. `AttachmentSource = "paste" \| "drop" \| "import"`. No `"agent"`. No `producedBy`. | `taskStudioService.ts:54-67`, `richDoc/types.ts:8, 11-23` |
| Bridge | **No tool.** `attach_task_attachment` does not exist. `get_task` returns prototypes, not image attachments. | `packages/bridge/src/tools/tasks.ts:57-82, 84-123` |
| Inline render | `task.body` carries `![alt](attachment:<id>)`. Task Detail resolves those against the sidecar's `imageAttachments` to a webview URI. Reimport understands the same `attachment:` src. | `taskDetailVm.ts:19-42`, `markdownDoc.ts:186-189`, `docMarkdown.ts` (image → `attachment:<id>`) |
| Who deletes | **Dropped** tasks keep sidecar + blobs (spec 339 F5). `TaskDetailStore.delete` removes sidecar + the whole attachment directory, but **has no production caller** in this tree — only unit tests. `gcRemovedAttachments` runs on Studio save when the sidecar's next attachment list no longer references a blob. Staged-create cancel / failed create `rm -rf` the provisional directory. | `TaskDetailStore.ts:138-178`, `taskStudioService.ts:40-51, 121-126` |
| End of writer's life | `forgetAgent` does not name `.tachyon/tasks/` (or `.tachyon/evidence/`). Dismissing the author is a no-op on task bytes. | `forgetAgent.ts:9-20` |
| Prototypes | Same parent directory, different store: `…/<task-id>/prototypes/<sha256>/prototype.html` + `prototypes.json`. Own lifecycle (`draft/approved/superseded/rejected`), HTML policy, 512 KB cap, Bridge `attach_task_prototype`. | `TaskPrototypeStore.ts:65-77, 79-112`, `tasks.ts:57-81` |

Live primary: **5** task attachment directories, **908 KB**. Sidecar samples are `source: "paste"`, png, 69–106 KB. One directory (`t-ec39b9`) holds only a prototype, no blobs.

### 1.3 Why 273/274 cannot be the task store

Not “limited”. These mechanisms **prevent** reuse as a Task attachment:

1. **The namespace key is the agent name**, not a task id. `evidenceArtifactRelDir(agent, id)` → `.tachyon/evidence/<agent>/<id>/`. `WorktreeEvidence` has `targetAgent` and no `taskId` (`evidence.ts:40-50`). Putting a task screenshot there binds the bytes to whoever was `targetAgent` that day.
2. **The write door requires a live worktree.** `attachEvidence` refuses `'…' has no worktree — evidence is worktree-scoped` (`Workspace.ts:4681-4682`). Coordinators and agents in the primary checkout cannot attach.
3. **Nothing binds the record to a Task.** The Bridge tool takes `targetAgent`, not `taskId`. There is no render path from an evidence record into the task card.
4. **A 100-record oldest-drop still exists on the ledger path.** Even though disk listing no longer honors it, the store’s contract is “cap and drop”, which is the retention the owner cut on t-1d198e.
5. **Copy has no image allowlist and no size cap.** It will durably copy any regular file the worktree can read. The task card store already refuses SVG and caps at 10 MB.

Creating `.tachyon/attachments/` (the 2026-07-10 journal’s OQ4 home) would be a **third** byte store next to evidence and `TaskAttachmentStore`. That is the machine the brief forbids.

The 273/274 machinery that **is** reusable is the ingest *pattern*: `isSafeArtifactRef` + `lstat` regular-file + copy-out-of-worktree. Destination must be `TaskAttachmentStore.writeBlob` / `putImage`, not the evidence directory.

---

## 2. Lifecycle — who owns the bytes, what happens when the agent is gone

**The Task owns the bytes. Dismissing the attaching agent does not delete them, hide the caption, or unbind the render.**

That is already true of the human path, and it is the only ownership that matches the brief (“a closed card months later still shows the print”).

| Event | Evidence store (273/274, after t-1d198e) | Task attachments (339, today) | What the primitive must do |
|---|---|---|---|
| Agent dismissed (`forgetAgent`) | Ledger row gone; `record.json` + files stay under `.tachyon/evidence/<agent>/` | Unchanged. Footprints do not include `.tachyon/tasks/` | Same: no-op. Do not add a forget footprint. |
| Worktree rebuilt / removed | Files already outside the worktree | Files already outside the worktree | Same. |
| Task dropped | n/a (not task-scoped) | Sidecar + blobs kept | Same. Do not treat `dropped` as delete. |
| Task hard-deleted | n/a | `TaskDetailStore.delete` would wipe the namespace; **no production caller** | Do not invent a delete door. If one is added later, it already knows this directory. |
| Studio save after a body/sidecar split | n/a | `projectTaskStudio` on reimport sets `attachments: []` (`taskStudioProjection.ts:120-122`). Next save `gcRemovedAttachments` **deletes the blobs**. | This is the t-1d198e-shaped trap for *this* store. The primitive must write blob + sidecar `attachments[]` + `bodyHash` (and the `attachment:` body ref) in one transaction, so the next Studio open **loads**, not reimports. |

t-1d198e, measured: 110 folders / 29.6 MB / 7 live records / 103 folders without the text that explained them. Cause (not guessed): caption in `sessions.json`, files not in `FORGET_AGENT_FOOTPRINTS`. Fix: `record.json` next to the files.

A Task attachment has the same silhouette and a different owner. The caption today is the sidecar row (`id`, `name`, `mediaType`, `blobRef`) plus the `![alt](attachment:<id>)` in `task.body`. The files are the sha256 blobs. If the tool writes the blob and leaves the sidecar/body to a later `update_task`, a Studio reimport+save will garbage-collect the proof, or forget will not — the bytes will sit with no legend. **Record and files must be born together, owned by the Task, and must not die with the agent.**

Who deletes, then? Only an explicit later hard-delete of the Task (not implemented on a production path today) or a human removing the image in Studio and saving (existing GC). No retention, no expiry, no scheduled cleanup — there is no measured space defect (task attachments on the primary are 908 KB; the owner already declined to invent cleanup for 321 MB of evidence).

---

## 3. Proposal — reuse 339, add a Bridge door

If the owner decides the primitive enters the product, this is the smallest door. The store, allowlist, size cap, traversal check, content-addressing, inline render, and drop-vs-delete policy already exist. What would be added is an agent-authenticated write that stamps provenance and keeps caption + bytes + body ref together.

This section is a proposal, not a request to proceed.

### Reuse

- `TaskAttachmentStore.putImage` / `writeBlob` — the bytes.
- `TaskDetailStore` sidecar `attachments[]` + `bodyHash` + `doc` — the caption.
- Existing `![alt](attachment:<id>)` body form — the card render. No new surface.
- `isSafeArtifactRef` + `lstat` regular-file check — ingest from a worktree/workspace path (pattern from 274, not the evidence directory).
- Spec 351 `resolveDeclaredActor` / Bridge-resolved `caller` — `producedBy`. Never a caller-supplied identity.
- Image allowlist and 10 MB cap already on the store (`png/jpeg/webp/gif`).
- Parent directory already shared with prototypes (`.tachyon/tasks/attachments/<task-id>/`).

### Add (small)

1. **Bridge tool** `attach_task_attachment` (name as on the card), agent-authenticated only, same shape as `attach_task_prototype`:
   - `taskId` (must exist)
   - `mediaType` (store allowlist; anything else refused)
   - **exactly one** of `bytes` (canonical base64) or `ref` (relative path)
   - `title`, `alt` (bounded)
   - Host stamps `id` (`att-<6 hex>`), `createdAt`, `producedBy` = resolved caller, `source: "agent"`
   - Receipt: `{ id, blobRef, mediaType, size, producedBy }` — not the image
2. **Ingest**
   - `bytes`: tool-string cap **512 KB** (same number `attach_task_prototype` already uses for HTML). Covers the live human pastes (69–106 KB). Decoded payload still goes through `putImage` (10 MB / allowlist).
   - `ref`: traversal-checked, `lstat` regular file, then read + `putImage`. If the caller has a worktree, resolve against that worktree (274’s door). If not, resolve against `workspaceRoot`. Either way the bytes land in the **task** namespace, not `.tachyon/evidence/`.
   - Both or neither → refuse. No second, unaudited path.
   - No two-step upload handle. Task Studio’s staged-payload channel is a UI host pipe, not a Bridge primitive.
3. **One write transaction** (the t-1d198e lesson applied here)
   - `putImage` first.
   - Then, together: append the attachment on the sidecar; insert an image node in the sidecar `doc`; set `bodyHash` to `hash(task.body)` after the body update; append `![alt](attachment:<id>)` to `task.body` when the 4000-code-point body cap has room.
   - If the metadata write fails, delete the blob only when nothing else references that sha256 (same rollback `TaskPrototypeStore.createDraft` already does at `:105-109`).
   - If body is at the cap: still persist sidecar attachments + doc; receipt says the detail body could not take the ref. Do not invent a gallery.
4. **`get_task`** includes a compact `attachments` summary (id, mediaType, name, available, producedBy), the way it already includes `prototypes`. Spec 339 F15 called sidecar invisibility a limitation; this is that follow-up, for the new writer only.
5. **Schema:** add `"agent"` to `AttachmentSource` and optional `producedBy` on `ImageAttachment`. Shared with pins; pins never write those values. Without `producedBy` on the sidecar row, the caption is “a png named image.png” and the author dies with the session — the 103-folder shape again.

### Actor × trigger (the test list)

| Actor | Trigger | Required outcome |
|---|---|---|
| Agent | `attach_task_attachment` | Blob + sidecar row + body ref (if room) born together; `producedBy` is Bridge-resolved |
| Agent | same, then `forgetAgent` | `get_task` still returns the attachment; blob still on disk |
| Agent | no worktree, `bytes` | Succeeds (does not require a worktree) |
| Agent | no worktree, `ref` | Resolves against workspaceRoot; traversal/symlink refused |
| Agent | worktree `ref` to a symlink / `..` / missing file | Refused; no sidecar mutation |
| Agent | SVG / pdf / oversize | Refused by the existing store allowlist/cap |
| Agent | `update_task` body with a fake `attachment:att-…` | Dangling ref only; cannot mint a blob (no trust-the-caller side path) |
| Human | Studio paste/drop/import | Unchanged |
| Human | Studio open after a successful attach (hashes match) | `anchor: load`, attachments include the new row |
| Human | Studio open after a body-only edit (hashes mismatch) | `anchor: reimport`, `attachments: []` — **existing** trap; the new tool must not create this state |
| Human | drop the task | Bytes stay |
| Human / system | hard-delete (if a caller is ever wired) | `TaskDetailStore.delete` already removes the namespace |
| Human | staged-create cancel | Provisional dir already removed |

Never a gate. An attachment informs, same as 273.

### Open questions from the card, answered by measurement

| OQ | Answer |
|---|---|
| (1) inline vs ref vs two-step | Both inline (`bytes`, 512 KB string) and `ref` (copy then `putImage`). No two-step handle. |
| (2) subsume `attach_task_prototype`? | **No.** Prototypes have draft/approve/reject, HTML policy, 512 KB srcdoc, human-only approval. Images do not. They already share a parent directory. Keep the tools separate. |
| (3) SVG | **Refuse in v1.** `TaskAttachmentStore.putImage` already throws `unsupported` on `image/svg+xml` (`taskAttachmentStore.test.ts:60`). Do not route SVG through untrustedSrcdoc (that path is HTML prototypes, spec 349/366). |
| (4) storage + gitignore | Already resolved by the existing store: `.tachyon/tasks/attachments/<task-id>/`, under gitignored `.tachyon/` (`.gitignore:16`). The 2026-07-10 note that named `.tachyon/attachments/` is stale. Git-tracked `docs/assets/` was a workaround for a missing primitive, not the home. |

---

## 4. What the primitive must not do

| Must not | Why |
|---|---|
| Create a new store or `.tachyon/attachments/` | Two byte stores already exist. A third is the machine the owner cuts. |
| Write into `.tachyon/evidence/<agent>/` | That namespace is the agent, dies as a key when the name is forgotten, and does not render on the card. |
| Add a `forgetAgent` footprint for task attachments | That is how t-1d198e lost 103 captions. The Task outlives the agent. |
| Invent retention, expiry, or scheduled cleanup | Owner cut this on t-1d198e: no measured space defect; deleting proof is the wrong reaction. Primary task attachments are 908 KB. |
| Ship `attach_task_image` as a one-off | Card: image is a `mediaType` on the existing store. |
| Trust caller-supplied `producedBy` / `id` / `createdAt` | Spec 351. Host stamps. |
| Accept SVG or PDF in v1 | No allowlist entry, no image render path, SVG is untrusted markup. |
| Subsume prototypes | Different contract (approval lifecycle + HTML policy). |
| Design or add a new card surface | Existing `attachment:` body resolve is the render. Where else it appears is the owner’s. |
| Require a worktree | Evidence’s worktree gate is exactly why this primitive cannot live there. |
| Write the blob without the sidecar row (or the reverse) | Orphan bytes or a caption with `available: false`. Same split, new folder. |
| Gate, block, or approve via the attachment | Parity with 273’s never-gates rule. |
| Touch `tachyon.yml` | Coordinator-owned. |

---

## 5. What this pass did not measure

- **No MCP-protocol 512 KB ceiling was found in this tree.** The number on the card matches `attach_task_prototype`’s HTML `z.string().max(512 * 1024)` and the Studio prototype-import check. Task Studio’s own image wire allows ~14 M base64 chars (10 MB decoded) over the **host** staged-payload channel (64 MB). I did not put a large base64 payload through a live MCP runtime to see who refuses first.
- I did not run a live `attach_evidence` + dismiss cycle. Lifecycle of evidence after t-1d198e is from landed code (`evidenceStore.ts`, `evidenceSurvivesDismiss.test.ts`) and the primary disk (8 `record.json`, dismissed `acpfleet` still has folders and no records).
- I did not open Task Detail / Task Studio in a browser. Render path is from `taskDetailVm.ts` + `markdownDoc.ts` + tests. This change does not touch UI.
- I did not dogfood the reimport+save GC trap with a real Studio session. The empty `attachments: []` on reimport is in `taskStudioProjection.ts:120-122`; GC is in `TaskDetailStore.gcRemovedAttachments`.
- I did not count how many of the 128 live evidence directories are post-t-1d198e-orphans vs pre-existing. t-1d198e already measured 103/110 on 2026-08-14; this pass only confirmed the shape is still on disk.
- I grepped this tree for a production `TaskDetailStore.delete` caller and found none. A caller could exist behind a name I did not search, or land later.
- `src/bridge/tools.ts` and `src/worktree/evidence.ts` (paths on the card) have moved to `packages/bridge/src/tools/` and `packages/engine/src/worktree/`. The 2026-08-02 premise scan cited the old paths; the gap (`attach_task_attachment` missing) is still true.
- I did not search every journal line of every open task for “I wanted to attach a png and could not”. The open-board scan is title+body+`artifact_refs` only.

---

## 6. What happens if we do not build it

Measured on the live primary board, 2026-08-15 (1485 task JSON files).

| Fact | Number |
|---|---|
| Open tasks (`inbox`/`triaged`/`active`) | 81 |
| Open tasks with an image-looking `artifact_ref` | **0** |
| Open tasks with a Studio sidecar image | **0** |
| Tasks (any status) with `artifact_refs.type = "image"` | 3, all `done` |
| Image-looking refs (type `image`/`screenshot` or an image extension) | 34 refs on 23 tasks, **all `done`** |
| Of those, host-absolute Windows paths (`/mnt/c/Users/cfpp/Pictures/Screenshots/…`) | 23 refs on 17 tasks, all `done`; a sample path is already gone from disk |
| Git-tracked `docs/…` screenshot refs | 5, all `done` (spec evidence + the t-b8ff2c workaround) |
| `.tachyon/evidence` or `.tachyon/vqa` screenshot refs | 6, all `done` |
| Human Studio pastes on disk | 3 images on 2 tasks (`t-faad51`, `t-3cc2e8`), both `done`, `source: "paste"` |
| Live prototypes | 1 (`t-ec39b9`) |
| Days this card has sat on the board | 35 (filed 2026-07-10, still “low urgency”) |

The motivating file for the card, `docs/assets/sidebar-hierarchy-confusion.png` on `t-b8ff2c`, was committed (`921d884e`) and later deleted as obsolete (`57cdf1dc`). `t-b8ff2c` is `done`. The git-tracked workaround did not survive; the work did.

Four channels already carry pictures without this primitive:

1. **Human paste/drop in Task Studio** — the only path that renders inline on the card. Used. Small.
2. **`attach_evidence`** — agent visual-QA screenshots, worktree-scoped, not on the card. This is the intended channel for “I judged this UI”.
3. **Git-tracked `docs/specs/…/evidence/*.png` + `artifact_ref`** — visible in an implementer’s worktree. Used for spec-owned proof.
4. **A path in `artifact_ref`** — pointer only, no bytes, no render. 23 of those pointers were host-absolute and are already dead. Those tasks still closed.

Open tasks whose title or body mention “screenshot” / “attach image” are `t-774369` (this card), plus three unrelated studies (`t-e23e57` computer-use, `t-b0a229` design-system map, `t-89be6a` UI skill). None of them is waiting on a Bridge attach door to move.

**If we do not build it:** humans keep pasting; agents keep using evidence, spec `evidence/` folders, and path refs; closed cards keep whatever they already have; no open row on this board loses a writer. The thing that stays missing is exactly what the card named on 2026-07-10: an agent cannot put durable bytes on a Task so the card renders them the way a human paste does.

That absence has not been measured to block anyone in the 35 days since. The broken host-absolute refs show the workaround is lossy — but the loss is on finished work, and the owner already accepted gitignored `.tachyon/` as the home for live board state. Not building leaves a known ergonomic hole and avoids a new agent-write into a shared card surface (the governance the card itself called the moat).

This packet stops here.
