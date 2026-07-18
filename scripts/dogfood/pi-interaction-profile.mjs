import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-interaction-"));
const socket = `pi-interaction-${process.pid}`;
const frame = /─{20,}/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeRequests = 0;

const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume */ }
  activeRequests++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ id: "slow", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "working" }, finish_reason: null }] })}\n\n`);
  const release = () => { activeRequests = Math.max(0, activeRequests - 1); };
  req.once("close", release);
  res.once("close", release);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("local provider bind failed");
const extension = path.join(temp, "provider.mjs");
fs.writeFileSync(extension, `export default function (pi) { pi.registerProvider("tachyon-measure", {
  baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local", api: "openai-completions",
  models: [{ id: "measure", name: "Measure", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }]
}); }`);

function tmux(args, allowFailure = false) {
  try { return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { if (allowFailure) return ""; throw error; }
}
function alive(name) { try { tmux(["has-session", "-t", name]); return true; } catch { return false; } }
function capture(name) { return tmux(["capture-pane", "-p", "-t", `${name}:0.0`, "-S", "-40"]); }
function key(name, value) { tmux(["send-keys", "-t", `${name}:0.0`, value]); }
function literal(name, value) { tmux(["send-keys", "-t", `${name}:0.0`, "-l", value]); }

async function waitFor(label, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(75); }
  throw new Error(`timeout waiting for ${label}`);
}

async function start(name) {
  const home = path.join(temp, name);
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const command = `env PI_CODING_AGENT_DIR='${home}' PI_CODING_AGENT_SESSION_DIR='${sessions}' pi -a --no-extensions --extension '${extension}' --no-skills --no-prompt-templates --provider tachyon-measure --model measure --no-session`;
  tmux(["new-session", "-d", "-s", name, "-x", "100", "-y", "30", command]);
  await waitFor(`${name} framed editor`, () => {
    const pane = capture(name);
    return (pane.match(new RegExp(frame.source, "g"))?.length ?? 0) >= 2 && /0\.0%\/4\.1k.*measure/.test(pane);
  });
}

async function graceful(name) {
  key(name, "Escape");
  await sleep(300);
  if (alive(name)) key(name, "C-c");
  await sleep(150);
  if (alive(name)) key(name, "C-d");
  await sleep(150);
  if (alive(name)) key(name, "C-d");
  await waitFor(`${name} clean exit`, () => !alive(name), 3000);
}

try {
  await start("idle");
  await graceful("idle");

  await start("draft");
  literal("draft", "human-owned-draft");
  await waitFor("draft text in framed editor", () => capture("draft").includes("human-owned-draft"));
  await graceful("draft");

  await start("active");
  literal("active", "start a slow measured turn");
  key("active", "Enter");
  await waitFor("provider request", () => activeRequests > 0);
  await waitFor("active turn chrome", () => /escape to interrupt|working/i.test(capture("active")));
  await graceful("active");

  console.log("PASS: Pi v0.80.10 framed editor measured; idle, draft and active-turn panes exited via Escape → Ctrl+C → Ctrl+D");
} finally {
  tmux(["kill-server"], true);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
