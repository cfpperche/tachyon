import { render } from "preact";
import { Studio } from "./App";
import { readyMessage, type StudioAction } from "./messages";

// spec 279 — the Agent Studio webview entry (converted from AgentForm's inline <script>). `preact-live`, both
// directions. Never imports vscode (engine boundary). The form logic lives in formLogic.ts (unit-tested).
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

const post = (a: StudioAction): void => {
  if (vscode) vscode.postMessage(a);
  else window.postMessage(a, "*"); // standalone (dev harness): no host
};
const postReady = (): void => {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
};

const root = document.getElementById("root");
if (root) render(<Studio post={post} postReady={postReady} />, root);
