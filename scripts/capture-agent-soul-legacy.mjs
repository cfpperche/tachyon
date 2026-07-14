import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const BASE_SHA = "6885becd72dbd1a4eed270a3233f5d8e0a3e310e";
const root = path.resolve(process.argv[2] ?? process.cwd());
const output = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const seams = [
  "src/config/loadConfig.ts",
  "src/roles/templates.ts",
  "src/agents/briefFile.ts",
  "src/bridge/spawnContract.ts",
  "src/resume/adapters.ts",
];

for (const seam of seams) {
  const baseline = execFileSync("git", ["show", `${BASE_SHA}:${seam}`], { cwd: root });
  const current = await readFile(path.join(root, seam));
  if (!baseline.equals(current)) throw new Error(`refusing legacy capture: ${seam} differs from immutable BASE_SHA ${BASE_SHA}`);
}

const fromRoot = async (relative) => import(pathToFileURL(path.join(root, relative)).href);
const roles = await fromRoot("src/roles/templates.ts");
const config = await fromRoot("src/config/loadConfig.ts");
const spawn = await fromRoot("src/bridge/spawnContract.ts");
const brief = await fromRoot("src/agents/briefFile.ts");
const resume = await fromRoot("src/resume/adapters.ts");

const task = "Current task: fix the parser.";
const contract = spawn.composeSpawnContractBrief("child", {
  task: "Implement parser correction",
  context: "Existing parser mishandles quoted values",
  constraints: "Keep the public format byte-compatible",
  doneWhen: "Focused parser tests pass",
}, undefined, "parent");
const cases = [
  ["role-only", roles.composeInstructions("reviewer", undefined)],
  ["instructions-only", roles.composeInstructions(undefined, "Persistent specialization.")],
  ["role-and-instructions", roles.composeInstructions("reviewer", "Persistent specialization.")],
  ["bridge-guidance", roles.withBridgeGuidance("Persistent specialization.", true)],
  ["ad-hoc-contract", contract],
  ["bound-delivery-task", roles.withBridgeGuidance(roles.composeInstructions("coder", `Persistent specialization.\n\n${task}`), true)],
  ["pipeline-task", roles.withBridgeGuidance(roles.composeInstructions("tester", `Persistent specialization.\n\n${task}`), true)],
  ["no-soul-reanchor", roles.buildRoleDoc("reviewer", "reviewer", "Persistent specialization.")],
  ["short-body", brief.deliverableBody(root, "capture-short", "short exact body")],
];
const longBody = "L".repeat(brief.BRIEF_FILE_THRESHOLD + 1);
const longResult = brief.deliverableBody(root, "capture-long", longBody);
cases.push(["long-body-pointer", longResult.replaceAll(root, "<WORKSPACE_ROOT>")]);
await rm(brief.briefFilePath(root, "capture-long"), { force: true });

const claude = resume.adapterFor("claude");
if (!claude?.forkCommand) throw new Error("BASE_SHA unexpectedly lacks the Claude resume/fork adapter");
const lifecycle = [
  ["resume-command", claude.resumeCommand("claude --permission-mode plan", "uuid-1")],
  ["host-rebind-command", claude.resumeCommand("claude --model sonnet", "session-a")],
  ["native-fork-command", claude.forkCommand(claude.injectId("claude", "<FORK_SESSION>"), "abcdef01-2345-6789-abcd-ef0123456789")],
];

const fixture = (name, values) => ({
  baseSha: BASE_SHA,
  fixture: name,
  cases: values.map(([caseName, bytes]) => ({
    baseSha: BASE_SHA,
    name: caseName,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(name === "lifecycle-bypass-cases" ? { sendKeys: [] } : {}),
  })),
});
const promptFixture = fixture("prompt-command-cases", cases);
const lifecycleFixture = fixture("lifecycle-bypass-cases", lifecycle);

if (!output) {
  process.stdout.write(`${JSON.stringify({ promptFixture, lifecycleFixture }, null, 2)}\n`);
} else {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "prompt-command-cases.json"), `${JSON.stringify(promptFixture, null, 2)}\n`, { flag: "wx" });
  await writeFile(path.join(output, "lifecycle-bypass-cases.json"), `${JSON.stringify(lifecycleFixture, null, 2)}\n`, { flag: "wx" });
}
