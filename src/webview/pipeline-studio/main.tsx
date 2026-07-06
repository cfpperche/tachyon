import { render } from "preact";
import { App } from "./App";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

function Root() {
  return <App dispatch={{ post: (msg) => (vscode ? vscode.postMessage(msg) : window.postMessage(msg, "*")) }} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
