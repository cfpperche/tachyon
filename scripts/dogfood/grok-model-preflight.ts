/**
 * t-85c586 — real-CLI dogfood for the Grok model-catalog preflight adapter.
 *
 * Unit fixtures pin the measured `grok models` text. This drives the REAL adapter through the REAL
 * registry against the REAL installed CLI, and — the part that makes the verdicts more than a
 * parser test — it cross-checks each verdict against what Grok itself does with the same pin.
 *
 * The property: `supported` must mean the CLI accepts the model, and `unsupported` must mean the CLI
 * refuses it. A catalog that disagreed with the binary would be worse than no catalog at all.
 *
 * Run: npm run dogfood:grok-model-preflight
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrokLaunchPreflight } from "../../src/runtime/adapters/grokLaunchPreflight.js";
import { RuntimeLaunchPreflightRegistry, parseLaunchCommand } from "../../src/runtime/launchPreflight.js";

const registry = new RuntimeLaunchPreflightRegistry({ grok: new GrokLaunchPreflight() });

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

/** Ask the real CLI to SET the model without spending a turn; it validates the id up front. */
function cliAcceptsModel(model: string, cwd: string): { accepted: boolean; detail: string } {
  try {
    const out = execFileSync("grok", ["-p", "hi", "-m", model, "--output-format", "json"], {
      cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
    });
    // The unknown-model refusal arrives as a JSON error object on stdout, exit 0.
    const refused = /unknown model id/i.test(out);
    return { accepted: !refused, detail: refused ? "refused: unknown model id" : "accepted" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { accepted: !/unknown model id/i.test(detail), detail };
  }
}

const checks: boolean[] = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "grok-preflight-dogfood-"));

try {
  console.log("\n== 0: the real grok CLI is present ==");
  let version: string;
  try {
    version = execFileSync("grok", ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
  } catch {
    console.log("FAIL — grok CLI not on PATH; this dogfood measures the real binary");
    console.log("\nDOGFOOD FAIL — 0/1 checks passed");
    process.exit(1);
  }
  checks.push(report("grok is installed", true, version));
  execFileSync("git", ["init", "-q", "."], { cwd: scratch });

  console.log("\n== 1: the catalog the CLI actually reports ==");
  const catalogText = execFileSync("grok", ["models"], { cwd: scratch, encoding: "utf8", timeout: 60_000 });
  const listed = [...catalogText.matchAll(/^\s+[*\-•]\s+(\S+)/gm)].map((m) => m[1]!);
  checks.push(report("grok models lists at least one model", listed.length > 0, { listed }));

  console.log("\n== 2: a listed model is SUPPORTED, and the CLI agrees ==");
  {
    const model = listed[0]!;
    const verdict = await registry.check(parseLaunchCommand(`grok --model ${model}`)!, process.env, scratch);
    const cli = cliAcceptsModel(model, scratch);
    checks.push(report(
      `'${model}': adapter says supported and the CLI accepts it`,
      verdict.state === "supported" && verdict.state === "supported" && "model" in verdict && cli.accepted,
      { verdict, cli: cli.detail },
    ));
  }

  console.log("\n== 3: an UNLISTED id is refused by both — including the usage-namespace lookalike ==");
  {
    // `grok-4.5-build` is what modelUsage reports as the effective model (SDD 474), yet it is NOT a
    // selectable id. If the adapter ever called this supported, a pin would fail at launch instead.
    for (const model of ["grok-4.5-build", "definitely-not-real-xyz"]) {
      const verdict = await registry.check(parseLaunchCommand(`grok -m ${model}`)!, process.env, scratch);
      const cli = cliAcceptsModel(model, scratch);
      checks.push(report(
        `'${model}': adapter says unsupported and the CLI refuses it`,
        verdict.state === "unsupported" && !cli.accepted,
        { verdict: verdict.state, code: "code" in verdict ? verdict.code : undefined, cli: cli.detail },
      ));
    }
  }

  console.log("\n== 4: no pin needs no catalog ==");
  {
    const verdict = await registry.check(parseLaunchCommand("grok")!, process.env, scratch);
    checks.push(report(
      "an unpinned launch is supported via the runtime default",
      verdict.state === "supported" && "source" in verdict && verdict.source === "default-model",
      verdict,
    ));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
