import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const daemon = path.resolve("dist/persistent-bridge-daemon.cjs");
if (!fs.existsSync(daemon)) throw new Error("dist/persistent-bridge-daemon.cjs missing; run npm run build first");
// Single shared path derivation (t-88ef8c) — required off the built daemon bundle, not re-derived here.
const { persistentBridgeControlSocket, persistentBridgeDescriptorPath } = createRequire(import.meta.url)(daemon);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-dogfood-"));
const controlSocket = persistentBridgeControlSocket(root);
const descriptorPath = persistentBridgeDescriptorPath(root);

const options = { workspaceRoot: root, workspaceHash: "dogfood375", preferredPort: 0, controlSocket, descriptorPath };
const unitName = `tachyon-bridge-dogfood-${process.pid}-${Date.now().toString(36)}.service`;
launchDaemonViaSystemd();
const backends = [];
let stopped = false;

try {
  await waitFor(() => fs.existsSync(descriptorPath));
  const firstDescriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  if (firstDescriptor.pid === process.pid) throw new Error("descriptor PID names the dogfood process");
  const parentPid = processParentPid(firstDescriptor.pid);
  if (parentPid === process.pid) throw new Error("persistent Bridge proxy is still a direct dogfood child");

  const backend1 = await backend("before", backends);
  await control({ op: "register", workspaceHash: "dogfood375", backendPort: backend1 });
  assertEqual(await request(firstDescriptor.port, "one"), { status: 200, body: "before:one" });

  await control({ op: "detach", workspaceHash: "dogfood375", backendPort: backend1 });
  const gap = await request(firstDescriptor.port, "gap");
  if (gap.status !== 503 || JSON.parse(gap.body).error !== "HOST_UNAVAILABLE") {
    throw new Error(`gap was not bounded HOST_UNAVAILABLE: ${JSON.stringify(gap)}`);
  }

  const backend2 = await backend("after", backends);
  await control({ op: "register", workspaceHash: "dogfood375", backendPort: backend2 });
  assertEqual(await request(firstDescriptor.port, "two"), { status: 200, body: "after:two" });
  const finalDescriptor = (await control({ op: "health", workspaceHash: "dogfood375" })).descriptor;
  if (finalDescriptor.pid !== firstDescriptor.pid || finalDescriptor.port !== firstDescriptor.port || finalDescriptor.instanceId !== firstDescriptor.instanceId) {
    throw new Error("proxy identity changed across backend reload");
  }

  await control({ op: "stop", workspaceHash: "dogfood375" });
  await waitFor(() => !fs.existsSync(controlSocket));
  stopped = true;
  process.stdout.write(`persistent Bridge dogfood PASS pid=${firstDescriptor.pid} ppid=${parentPid} port=${firstDescriptor.port}\n`);
} finally {
  for (const server of backends) await closeServer(server);
  if (!stopped) {
    await control({ op: "stop", workspaceHash: "dogfood375" }).catch(() => undefined);
    spawnSync("systemctl", ["--user", "stop", unitName], { encoding: "utf8" });
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function launchDaemonViaSystemd() {
  if (process.platform !== "linux") throw new Error("persistent Bridge dogfood requires Linux user systemd");
  const result = spawnSync("systemd-run", [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${unitName}`,
    `--working-directory=${root}`,
    "--",
    process.execPath,
    daemon,
    Buffer.from(JSON.stringify(options)).toString("base64url"),
  ], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`systemd-run failed: ${detail || `exit ${result.status}`}`);
  }
}

function processParentPid(pid) {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ps failed for persistent Bridge proxy pid ${pid}`);
  const ppid = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isSafeInteger(ppid) || ppid <= 0) throw new Error(`invalid parent pid for persistent Bridge proxy pid ${pid}`);
  return ppid;
}

async function backend(label, servers) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => res.end(`${label}:${body}`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server.address().port;
}

function request(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/mcp", method: "POST" }, (res) => {
      let output = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { output += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: output }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

function control(message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlSocket);
    let data = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => { data += chunk; });
    socket.once("error", reject);
    socket.once("end", () => {
      const response = JSON.parse(data);
      if (!response.ok) reject(new Error(`${response.code}: ${response.message}`));
      else resolve(response);
    });
  });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for persistent Bridge state");
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function assertEqual(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
