# ide-browser-dogfood

Dev Host fixture for Integrated Browser + Design Mode.

**Manual UX (no auto-open):**

1. Point Dev Host at this fixture / worktree and launch EDH.
2. Set `settings.ideBrowser.homeUrl` in `tachyon.yml` to your app URL (default in this fixture: `about:blank`).
3. Only agent intended: **grok** (create/start from Tachyon when you want).
4. Click **IDE Browser** on the status bar (globe) — opens `homeUrl`, nothing auto-opens on activate.
5. Click **Design Mode** on the status bar to pick elements → send to grok.

Output channel: **Tachyon IDE Browser**.

## Design Mode

1. Open browser (globe) → page loads.
2. **Design Mode** ON → launcher ✦ on page.
3. Click an element → panel beside the site (two cards).
4. Note + **Send to agent**.
5. Design Mode OFF only from the status bar.
