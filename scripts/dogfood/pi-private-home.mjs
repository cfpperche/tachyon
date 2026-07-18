import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-private-home-"));
const realHome = path.join(temp, "ambient-real-home");
const homeA = path.join(temp, "private-a");
const homeB = path.join(temp, "private-b");
for (const dir of [realHome, homeA, homeB]) fs.mkdirSync(path.join(dir, "sessions"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(realHome, "sentinel.json"), '{"must":"remain-byte-identical"}\n');
const realBefore = fs.readFileSync(path.join(realHome, "sentinel.json"), "utf8");
const sessionId = "tachyon-pi-private-home-dogfood";
const siblingId = "tachyon-pi-private-home-sibling";
const marker = `private-home-${Date.now()}`;

const providerServer = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume request */ }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({
    id: "dogfood", object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: "dogfood", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve, reject) => {
  providerServer.once("error", reject);
  providerServer.listen(0, "127.0.0.1", resolve);
});
const address = providerServer.address();
if (!address || typeof address === "string") throw new Error("local dogfood provider failed to bind");

const providerExtension = path.join(temp, "provider.mjs");
fs.writeFileSync(providerExtension, `
export default function (pi) {
  pi.registerProvider("tachyon-dogfood", {
    baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local-dogfood-key", api: "openai-completions",
    models: [{ id: "private-home", name: "Private Home Dogfood", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }]
  });
}
`);

function startPi(home, sessionArgs) {
  const child = spawn("pi", [
    "--mode", "rpc", "--no-extensions", "--extension", providerExtension,
    "--no-skills", "--no-prompt-templates", "--provider", "tachyon-dogfood", "--model", "private-home",
    ...sessionArgs,
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: path.join(home, "sessions"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  const responseWaiters = new Map();
  const eventWaiters = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "response" && event.id && responseWaiters.has(event.id)) {
        const waiter = responseWaiters.get(event.id);
        responseWaiters.delete(event.id);
        waiter.resolve(event);
      }
      for (let i = eventWaiters.length - 1; i >= 0; i--) {
        if (eventWaiters[i].predicate(event)) eventWaiters.splice(i, 1)[0].resolve(event);
      }
    }
  });
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      const error = new Error(`Pi exited ${code}\n${stderr}`);
      for (const waiter of responseWaiters.values()) waiter.reject(error);
      for (const waiter of eventWaiters.splice(0)) waiter.reject(error);
    }
  });
  let sequence = 0;
  const bounded = (register, label) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Pi RPC timeout for ${label}\n${stderr}`)), 10_000);
    register((value) => { clearTimeout(timeout); resolve(value); }, (error) => { clearTimeout(timeout); reject(error); });
  });
  const request = (command) => bounded((resolve, reject) => {
    const id = `req-${++sequence}`;
    responseWaiters.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  }, command.type);
  const waitFor = (predicate, label) => bounded((resolve, reject) => eventWaiters.push({ predicate, resolve, reject }), label);
  const close = async () => {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  return { request, waitFor, close };
}

async function prompt(runtime, message) {
  const settled = runtime.waitFor((event) => event.type === "agent_settled", "agent_settled");
  const accepted = await runtime.request({ type: "prompt", message });
  if (!accepted.success) throw new Error(`Pi rejected prompt: ${JSON.stringify(accepted)}`);
  await settled;
}

try {
  const first = startPi(homeA, ["--session-id", sessionId]);
  await prompt(first, "Persist one private-home marker.");
  const before = await first.request({ type: "get_messages" });
  if (!JSON.stringify(before.data?.messages).includes(marker)) throw new Error("provider marker absent before restart");
  await first.close();

  const filesA = fs.readdirSync(path.join(homeA, "sessions")).filter((name) => name.endsWith(`_${sessionId}.jsonl`));
  if (filesA.length !== 1) throw new Error(`home A expected one exact transcript, found ${filesA.length}`);
  if (fs.readdirSync(path.join(homeB, "sessions")).length !== 0) throw new Error("home B observed home A state before its own launch");

  const resumed = startPi(homeA, ["--session", sessionId]);
  const after = await resumed.request({ type: "get_messages" });
  if (!after.success || !JSON.stringify(after.data?.messages).includes(marker)) {
    throw new Error(`exact-id private-home resume lost conversation: ${JSON.stringify(after)}`);
  }
  await resumed.close();

  const sibling = startPi(homeB, ["--session-id", siblingId]);
  await prompt(sibling, "Create an isolated sibling session.");
  await sibling.close();
  const filesB = fs.readdirSync(path.join(homeB, "sessions")).filter((name) => name.endsWith(`_${siblingId}.jsonl`));
  if (filesB.length !== 1) throw new Error(`home B expected its own transcript, found ${filesB.length}`);
  if (fs.readdirSync(path.join(homeB, "sessions")).some((name) => name.includes(sessionId))) throw new Error("home B leaked home A session id");
  if (fs.readFileSync(path.join(realHome, "sentinel.json"), "utf8") !== realBefore) throw new Error("ambient real home was mutated");

  console.log(`PASS: Pi resumed exact session in private home A; sibling home B stayed isolated; ambient home remained unchanged`);
} finally {
  await new Promise((resolve) => providerServer.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
