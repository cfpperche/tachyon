import { Component, cloneElement, type VNode } from "preact";

/**
 * t-668b05 — Control had ZERO error boundaries anywhere: an uncaught exception thrown during ANY
 * embedded surface's render (a malformed on-disk record, a bad host push, anything) took down the
 * ENTIRE Cockpit webview to a blank/black panel with no visible error — `<Suspense>` around each lazy
 * surface only covers the import-pending state, never a thrown render error. This is the ONE catch-all
 * safety net: wraps the whole render tree in cockpit/main.tsx so a future bug degrades to a visible,
 * dismissable error message instead of silently blanking the panel. Preact's error-boundary contract
 * (`getDerivedStateFromError`/`componentDidCatch`) requires a class component — no hook equivalent.
 *
 * Round-1 code-review finding: "Try again" merely clearing `state.error` does NOT guarantee recovery —
 * the child tree (`<Root/>` in cockpit/main.tsx) keeps its OWN hooks/state across the catch (same
 * element identity, no remount), so if whatever data caused the crash is still there, the very next
 * render throws the SAME error again, in a loop, with no visible sign anything happened. Fixed via
 * `resetGeneration`: every "Try again" click clones the single child with a NEW `key`, forcing Preact
 * to fully discard the old (possibly-corrupted) instance and mount a genuinely fresh one — a real
 * reset, not just clearing this boundary's own local flag. `children` is typed as exactly one VNode
 * (not general ComponentChildren) because cloning to retarget `key` only makes sense for a single
 * element — this component only ever wraps one thing (`<Root/>`).
 */
interface ErrorBoundaryState {
  error: Error | undefined;
  resetGeneration: number;
}

export class ErrorBoundary extends Component<{ children: VNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined, resetGeneration: 0 };

  static getDerivedStateFromError(error: unknown): Pick<ErrorBoundaryState, "error"> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error("[tachyon] Control render crashed", error);
  }

  private reset = (): void => {
    this.setState((prev) => ({ error: undefined, resetGeneration: prev.resetGeneration + 1 }));
  };

  private copyDetails = (): void => {
    const { error } = this.state;
    if (!error) return;
    const details = `${error.name}: ${error.message}\n${error.stack ?? "(no stack trace captured)"}`;
    void navigator.clipboard?.writeText(details);
  };

  render() {
    const { error, resetGeneration } = this.state;
    if (!error) {
      // t-668b05 round-1 — keyed on resetGeneration so a "Try again" click always mounts a genuinely
      // NEW instance of the child (see class doc comment above for why clearing `error` alone isn't
      // a real reset).
      return cloneElement(this.props.children, { key: resetGeneration });
    }
    return (
      <div
        role="alert"
        style={{
          margin: "24px",
          padding: "16px",
          border: "1px solid var(--vscode-inputValidation-errorBorder, #a1260d)",
          background: "var(--vscode-inputValidation-errorBackground, #5a1d1d)",
          color: "var(--vscode-editor-foreground, #fff)",
          borderRadius: "4px",
          fontFamily: "var(--vscode-font-family, sans-serif)",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: "6px" }}>Something went wrong rendering this view.</div>
        <div style={{ opacity: 0.85, marginBottom: "10px", fontFamily: "var(--vscode-editor-font-family, monospace)", fontSize: "12px", whiteSpace: "pre-wrap" }}>
          {error.name}: {error.message}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" onClick={this.reset}>Try again</button>
          <button type="button" onClick={this.copyDetails}>Copy details</button>
        </div>
      </div>
    );
  }
}
