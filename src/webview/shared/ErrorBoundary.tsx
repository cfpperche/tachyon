import { Component, type ComponentChildren } from "preact";

/**
 * t-668b05 — Control had ZERO error boundaries anywhere: an uncaught exception thrown during ANY
 * embedded surface's render (a malformed on-disk record, a bad host push, anything) took down the
 * ENTIRE Cockpit webview to a blank/black panel with no visible error — `<Suspense>` around each lazy
 * surface only covers the import-pending state, never a thrown render error. This is the ONE catch-all
 * safety net: wraps the whole render tree in cockpit/main.tsx so a future bug degrades to a visible,
 * dismissable error message instead of silently blanking the panel. Preact's error-boundary contract
 * (`getDerivedStateFromError`/`componentDidCatch`) requires a class component — no hook equivalent.
 */
interface ErrorBoundaryState {
  error: Error | undefined;
}

export class ErrorBoundary extends Component<{ children: ComponentChildren }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error("[tachyon] Control render crashed", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
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
        <div style={{ opacity: 0.85, marginBottom: "10px", fontFamily: "var(--vscode-editor-font-family, monospace)", fontSize: "12px" }}>
          {error.message}
        </div>
        <button type="button" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </div>
    );
  }
}
