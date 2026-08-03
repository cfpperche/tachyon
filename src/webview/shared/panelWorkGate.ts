import type * as vscode from "vscode";

/**
 * SDD 485 Phase B — a hidden editor panel does no WORK.
 *
 * Not "a hidden panel costs nothing": every first-party panel here sets `retainContextWhenHidden: true`,
 * so a hidden panel keeps its iframe, its DOM and its memory. That is deliberate (instant reveal, no
 * remount) and this gate does not change it. What goes to zero is the work the HOST does on its behalf —
 * refreshes, collections, subscriber callbacks and model posts — while nobody is looking at it.
 *
 * The dangerous half is not the suppression, it is the catch-up. t-b51923 (the 40 ev/s → 2.4 ev/s
 * coalescing fix) had the same shape one layer up, and its whole safety argument was the trailing edge:
 * swallow the last invalidation and the view is stale FOREVER, with no second chance. Trading slowness
 * for wrong data is a bad trade. So the catch-up is designed first and the suppression second:
 *
 *   - while hidden, every suppressed invalidation is journaled, in order, in a BOUNDED window;
 *   - on reveal, the window covers what was missed → replay it as a DELTA (each distinct kind once,
 *     the same coalescing the producer already applies: an invalidation says "this view is stale",
 *     never what changed, so N identical ones hold exactly the information of one);
 *   - the window does NOT cover it (it overflowed, or the upstream event cursor itself resynced) →
 *     full RESYNC. We stop claiming to know what changed and rebuild everything.
 *
 * The mirror is deliberate: `WorkspaceClient` already answers a lost event cursor with `resynced: true`
 * and a full snapshot. This is the same bargain at the panel layer, with the same word for it.
 */

/** Kinds are surface-local strings (`"mission"`, `"referenceData"`, …) — the gate never interprets them. */
export type CatchUpDecision<K extends string = string> =
  | { mode: "none" }
  | { mode: "delta"; kinds: K[]; suppressed: number }
  | { mode: "resync"; reason: "window-overflow" | "source-resync"; suppressed: number };

export interface CatchUpJournal<K extends string = string> {
  /** Suppressed invalidations still inside the retention window, oldest first. */
  entries: readonly K[];
  /** Invalidations evicted because the window filled — the reason a delta can no longer be proven. */
  dropped: number;
  /** The UPSTREAM source lost its own cursor while we were hidden (`WorkspaceClient.resynced`). */
  sourceResync: boolean;
}

/**
 * The whole catch-up policy, as a pure function — the same shape (and the same reason) as
 * `studio/restoreDecisions.ts`: the branch that must never be wrong is the one that must be
 * readable and testable without a panel, a webview or a clock.
 */
export function decideCatchUp<K extends string>(journal: CatchUpJournal<K>): CatchUpDecision<K> {
  const suppressed = journal.entries.length + journal.dropped;
  if (journal.sourceResync) return { mode: "resync", reason: "source-resync", suppressed };
  if (journal.dropped > 0) return { mode: "resync", reason: "window-overflow", suppressed };
  if (journal.entries.length === 0) return { mode: "none" };
  const kinds: K[] = [];
  for (const kind of journal.entries) if (!kinds.includes(kind)) kinds.push(kind);
  return { mode: "delta", kinds, suppressed };
}

/**
 * The narrow visibility surface the gate needs. A `WebviewPanel` (view state) and a `WebviewView`
 * (visibility) both reduce to it, and a test can supply one without a vscode stub.
 */
export interface VisibilitySource {
  readonly visible: boolean;
  onDidChangeVisible(listener: () => void): { dispose(): void };
}

/** Adapts an editor panel. `visible`, NOT `active`: a panel side by side with the focused one is being
 *  looked at, and must keep working — the whole point of the spec this serves is two live apps at once. */
export function panelVisibility(panel: vscode.WebviewPanel): VisibilitySource {
  return {
    get visible(): boolean { return panel.visible; },
    onDidChangeVisible: (listener) => panel.onDidChangeViewState(() => listener()),
  };
}

/**
 * How many suppressed invalidations the journal retains before it gives up on proving a delta.
 * At the post-t-b51923 production rate (~2.4 `views-changed`/s) this is roughly half a minute of
 * hiding; past that, one full resync on reveal is cheaper AND safer than replaying a long tail.
 */
export const DEFAULT_CATCH_UP_WINDOW = 64;

export interface PanelWorkGateOptions<K extends string> {
  /** Replay one journaled invalidation. Called once per DISTINCT kind, oldest first. */
  replay: (kind: K) => void;
  /** Rebuild everything. Called when the window did not cover what was missed. */
  resync: () => void;
  /** Retention window, in suppressed invalidations. */
  windowSize?: number;
  /**
   * Run on EVERY reveal, before the journal's decision is applied — including `mode: "none"`.
   *
   * For a source that keeps its own journal and was paused rather than journaled here (Control's
   * activity feed: the durable log IS the journal, and it catches up from its own byte offset).
   * Such a source can change while ZERO invalidations arrive, so hanging its catch-up off the
   * decision would leave it stale for exactly the case it exists to cover.
   */
  onReveal?: () => void;
  /** Instrumentation seam — what the reveal decided, and how much it was hiding from. */
  onCatchUp?: (decision: CatchUpDecision<K>) => void;
}

export class PanelWorkGate<K extends string = string> {
  private entries: K[] = [];
  private dropped = 0;
  private sourceResync = false;
  private lastVisible: boolean;
  private readonly windowSize: number;
  private readonly subscription: { dispose(): void };
  private disposed = false;

  constructor(
    private readonly source: VisibilitySource,
    private readonly options: PanelWorkGateOptions<K>,
  ) {
    this.windowSize = options.windowSize ?? DEFAULT_CATCH_UP_WINDOW;
    this.lastVisible = source.visible;
    // View-state events fire for focus changes too; only a hidden→visible transition is a reveal.
    this.subscription = source.onDidChangeVisible(() => this.onVisibilityChanged());
  }

  get visible(): boolean {
    return this.source.visible;
  }

  /** Suppressed invalidations currently held — instrumentation and tests, never a decision input. */
  get pending(): number {
    return this.entries.length + this.dropped;
  }

  /**
   * Do `work` now if the panel is visible; otherwise journal `kind` and do NOTHING.
   * Returns whether the work ran, so a caller can count work instead of guessing at it.
   */
  run(kind: K, work: () => void): boolean {
    if (this.disposed) return false;
    if (this.source.visible) {
      work();
      return true;
    }
    this.record(kind);
    return false;
  }

  /**
   * The upstream event cursor expired while we were hidden, so "what changed" is unknowable from the
   * journal alone. Forces the resync branch on reveal even if the window itself never overflowed.
   */
  markSourceResync(): void {
    if (this.disposed || this.source.visible) return;
    this.sourceResync = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    this.entries = [];
    this.dropped = 0;
    this.sourceResync = false;
  }

  private record(kind: K): void {
    this.entries.push(kind);
    while (this.entries.length > this.windowSize) {
      this.entries.shift();
      this.dropped += 1;
    }
  }

  private onVisibilityChanged(): void {
    if (this.disposed) return;
    const visible = this.source.visible;
    const revealed = visible && !this.lastVisible;
    this.lastVisible = visible;
    if (!revealed) return;
    const decision = decideCatchUp<K>({ entries: this.entries, dropped: this.dropped, sourceResync: this.sourceResync });
    this.entries = [];
    this.dropped = 0;
    this.sourceResync = false;
    this.options.onReveal?.();
    this.options.onCatchUp?.(decision);
    if (decision.mode === "delta") for (const kind of decision.kinds) this.options.replay(kind);
    else if (decision.mode === "resync") this.options.resync();
  }
}
