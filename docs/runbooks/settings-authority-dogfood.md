# Dogfood: the one settings authority (`t-aaad95`)

**Who runs this:** a human, in a real VS Code window. **Why a human:** every step below is a claim about
what a person sees and can repair. The suite proves the parser, the import planner and the guard; it
cannot prove that a window shows the value, that a toggle lands in a file, or that a broken file can
still be fixed — and "a green focused test does not replace live dogfood for UI/runtime claims" is a
standing rule in this project.

This is the last unmet `done when` on `t-aaad95`. Until it passes, the change does not land.

## Before you start

- Install the candidate VSIX, or run the Dev Host (`npm run dogfood:dev-host -- point --fixture <slug>`,
  then F5 **in that checkout**).
- Note your global file's path: `~/.tachyon/settings.json`. If you set `TACHYON_GLOBAL_SETTINGS_HOME`,
  it is `$TACHYON_GLOBAL_SETTINGS_HOME/.tachyon/settings.json` instead.
- **Back up an existing `~/.tachyon/settings.json`** if you have one. Step 4 deliberately breaks it.

Record the result of each step. A step that could not be run is not a step that passed.

---

## 1. Control edits the global scope, and the change is real

1. Open **Control → Settings**. The block **"Your Tachyon settings"** shows the file path.
2. Set **Activity code theme** to `Dark`.
3. Open the file (button: **Open the file**, or the palette: `Tachyon: Open Global Settings File`).

**Expect:** `"activity": { "codeTheme": "dark" }` is in the file. The document has `"version": 1`.

4. Toggle **Agent pane** off, then on. Set **Path to git** to `/usr/bin/git` and press **Save**.

**Expect:** each lands in the file. No stray `.settings.json.*.tmp` beside it — writes are temp+rename,
and a leftover temp file means a write path is not transactional.

## 2. Live vs. reopen is stated, and true

Each row says whether it takes effect immediately or waits for Control to be reopened.

- **Agent pane** and **Path to git** say *takes effect immediately*. Turn the agent pane off and open an
  agent pane from the sidebar: it must refuse with a message pointing at Tachyon settings, and the
  integrated terminal must still work.
- **Activity code theme** says *applies the next time Control is opened*. Close and reopen Control; the
  Activity code blocks follow the theme you chose.

**Expect:** the label matches reality in both directions. This is the step most likely to fail quietly:
with the VS Code settings UI gone, a wrong label is the only thing a person has to go on.

## 3. A hand edit is picked up without a reload

1. With Control open, edit `~/.tachyon/settings.json` by hand and change `activity.codeTheme`.
2. Add a personal card template:
   ```json
   { "version": 1, "sidebar": { "cardTemplate": { "version": 1, "meta": ["harness"] } } }
   ```

**Expect:** the sidebar agent cards repaint with the new `meta` row **without** reloading the window.
Regions you did not list keep whatever the project's `tachyon.yml` chose.

## 4. Recovery — the step this design owes the most to

Break the file on purpose:

```json
{ "version": 1, "gitPath": /* half-typed */ }
```

**Expect, in order:**

1. Tachyon keeps running on the **last known good** values — it does not reset your machine.
2. The sidebar shows a refusal banner naming **the file** and the error.
3. **The agent pane still works.** `agentPane.enabled` fails toward *enabled*, so a broken document can
   never hide a surface you would need to repair it. If the pane is hidden here, **stop — that is a
   blocking failure**, not a cosmetic one.
4. `Tachyon: Open Global Settings File` opens the broken file **as you typed it**. It must NOT be
   rewritten or repaired for you: your text is what you came back to fix.
5. Editing a value in Control while the file is refused fails with a message telling you to fix the file
   first. It must not overwrite the broken document.

Fix the JSON. Everything recovers with no reload.

## 5. Zero workspace

Close every folder (`File → Close Folder`) so no workspace is open.

**Expect:** `Tachyon: Open Global Settings File` still runs from the palette and opens (or creates) the
file. A contributed command with no handler here was a real defect; this step is what catches its
return.

## 6. The project scope, and the multi-root rule

1. In a project's `tachyon.yml`, set:
   ```yaml
   settings:
     maxAgents: 3
     worktree:
       revealInWorkspace: false
   ```
2. **Expect:** spawning a fourth agent refuses with `maxAgents limit reached (3)`.
3. In a **multi-root** window with a second project that does *not* set `revealInWorkspace`:

**Expect:** the opted-out project's worktrees are **not** revealed, and the other project's worktrees
**are**. One project's opt-out must not hide the other's. Then set it back to `true` — the folders come
back; set it to `false` again — its folders are removed, not merely left behind.

## 7. The one-time import (needs a machine that still has the old settings)

On a profile that had `tachyon.*` keys in VS Code settings **before** upgrading:

**Expect:**
- The per-person keys land in `~/.tachyon/settings.json`, and a notification says so.
- The per-project keys land in that project's `tachyon.yml`, and the notification **names the file and
  the keys**, because that file is tracked and the change would otherwise ride along in the next commit.
- The effective `maxAgents` is the number you had before, not `8`.
- Re-activating (reload the window) writes nothing further and shows no second notification.
- A value already set in the new home is **not** overwritten — including one deliberately set to what
  happens to be the default.

## 8. Remote (only if you use Remote SSH/WSL/Containers)

**Expect:** the global file lives on the side where the extension host runs, and Tachyon reads it there.
Your local preferences do **not** follow you into the remote. This is the accepted loss recorded in
`docs/proposals/tachyon-settings-single-authority.md` §5 — confirm it behaves as described rather than
failing in some other way.

---

## Reporting

Append the outcome to `t-aaad95`'s journal: which steps passed, which failed, and on what build. Step 4.3
and step 5 are the two whose failure blocks the change outright; the rest are ordinary bugs to file.
