import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-continuity-"));
const sessionDir = path.join(temp, "sessions");
const sessionId = "tachyon-pi-continuity-dogfood";
const marker = `continuity-${Date.now()}`;

const providerServer = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume request */ }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({
    id: "dogfood",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: "dogfood",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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
    baseUrl: "http://127.0.0.1:${address.port}/v1",
    apiKey: "local-dogfood-key",
    api: "openai-completions",
    models: [{
      id: "continuity", name: "Continuity Dogfood", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096, maxTokens: 256
    }]
  });
}
`);

function startPi(sessionArgs) {
  const child = spawn("pi", [
    "--mode", "rpc",
    "--no-extensions", "--extension", providerExtension,
    "--no-skills", "--no-prompt-templates",
    "--provider", "tachyon-dogfood", "--model", "continuity",
    "--session-dir", sessionDir,
    ...sessionArgs,
  ], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
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
      for (let index = eventWaiters.length - 1; index >= 0; index--) {
        if (eventWaiters[index].predicate(event)) {
          const waiter = eventWaiters.splice(index, 1)[0];
          waiter.resolve(event);
        }
      }
    }
  });
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      const error = new Error(`Pi exited ${code}\n${stderr}`);
      for (const waiter of responseWaiters.values()) waiter.reject(error);
      for (const waiter of eventWaiters.splice(0)) waiter.reject(error);
      responseWaiters.clear();
    }
  });
  let sequence = 0;
  const bounded = (register, label) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Pi RPC timeout for ${label}\n${stderr}`)), 10_000);
    register(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
  const request = (command) => bounded((resolve, reject) => {
    const id = `req-${++sequence}`;
    responseWaiters.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  }, command.type);
  const waitFor = (predicate, label) => bounded(
    (resolve, reject) => eventWaiters.push({ predicate, resolve, reject }),
    label,
  );
  const close = async () => {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  return { request, waitFor, close };
}

try {
  const first = startPi(["--session-id", sessionId]);
  const settled = first.waitFor((event) => event.type === "agent_settled", "agent_settled");
  const accepted = await first.request({ type: "prompt", message: "Persist one local continuity marker." });
  if (!accepted.success) throw new Error(`first Pi process rejected prompt: ${JSON.stringify(accepted)}`);
  await settled;
  const before = await first.request({ type: "get_messages" });
  if (!JSON.stringify(before.data?.messages).includes(marker)) throw new Error("local provider marker absent before restart");
  await first.close();

  const sessionEntries = fs.readdirSync(sessionDir);
  const files = sessionEntries.filter((name) => name.endsWith(`_${sessionId}.jsonl`));
  if (files.length !== 1) throw new Error(`expected one exact Pi transcript, found ${files.length}: ${sessionEntries.join(", ")}`);

  const second = startPi(["--session", sessionId]);
  const after = await second.request({ type: "get_messages" });
  if (!after.success || !JSON.stringify(after.data?.messages).includes(marker)) {
    throw new Error(`exact-id resume lost persisted conversation: ${JSON.stringify(after)}`);
  }
  await second.close();
  console.log(`PASS: Pi process B resumed '${sessionId}' and recovered process A's conversation`);
} finally {
  await new Promise((resolve) => providerServer.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
