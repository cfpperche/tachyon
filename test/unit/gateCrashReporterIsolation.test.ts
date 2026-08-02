import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-dab79c — Electron's crashpad handler deliberately outlives its client. The editor-host runner
 * only waits for VS Code's top-level process, so enabling crash reporting in this disposable gate
 * can pin the downloaded executable forever after the test process has exited.
 */
const gateConfig = () => fs.readFileSync(path.resolve(__dirname, "..", "..", ".vscode-test.mjs"), "utf8");

describe("t-dab79c editor gate does not start a persistent crashpad handler", () => {
  it("passes VS Code's supported disable-crash-reporter switch to every gate run", () => {
    const source = gateConfig();

    expect(source).toContain('const GATE_LAUNCH_ARGS = ["--disable-crash-reporter"]');
    expect(source.match(/launchArgs: GATE_LAUNCH_ARGS/g)).toHaveLength(3);
  });
});
