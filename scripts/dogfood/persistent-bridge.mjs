import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persistent-bridge-dogfood-"));
const serviceDir = path.join(root, ".tachyon", "bridge-service");
const controlSocket = path.join(serviceDir, "control.sock");
const descriptorPath = path.join(serviceDir, "service.json");
const daemon = path.resolve("dist/persistent-bridge-daemon.cjs");
if (!fs.existsSync(daemon)) throw new Error("dist/persistent-bridge-daemon.cjs missing; run npm run build first");

const options = { workspaceRoot: root, workspaceHash: "dogfood375", preferredPort: 0, controlSocket, descriptorPath };
const child = spawn(process.execPath, [daemon, Buffer.from(JSON.stringify(options)).toString("base64url")], {
  cwd: root,
  stdio: "ignore",
});
const backends = [];

try {
  await waitFor(() => fs.existsSync(descriptorPath));
  const firstDescriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  if (firstDescriptor.pid !== child.pid) throw new Error("descriptor PID does not name the proxy child");

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
  process.stdout.write(`persistent Bridge dogfood PASS pid=${firstDescriptor.pid} port=${firstDescriptor.port}\n`);
} finally {
  for (const server of backends) await closeServer(server);
  if (child.exitCode === null) child.kill("SIGTERM");
  fs.rmSync(root, { recursive: true, force: true });
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
