import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const root = process.cwd();
const extension = path.join(root, "dist", "engine", "pi-bridge-extension.mjs");
if (!fs.existsSync(extension)) throw new Error("build first: dist/engine/pi-bridge-extension.mjs is missing");

const token = "pi-onboarding-dogfood-token";
const sessions = new Map();
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  const sessionId = req.headers["mcp-session-id"];
  const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (existing) {
    await existing.transport.handleRequest(req, res, body);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  const mcp = new McpServer({ name: "pi-onboarding-dogfood", version: "1.0.0" });
  mcp.registerTool("dogfood_echo", {
    description: "Echo a value during Pi onboarding dogfood",
    inputSchema: { text: z.string() },
  }, async ({ text }) => ({ content: [{ type: "text", text }] }));
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
  if (transport.sessionId) sessions.set(transport.sessionId, { transport, mcp });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("dogfood server failed to bind");

const child = spawn("pi", [
  "--mode", "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--extension", extension,
], {
  cwd: root,
  env: {
    ...process.env,
    TACHYON_BRIDGE_URL: `http://127.0.0.1:${address.port}/mcp`,
    TACHYON_AGENT_BRIDGE_TOKEN: token,
    TACHYON_AGENT_NAME: "pi-dogfood",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

const proof = new Promise((resolve, reject) => {
  let buffer = "";
  const timeout = setTimeout(() => reject(new Error(`timed out waiting for Pi Bridge status\n${stderr}`)), 15_000);
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "extension_ui_request"
        && event.method === "notify"
        && event.message === "Tachyon Bridge: connected (1 tools)") {
        clearTimeout(timeout);
        resolve(event.message);
      }
    }
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code !== null && code !== 0) reject(new Error(`Pi exited ${code}\n${stderr}`));
  });
});

child.stdin.write(`${JSON.stringify({ id: "status", type: "prompt", message: "/tachyon-bridge-status" })}\n`);

try {
  const status = await proof;
  console.log(`PASS: real Pi loader reported '${status}' from the authenticated MCP catalog`);
} finally {
  child.kill("SIGTERM");
  await Promise.all([...sessions.values()].map(async ({ transport, mcp }) => {
    await transport.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }));
  await new Promise((resolve) => server.close(resolve));
}
