import { render } from "preact";
import { App } from "./App";

// The webview iframe entry. acquireVsCodeApi() is available for future host messaging (the visual
// prototype doesn't post yet). Render the Preact app into the shell's #root.
const root = document.getElementById("root");
if (root) render(<App />, root);
