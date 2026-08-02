/**
 * One exclusive tmux client per session — the arbiter both viewports consult (t-feaaea).
 *
 * A tmux session can hold several clients at once, and Tachyon has two viewports onto the same
 * session: layer 1 (VS Code integrated terminal, `Terminals`) and layer 2 (Agent Pane, node-pty).
 * Both attach with `attach-session -d`, which EVICTS every other client. Measured on tmux 3.6 with
 * two real clients (220×50 and 80×24) on one session:
 *
 * - while both are attached, tmux resizes the window to the newest client and fills the larger
 *   client's leftover area with `·` — 8836 of them in one redraw. That is tmux drawing the true
 *   state, not a renderer bug on our side, and it disappears on its own once the session is
 *   single-client again;
 * - ~9ms later the older client is evicted by `-d` and exits cleanly (exitCode 0, signal 0) while
 *   the session keeps running.
 *
 * That is the reported defect exactly: dots around the TUI, then `detached`. The fix is ordering,
 * not cosmetics — the incoming viewport CLAIMS the session, the outgoing one releases its client
 * first, and the two never overlap. No overlap means no dot fill and no surprise eviction.
 *
 * Who else can reach this? Every door that attaches a client to an agent session must claim here:
 * - Interface → sidebar "Open terminal" → engine `terminal.present` → `Terminals.open`
 * - Interface → window restart → `Terminals.restoreOpen` → `Terminals.open` (same funnel)
 * - Agent → Bridge `spawn_terminal` / `run_command` → engine → same funnel
 * - Interface → server inspector → its own `createTerminal` (extension.ts openSession)
 * - Interface → "Open Agent Pane" / Reattach → `AgentPanePanelManager`
 * - a human running `tmux attach` in their own shell — NOT our door. It cannot be arbitrated; the
 *   pane survives it now (nobody evicts it) and tmux repaints clean when that client leaves.
 */

export type SessionViewportKind = "pane" | "terminal";

/** Called when another viewport takes the session; the owner must drop its tmux client. */
export type SessionViewportRelease = (taker: SessionViewportKind) => void;

export class SessionViewportRegistry {
  private readonly owners = new Map<string, { kind: SessionViewportKind; release: SessionViewportRelease }>();

  /**
   * Take exclusive ownership of `session` and release the previous owner BEFORE the caller
   * attaches. Re-claiming with the same kind only refreshes the release hook — a viewport must
   * never be asked to release itself (that would tear down the client it is about to use).
   */
  claim(session: string, kind: SessionViewportKind, release: SessionViewportRelease): void {
    const previous = this.owners.get(session);
    // Record the new owner first so a release hook that re-enters (closing a tab fires close
    // handlers, which call `release`) sees the taker as owner and clears nothing.
    this.owners.set(session, { kind, release });
    if (!previous || previous.kind === kind) return;
    try {
      previous.release(kind);
    } catch {
      /* a viewport that cannot let go must not block the one the human is opening */
    }
    // Re-assert the taker: a viewport losing the session must not grab it back from inside its own
    // release hook, or the two doors ping-pong the tmux client between them.
    this.owners.set(session, { kind, release });
  }

  /** Give up ownership when this viewport closes. A stale kind is ignored (someone else owns it). */
  release(session: string, kind: SessionViewportKind): void {
    if (this.owners.get(session)?.kind === kind) this.owners.delete(session);
  }

  ownerOf(session: string): SessionViewportKind | undefined {
    return this.owners.get(session)?.kind;
  }
}
