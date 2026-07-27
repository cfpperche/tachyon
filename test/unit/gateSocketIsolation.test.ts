import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-05097f — the gate must never name the shared tmux server.
 *
 * The suite used to hardcode `-L tachyon` in 17 places, which is how its "Stop All" scenario came to
 * list real running agents and how sessions leaked between runs. One stale LOG LINE outlived the
 * fix and still said "shared server" while reading the isolated socket — and it cost a wrong
 * diagnosis, because the message was read as evidence. So this guard covers the literal AND the
 * prose: an inventory, not a spot check, since the defect is a straggler nobody notices.
 */
const GATE_FILES = [
  "test/integration/extension.test.js",
  "test/integration/surfacePreservationDogfood.test.js",
  "test/integration-multiroot/multiroot.test.js",
];

function readGateFile(relative: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", "..", relative), "utf8");
}

describe("t-05097f gate never touches the shared tmux server", () => {
  it.each(GATE_FILES)("%s hardcodes no default socket", (relative) => {
    const code = readGateFile(relative).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/"-L",\s*"tachyon"/);
    expect(code).not.toMatch(/-L\s+tachyon(?![-\w])/);
  });

  it.each(GATE_FILES)("%s resolves the socket from the run's env", (relative) => {
    const code = readGateFile(relative);

    // Every file that talks to tmux must read the seam; none may invent its own default.
    if (code.includes('execFileSync("tmux"')) {
      expect(code).toContain("process.env.TACHYON_TMUX_SOCKET");
    }
  });

  it("describes the socket it actually read, never 'the shared server'", () => {
    // A message that names the wrong server is worse than none: it is read as evidence.
    for (const relative of GATE_FILES) {
      expect(readGateFile(relative), relative).not.toMatch(/shared server/i);
    }
  });
});
