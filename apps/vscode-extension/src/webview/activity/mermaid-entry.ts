import mermaid from "mermaid";
// Exposed for on-demand loading by the activity webview (injected as a script when a mermaid block appears).
(window as unknown as { mermaid: typeof mermaid }).mermaid = mermaid;
