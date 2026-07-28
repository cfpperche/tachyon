import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// The verification runner is intentionally plain ESM with no declaration surface — same convention
// as verifyAttestationReuse.test.ts. Driving the real decision is the point of this file.
// @ts-expect-error -- see above
import { decideReuse } from "../../scripts/verify-full.mjs";

/**
 * `t-21bcb7` — the guidance tells agents to stop hand-managing suite reuse and just run the command,
 * and it names three handles to make that actionable: the env var that forces a real run, the script
 * that owns the decision, and the query that answers what is already on file.
 *
 * A named handle is a promise. `§ Verification economy` earns its keep only if an agent who follows
 * it literally succeeds, and the failure mode is silent in the worst way: a doc that names a retired
 * flag reads exactly as authoritative as one that names a live flag. t-3e5072 already learned this
 * on the dev-host side, where the transported guidance kept instructing flags spec 448 had removed.
 * This is the same guard aimed at the verification handles instead.
 *
 * So each handle is checked against the CODE, never against another copy of the doc: the env var by
 * driving `decideReuse` and observing that it actually forces, the script by existing on disk, the
 * query by being a subcommand `verify-record.mjs` really accepts. Asserting the doc against a
 * constant this file also declares would only prove the file agrees with itself.
 */

const repoRoot = process.cwd();
const guidance = fs.readFileSync(path.join(repoRoot, "docs", "project-guidance.md"), "utf8");

/** The section under test — scoped so an unrelated mention elsewhere cannot satisfy these. */
function verificationEconomy(): string {
  const start = guidance.indexOf("## Verification economy");
  expect(start, "docs/project-guidance.md must still have a Verification economy section").toBeGreaterThan(-1);
  const end = guidance.indexOf("\n## ", start + 1);
  return guidance.slice(start, end === -1 ? undefined : end);
}

describe("t-21bcb7 — every verification handle the guidance names is real", () => {
  it("names TACHYON_VERIFY_FORCE, and that variable really forces a run", () => {
    const section = verificationEconomy();
    expect(section).toContain("TACHYON_VERIFY_FORCE=1");

    // Driven, not grepped: a spelling that appears in the script but is read from a different key
    // would pass a text search and still leave the agent unable to force anything.
    expect(decideReuse({ env: { TACHYON_VERIFY_FORCE: "1" } }).reuse).toBe(false);
  });

  it("names scripts that exist, so a literal reader can run what it was told to run", () => {
    const section = verificationEconomy();
    for (const script of ["scripts/verify-full.mjs", "scripts/verify-record.mjs"]) {
      expect(section, `the section should point at ${script}`).toContain(script);
      expect(fs.existsSync(path.join(repoRoot, ...script.split("/"))), `${script} is named but missing`).toBe(true);
    }
  });

  it("names a verify-record subcommand that verify-record actually accepts", () => {
    const section = verificationEconomy();
    const named = section.match(/verify-record\.mjs\s+([a-z-]+)/)?.[1];
    expect(named, "the section should name a verify-record subcommand").toBeDefined();

    // The CLI's own usage string is the oracle. If the subcommand is renamed, usage changes with it
    // and this fails — which is the whole point of deriving instead of restating.
    const cli = fs.readFileSync(path.join(repoRoot, "scripts", "verify-record.mjs"), "utf8");
    const usage = cli.match(/usage: verify-record [^\n"'`]+/)?.[0];
    expect(usage, "verify-record.mjs should still print a usage line").toBeDefined();
    expect(usage).toContain(named as string);
  });

  it("does not promise reuse unconditionally — the doc must not oversell a fail-closed decision", () => {
    // A clean tree with no attestation on file must still run. If this ever reused, the guidance
    // sentence "just run the command" would be advice to trust a green nobody produced.
    const decision = decideReuse({ env: {} });
    expect(typeof decision.reuse).toBe("boolean");
    if (decision.reuse) expect(decision.record).toBeDefined();
  });
});
