import katex from "katex";
// Exposed for on-demand loading by the activity webview (injected when a math span first appears).
(window as unknown as { katex: typeof katex }).katex = katex;
