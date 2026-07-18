import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const bundledExtension = path.join(root, "dist", "engine", "pi-bridge-extension.mjs");
if (!fs.existsSync(bundledExtension)) throw new Error("build first: bundled Pi extension is absent");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-native-fork-"));
const ownerFile = path.join(temp, "session-owners.jsonl");
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const forkId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const marker = `fork-context-${Date.now()}`;

const providerServer = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume */ }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ id: "fork-dogfood", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "fork-dogfood", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve, reject) => { providerServer.once("error", reject); providerServer.listen(0, "127.0.0.1", resolve); });
const address = providerServer.address();
if (!address || typeof address === "string") throw new Error("local provider failed to bind");

const providerExtension = path.join(temp, "provider.mjs");
fs.writeFileSync(providerExtension, `
export default function (pi) {
  pi.registerProvider("tachyon-fork-dogfood", {
    baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local", api: "openai-completions",
    models: [{ id: "fork", name: "Fork", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }]
  });
}
`);

function homeFor(agent) {
  const home = path.join(temp, agent);
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700); fs.chmodSync(sessions, 0o700);
  return { home, sessions };
}

function startPi(agent, sessionArgs) {
  const { home, sessions } = homeFor(agent);
  const child = spawn("pi", [
    "--mode", "rpc", "-a", "--no-extensions",
    "--extension", providerExtension, "--extension", bundledExtension,
    "--no-skills", "--no-prompt-templates", "--provider", "tachyon-fork-dogfood", "--model", "fork",
    ...sessionArgs,
  ], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: sessions, TACHYON_AGENT_NAME: agent, TACHYON_PI_SESSION_OWNER_FILE: ownerFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = ""; let buffer = ""; let sequence = 0;
  const responses = new Map(); const events = [];
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"); const line = buffer.slice(0, at).replace(/\r$/, ""); buffer = buffer.slice(at + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "response" && responses.has(event.id)) { const waiter = responses.get(event.id); responses.delete(event.id); waiter.resolve(event); }
      for (let i = events.length - 1; i >= 0; i--) if (events[i].predicate(event)) { const waiter = events.splice(i, 1)[0]; waiter.resolve(event); }
    }
  });
  const bounded = (register, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Pi timeout: ${label}\n${stderr}`)), 10_000);
    register((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
  child.once("exit", (code) => { if (code && code !== 0) { const error = new Error(`Pi exited ${code}\n${stderr}`); for (const waiter of responses.values()) waiter.reject(error); for (const waiter of events.splice(0)) waiter.reject(error); } });
  return {
    sessions,
    request: (command) => bounded((resolve, reject) => { const id = `r-${++sequence}`; responses.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, ...command })}\n`); }, command.type),
    waitFor: (predicate, label) => bounded((resolve, reject) => events.push({ predicate, resolve, reject }), label),
    close: async () => { child.stdin.end(); await new Promise((resolve) => { const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 1500); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); },
  };
}

function onlySession(dir, id) {
  const matches = fs.readdirSync(dir).filter((name) => name.endsWith(`_${id}.jsonl`));
  if (matches.length !== 1) throw new Error(`expected exact ${id} transcript in ${dir}, found ${matches.join(",")}`);
  return path.join(dir, matches[0]);
}

try {
  const a = startPi("pi-a", ["--session-id", sourceId]);
  const settled = a.waitFor((event) => event.type === "agent_settled", "source settled");
  const accepted = await a.request({ type: "prompt", message: "Remember this context for the native fork." });
  if (!accepted.success) throw new Error(`source rejected prompt: ${JSON.stringify(accepted)}`);
  await settled; await a.close();
  const sourcePath = onlySession(a.sessions, sourceId);
  const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");

  const b = startPi("pi-a-fork-1", ["--session-id", forkId, "--fork", sourcePath]);
  const inherited = await b.request({ type: "get_messages" });
  if (!inherited.success || !JSON.stringify(inherited.data?.messages).includes(marker)) throw new Error("fork B lost source context");
  await b.close();
  const forkPath = onlySession(b.sessions, forkId);
  const header = JSON.parse(fs.readFileSync(forkPath, "utf8").split("\n", 1)[0]);
  if (header.id !== forkId || path.resolve(header.cwd) !== path.resolve(root) || path.resolve(header.parentSession) !== path.resolve(sourcePath)) {
    throw new Error(`fork header mismatch: ${JSON.stringify(header)}`);
  }
  const sourceHashAfter = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  if (sourceHashAfter !== sourceHash) throw new Error("source A changed while B was forked");

  for (const [agent, id] of [["pi-a", sourceId], ["pi-a-fork-1", forkId]]) {
    const resumed = startPi(agent, ["--session", id]);
    const messages = await resumed.request({ type: "get_messages" });
    if (!messages.success || !JSON.stringify(messages.data?.messages).includes(marker)) throw new Error(`${agent} independent resume lost context`);
    await resumed.close();
  }

  const owners = fs.readFileSync(ownerFile, "utf8").trim().split("\n").map(JSON.parse);
  for (const [agent, id] of [["pi-a", sourceId], ["pi-a-fork-1", forkId]]) {
    if (!owners.some((row) => row.agent === agent && row.sessionId === id && path.resolve(row.cwd) === path.resolve(root))) {
      throw new Error(`missing positive ownership for ${agent}/${id}`);
    }
  }
  console.log(`PASS: real Pi forked ${sourceId} → ${forkId}, preserved A, recorded ownership, and resumed A/B independently`);
} finally {
  await new Promise((resolve) => providerServer.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
