import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-reviewer-safety-"));
const home = path.join(temp, "home");
const catalog = path.join(temp, "active-tools.json");
const extension = path.join(temp, "probe.mjs");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
fs.writeFileSync(extension, `
import fs from "node:fs";
export default function (pi) {
  pi.registerProvider("tachyon-review-probe", {
    baseUrl: "http://127.0.0.1:9/v1", apiKey: "local", api: "openai-completions",
    models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }]
  });
  pi.registerTool({
    name: "bridge_probe", label: "Bridge Probe", description: "SDD 404 extension-tool sentinel",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; }
  });
  pi.on("session_start", () => {
    fs.writeFileSync(process.env.TACHYON_PI_TOOL_CATALOG, JSON.stringify(pi.getActiveTools().sort()));
  });
}
`);

const child = spawn("pi", [
  "--mode", "rpc", "-a", "--no-extensions", "--extension", extension,
  "--no-skills", "--no-prompt-templates", "--provider", "tachyon-review-probe", "--model", "probe",
  "--exclude-tools", "bash,edit,write", "--no-session",
], {
  cwd: temp,
  env: { ...process.env, PI_CODING_AGENT_DIR: home, TACHYON_PI_TOOL_CATALOG: catalog },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const deadline = Date.now() + 8000;
try {
  while (!fs.existsSync(catalog) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!fs.existsSync(catalog)) throw new Error(`Pi did not publish active tools\n${stderr}`);
  const tools = JSON.parse(fs.readFileSync(catalog, "utf8"));
  for (const mutator of ["bash", "edit", "write"]) if (tools.includes(mutator)) throw new Error(`mutator remained active: ${mutator}`);
  for (const required of ["read", "bridge_probe"]) if (!tools.includes(required)) throw new Error(`inspection/extension tool missing: ${required}; active=${tools.join(",")}`);
  console.log("PASS: real Pi reviewer catalog is exactly read + extension probe; bash/edit/write are absent");
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 1500);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  fs.rmSync(temp, { recursive: true, force: true });
}
