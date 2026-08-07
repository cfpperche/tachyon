import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-dab79c — Electron's crashpad handler deliberately outlives its client. The editor-host runner
 * only waits for VS Code's top-level process, so enabling crash reporting in this disposable gate
 * can pin the downloaded executable forever after the test process has exited.
 */
const gateConfig = () => fs.readFileSync(path.resolve(__dirname, "..", "..", ".vscode-test.mjs"), "utf8");

/**
 * Each labelled configuration in the exported array, as `label` plus the text up to the next label.
 * Splitting on `label:` bounds every block by the one that follows it, so a block missing its
 * `launchArgs` cannot borrow the next block's.
 */
function gateConfigurations(source: string): { label: string; body: string }[] {
  const exported = source.slice(source.indexOf("export default defineConfig(["));
  return exported
    .split(/\blabel:\s*"/)
    .slice(1)
    .map((part) => ({ label: part.slice(0, part.indexOf('"')), body: part }));
}

describe("t-dab79c editor gate does not start a persistent crashpad handler", () => {
  it("passes VS Code's supported disable-crash-reporter switch to every gate run", () => {
    const source = gateConfig();

    expect(source).toContain('const GATE_LAUNCH_ARGS = ["--disable-crash-reporter"]');

    // t-60fcfc — this line used to read `expect(source.match(/launchArgs: GATE_LAUNCH_ARGS/g)).toHaveLength(3)`,
    // and a COUNT was answering neither half of what this file claims. It went red on a fourth
    // configuration that passed the switch correctly (nothing wrong, and the failure reads "4 !== 3"
    // without naming a label), and it stayed GREEN on a fourth configuration that passed
    // `launchArgs: ["--verbose"]` instead — a gate run that really does start the crashpad handler,
    // which is the whole defect this guard exists for. Both measured. The property the count stood in
    // for is "EVERY gate run gets launch args built from the shared constant", asserted per label.
    const configurations = gateConfigurations(source);
    expect(
      configurations.length,
      ".vscode-test.mjs declares no labelled configuration — this guard is enumerating nothing",
    ).toBeGreaterThan(0);

    expect(
      configurations.filter((c) => !/launchArgs:[^\n]*\bGATE_LAUNCH_ARGS\b/.test(c.body)).map((c) => c.label),
      "these gate configurations never pass GATE_LAUNCH_ARGS, so their Electron tree starts a crashpad handler",
    ).toEqual([]);

    // …and no `launchArgs` anywhere in the file is built without it, including outside the array.
    expect(
      [...source.matchAll(/launchArgs:\s*([^\n]+)/g)]
        .map((m) => m[1].replace(/,\s*$/, "").trim())
        .filter((value) => !value.includes("GATE_LAUNCH_ARGS")),
      "a launchArgs detached from GATE_LAUNCH_ARGS drops the switch it exists to carry",
    ).toEqual([]);
  });
});
