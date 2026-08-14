import { render } from "preact";
import { App } from "./App";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  return <App dispatch={{ post: (msg) => (vscode ? vscode.postMessage(msg) : window.postMessage(msg, "*")) }} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
