/**
 * SDD 477 / t-16cd93 — real-runtime dogfood for auth-required detection.
 *
 * Unit fixtures pin the measured bytes. This re-derives them from the REAL CLIs, so the classifier is
 * checked against what the installed binaries actually say today rather than against a transcript
 * that could silently go stale on the next release.
 *
 * Every runtime is driven against an isolated, credential-free private home — the same shape Tachyon
 * already materializes. No real credential is read, copied or modified, and nothing is written to the
 * operator's own runtime homes.
 *
 * Run: npm run dogfood -- auth-required-parity
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUNTIME_AUTH_PROFILES,
  authRequiredFromPreflight,
  classifyAuthRequired,
  describeAuthRequired,
} from "../../src/runtime/authRequired.js";
import { OpencodeLaunchPreflight } from "../../src/runtime/adapters/opencodeLaunchPreflight.js";
import { parseLaunchCommand } from "../../src/runtime/launchPreflight.js";
import type { ResumeRuntime } from "../../src/resume/adapters.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-authreq-dogfood-"));
const cwd = path.join(scratch, "ws");
fs.mkdirSync(cwd, { recursive: true });
execFileSync("git", ["init", "-q", "."], { cwd });

/** A private, EMPTY home for one runtime — "logged out" without touching anything real. */
function emptyHome(name: string): string {
  const home = path.join(scratch, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

interface Probe {
  runtime: ResumeRuntime;
  bin: string;
  args: string[];
  env: Record<string, string>;
}

const PROBES: Probe[] = [
  { runtime: "claude", bin: "claude", args: ["-p", "say ok", "--output-format", "json"], env: { CLAUDE_CONFIG_DIR: emptyHome("claude") } },
  { runtime: "codex", bin: "codex", args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "say ok"], env: { CODEX_HOME: emptyHome("codex") } },
  { runtime: "grok", bin: "grok", args: ["-p", "say ok", "--output-format", "json"], env: { GROK_HOME: emptyHome("grok") } },
  { runtime: "hermes", bin: "hermes", args: ["-z", "say ok"], env: { HERMES_HOME: emptyHome("hermes") } },
];

function run(probe: Probe): string {
  try {
    return execFileSync(probe.bin, probe.args, {
      cwd,
      env: { ...process.env, ...probe.env },
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A logged-out CLI may exit non-zero; its message is the thing under test either way.
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
  }
}

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];

try {
  console.log("\n== 1: each declared runtime still emits the signal the profile was measured against ==");
  for (const probe of PROBES) {
    const output = run(probe);
    const evidence = classifyAuthRequired(probe.runtime, output);
    checks.push(report(
      `${probe.runtime}: a credential-free home classifies as auth-required`,
      evidence !== undefined,
      evidence
        ? { matched: evidence.matchedLine.slice(0, 110), action: evidence.humanAction.slice(0, 80) }
        : { classified: null, sawOutput: output.replace(/\s+/g, " ").trim().slice(0, 200) },
    ));
  }

  console.log("\n== 2: OpenCode's TURN is silent — the transcript gap, re-confirmed ==");
  const ocEmpty = emptyHome("oc");
  const ocEmptyEnv = {
    XDG_CONFIG_HOME: path.join(ocEmpty, "cfg"),
    XDG_DATA_HOME: path.join(ocEmpty, "data"),
    XDG_STATE_HOME: path.join(ocEmpty, "state"),
    XDG_CACHE_HOME: path.join(ocEmpty, "cache"),
  };
  {
    // Measured 1.18.4 and re-measured 1.18.5: with no credential it does not error, it answers on the
    // fallback model. This check exists to catch the day that CHANGES, so the gap is re-opened
    // deliberately rather than forgotten.
    let output: string;
    try {
      output = execFileSync("opencode", ["run", "say ok"], {
        cwd,
        env: { ...process.env, ...ocEmptyEnv },
        encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    }
    const declared = RUNTIME_AUTH_PROFILES.opencode !== undefined;
    checks.push(report(
      "opencode declares no transcript profile and classifies nothing (t-0338fc)",
      !declared && classifyAuthRequired("opencode", output) === undefined,
      { declaredProfile: declared, sawOutput: output.replace(/\s+/g, " ").trim().slice(0, 140) },
    ));
  }

  console.log("\n== 2b: OpenCode's credential STORE is not silent — the measured mitigation (t-0338fc) ==");
  {
    // The gate that replaced the gap. Driven against the REAL CLI both ways, because a preflight that
    // only ever says "refuse" is not a gate, it is an outage: the credential-free home must refuse AND
    // the operator's own home must pass.
    const adapter = new OpencodeLaunchPreflight();
    const parsed = parseLaunchCommand("opencode");
    if (!parsed) throw new Error("the launch parser stopped recognising a bare `opencode` command");

    const refused = await adapter.check(parsed, { ...process.env, ...ocEmptyEnv }, cwd);
    checks.push(report(
      "a credential-free private home is refused at the launch boundary, not silently degraded",
      refused.state === "unauthenticated" && refused.code === "runtime_auth_unavailable",
      refused,
    ));

    const sentence = refused.state === "unauthenticated"
      ? describeAuthRequired("some-agent", authRequiredFromPreflight(refused.runtime, refused.reportedLine)!)
      : "";
    checks.push(report(
      "the refusal names the agent, the runtime and the safe action, and carries no credential",
      sentence.includes("some-agent") && sentence.includes("opencode")
      && sentence.includes("opencode providers login")
      && sentence.includes("will not retry or restart it automatically")
      && !/sk-|Bearer\s+\S{8,}|eyJ[A-Za-z0-9_-]{10,}/.test(sentence),
      sentence.slice(0, 220),
    ));

    // The operator's REAL home, read-only: `providers list` reports an inventory, it never writes.
    const allowed = await adapter.check(parsed, process.env, cwd);
    checks.push(report(
      "a real, credentialed home is NOT refused (the gate is a gate, not an outage)",
      allowed.state !== "unauthenticated" && allowed.state !== "failed",
      allowed,
    ));
  }

  console.log("\n== 3: the human sentence is actionable and carries no credential ==");
  {
    const evidence = classifyAuthRequired("grok", run(PROBES[2]!));
    const sentence = evidence ? describeAuthRequired("some-agent", evidence) : "";
    checks.push(report(
      "names the agent, the runtime and the safe action, and promises no auto-retry",
      Boolean(evidence)
      && sentence.includes("some-agent") && sentence.includes("grok")
      && sentence.includes("will not retry or restart it automatically")
      && !/sk-|Bearer\s+\S{8,}|eyJ[A-Za-z0-9_-]{10,}/.test(sentence),
      sentence.slice(0, 200),
    ));
  }

  console.log("\n== 4: a real non-auth failure is not reported as auth ==");
  {
    // An unknown model is a genuine, different failure on a runtime that IS authenticated. It must
    // not be reported as "log in again", which would send the human to the wrong place entirely.
    let output: string;
    try {
      output = execFileSync("grok", ["-p", "say ok", "-m", "definitely-not-a-real-model-xyz", "--output-format", "json"], {
        cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    }
    checks.push(report(
      "an authenticated runtime failing for a non-auth reason classifies nothing",
      classifyAuthRequired("grok", output) === undefined,
      { sawOutput: output.replace(/\s+/g, " ").trim().slice(0, 160) },
    ));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
