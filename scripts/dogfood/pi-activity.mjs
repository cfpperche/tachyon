import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-activity-"));
const home = path.join(temp, "pi-home");
const sessions = path.join(home, "sessions");
const activity = path.join(temp, "activity");
const sessionId = "tachyon-pi-activity-dogfood";
const marker = `activity-marker-${Date.now()}`;
fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });

const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume */ }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ id: "activity", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "activity", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("provider bind failed");
const extension = path.join(temp, "provider.mjs");
fs.writeFileSync(extension, `export default function (pi) { pi.registerProvider("tachyon-activity", {
  baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local", api: "openai-completions",
  models: [{ id: "activity", name: "Activity", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }]
}); }`);

async function produceTranscript() {
  const child = spawn("pi", [
    "--mode", "rpc", "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates",
    "--provider", "tachyon-activity", "--model", "activity", "--session-id", sessionId,
  ], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: sessions }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const settled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Pi activity dogfood timeout\n${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "agent_settled") { clearTimeout(timer); resolve(); }
      }
    });
    child.once("exit", (code) => { if (code && code !== 0) { clearTimeout(timer); reject(new Error(`Pi exited ${code}\n${stderr}`)); } });
  });
  child.stdin.write(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: "Record one Activity marker." })}\n`);
  await settled;
  child.stdin.end();
  await new Promise((resolve) => { const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
}

try {
  await produceTranscript();
  const files = fs.readdirSync(sessions).filter((name) => name.endsWith(`_${sessionId}.jsonl`));
  if (files.length !== 1) throw new Error(`expected one native Pi transcript, found ${files.length}`);
  const transcript = path.join(sessions, files[0]);

  const bundle = path.join(temp, "activity-runtime.mjs");
  await build({
    stdin: {
      contents: `export { ActivityLogWriter } from "./src/activity/logWriter.ts"; export { ActivityLog } from "./src/activity/logStore.ts";`,
      resolveDir: root,
      sourcefile: "pi-activity-dogfood-entry.ts",
      loader: "ts",
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  const { ActivityLogWriter, ActivityLog } = await import(`${new URL(`file://${bundle}`).href}?v=${Date.now()}`);
  const writer = new ActivityLogWriter(activity, "pi-dogfood", () => "2026-07-18T00:00:00.000Z");
  const count = writer.poll({ path: transcript, sessionId, runtime: "pi" });
  const events = new ActivityLog(activity, "pi-dogfood").readTail(100);
  const types = new Set(events.map((event) => event.type));
  if (count < 4 || !types.has("session.started") || !types.has("user.message.completed") || !types.has("assistant.message.completed") || !types.has("usage.updated")) {
    throw new Error(`native Pi transcript did not normalize completely: count=${count}, types=${[...types].join(",")}`);
  }
  if (!events.some((event) => event.type === "assistant.message.completed" && event.payload?.text === marker)) throw new Error("assistant marker missing from durable Activity");
  if (!events.every((event) => event.source.runtime === "pi" && event.source.sourcePath === transcript)) throw new Error("Pi Activity provenance mismatch");
  console.log(`PASS: real Pi transcript normalized into ${count} durable Activity events with exact provenance`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
