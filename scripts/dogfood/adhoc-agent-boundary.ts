/**
 * SDD 478 M9 / `t-8f3f7d` — real-runtime dogfood for the ad-hoc Agent/Terminal door.
 *
 * The admission rule itself is pure string logic and unit tests pin it. What unit tests cannot check is
 * whether the DECLARATION is still true of the machine: `SUPPORTED_ADHOC_AGENT_RUNTIMES` claims each
 * entry is a real LLM runtime with a real brief channel, and a list like that rots silently — a renamed
 * flag or a retired binary would leave the door admitting something Tachyon can no longer operate.
 *
 * So this drives the installed CLIs: every declared runtime that is present must answer `--version`, and
 * every declared brief channel must still exist in that CLI's own help. Absent runtimes are reported,
 * not failed — a machine without `gemini` is not evidence about `gemini`.
 *
 * Nothing here starts an agent, sends a prompt or touches a credential.
 *
 * Run: npm run dogfood:adhoc-agent-boundary
 */
import { spawnSync } from "node:child_process";
import {
  admitAdhocAgentCommand,
  SUPPORTED_ADHOC_AGENT_RUNTIMES,
  SUPPORTED_ADHOC_AGENT_RUNTIME_NAMES,
  TERMINAL_OPERATION,
} from "../../src/agents/adhocAdmission.js";

/** The flag each declared brief channel actually rides on, for the runtimes that use argv. */
const BRIEF_FLAG: Partial<Record<string, string>> = {
  opencode: "--prompt",
  gemini: "-i",
};

/**
 * Both streams, always. Measured the hard way: `opencode --help` prints its whole usage block to
 * STDERR and exits 0, so a stdout-only read reported the runtime had dropped a flag it still has.
 */
function run(bin: string, args: string[]): { ok: boolean; text: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { ok: !result.error && result.status === 0, text };
}

function installed(bin: string): boolean {
  return run(process.platform === "win32" ? "where" : "which", [bin]).ok;
}

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];
const absent: string[] = [];

console.log("\n== 1: every DECLARED runtime that is installed is a real CLI the door admits ==");
for (const runtime of SUPPORTED_ADHOC_AGENT_RUNTIME_NAMES) {
  if (!installed(runtime)) {
    absent.push(runtime);
    console.log(`SKIP — ${runtime}: not installed on this machine (absence is not evidence about it)`);
    continue;
  }
  const version = run(runtime, ["--version"]);
  const admission = admitAdhocAgentCommand(runtime);
  checks.push(report(
    `${runtime}: answers --version and is admitted as an ad-hoc agent runtime`,
    version.ok && admission.ok,
    { version: version.text.replace(/\s+/g, " ").trim().slice(0, 60), admitted: admission.ok },
  ));
}

console.log("\n== 2: the declared brief channel still exists in the CLI's own help ==");
for (const [runtime, flag] of Object.entries(BRIEF_FLAG)) {
  if (!installed(runtime)) {
    console.log(`SKIP — ${runtime}: not installed`);
    continue;
  }
  // The declaration says the delegation contract reaches this runtime through `flag`. If the CLI stopped
  // advertising it, a delegated child would be spawned with a brief that goes nowhere.
  const help = run(runtime, ["--help"]);
  checks.push(report(
    `${runtime}: still advertises ${flag}, the channel the declaration names`,
    help.text.includes(flag!),
    { declared: SUPPORTED_ADHOC_AGENT_RUNTIMES[runtime as keyof typeof SUPPORTED_ADHOC_AGENT_RUNTIMES].brief, flag },
  ));
}

console.log("\n== 3: real generic commands are refused, and told where to go ==");
for (const cmd of ["sh", "npm run dev", "git status", "sh -c 'echo hi'", "node --version"]) {
  const admission = admitAdhocAgentCommand(cmd);
  const refusedWell = !admission.ok && admission.reason.includes(TERMINAL_OPERATION);
  checks.push(report(
    `'${cmd}' is refused as an agent and named ${TERMINAL_OPERATION}`,
    refusedWell,
    admission.ok ? { admittedAs: admission.runtime } : admission.reason.slice(0, 120),
  ));
}

console.log("\n== 4: a runtime binary reached through a launcher still resolves ==");
{
  // Tachyon launches through `env`/`npx` wrappers in real configs; the door must see through them or it
  // would refuse working commands. Checked against a runtime that is actually present.
  const present = SUPPORTED_ADHOC_AGENT_RUNTIME_NAMES.find((runtime) => installed(runtime));
  if (!present) {
    console.log("SKIP — no declared runtime is installed on this machine");
  } else {
    const wrapped = [`env TACHYON_PROBE=1 ${present}`, `npx ${present}`, `/usr/bin/env ${present}`];
    checks.push(report(
      `${present}: admitted through env/npx launchers, not just bare`,
      wrapped.every((cmd) => {
        const admission = admitAdhocAgentCommand(cmd);
        return admission.ok && admission.runtime === present;
      }),
      wrapped,
    ));
  }
}

if (absent.length > 0) {
  console.log(`\nNOTE — declared but not installed here, so unverified by this run: ${absent.join(", ")}`);
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
