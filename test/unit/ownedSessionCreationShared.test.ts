import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * SDD 482 phase 1 — `spawnCore` and `commitFork` must create their pane through ONE implementation.
 *
 * This is a source-shape test on purpose, and the reason is the failure it guards. The two paths had
 * already drifted into copies, and fork's own comment conceded it — "Merged last for the same reason
 * as spawnCore" copies the REASONING, not the code, which is exactly how a security-critical ordering
 * survives in one caller and rots in the other. A behavioural test cannot see a second `newSession`
 * appearing; a reader six months from now cannot either. This can.
 *
 * The ordering being protected is the post-cut attestation applied by the shared door.
 */
const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../packages/engine/src/agents/AgentManager.ts"),
  "utf8",
);

/** A method's own body: from its signature to the next method at class-member indentation. */
function methodBody(signature: string): string {
  const start = SOURCE.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  const rest = SOURCE.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:private |public |protected )?(?:async )?[a-zA-Z_][\w]*\(/);
  return rest.slice(0, next < 0 ? undefined : next);
}

/** Which methods contain a line matching `pattern` — the nearest signature at member indentation. */
function methodsContaining(pattern: RegExp): string[] {
  const lines = SOURCE.split("\n");
  const found = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!pattern.test(line)) continue;
    let owner = "<top level>";
    for (let above = index; above >= 0; above--) {
      const signature = /^ {2}(?:private |public |protected )?(?:async )?([a-zA-Z_][\w]*)\(/.exec(lines[above]!);
      if (signature) { owner = signature[1]!; break; }
    }
    found.add(owner);
  }
  return [...found].sort();
}

describe("owned session creation is shared (SDD 482 phase 1)", () => {
  it("only createOwnedSession calls tmux.newSession for an agent pane", () => {
    const callers = SOURCE.split("\n")
      .map((line, index) => ({ line, at: index + 1 }))
      .filter((entry) => /this\.opts\.tmux\.newSession\(/.test(entry.line));

    // `createOwnedSession` (agent panes) and the low-level create/replace helper reached only from
    // the normal start path. A THIRD site means someone opened a second door — which is precisely
    // what adversarial review found in `commitFork` and what this slice closed.
    expect(callers.length).toBeLessThanOrEqual(3);
    expect(callers.length).toBeGreaterThan(0);
  });

  it("commitFork no longer builds its own session", () => {
    const body = methodBody("async commitFork(");
    expect(body).not.toMatch(/this\.opts\.tmux\.newSession\(/);
    expect(body).toMatch(/this\.createOwnedSession\(/);
  });

  it("spawnCore goes through the same door", () => {
    const body = methodBody("private async spawnCore(");
    expect(body).not.toMatch(/this\.opts\.tmux\.newSession\(/);
    expect(body).toMatch(/this\.createOwnedSession\(/);
  });

  it("the cut attestation is applied in the shared door", () => {
    const body = methodBody("private async createOwnedSession(");
    // Spread order is the whole invariant: caller env FIRST, then the things a caller must not be
    // able to forge or clear. t-fab832 added the post-cut attestation to that tail — same reason,
    // same position, and this assertion pins the full order rather than being relaxed to fit it.
    expect(body).toMatch(/env:\s*withPostCutAttestation\(input\.env\)/);
  });

  /**
   * t-e73e54 — this file asserted the attestation was applied "in one place" while measuring only ONE
   * door. `startSessionCommandUnlocked` was a second, and restart/resume went through it, so resumed
   * Saved Agents came back unattested and `legacyFleetGate` refused to activate the workspace.
   *
   * The literal spread is gone: applying the attestation is now a named helper, so a new creation path
   * either calls it or is visibly missing it. Behavioural coverage per path — spawn, respawn and the
   * kill+new replacement — lives in agentManager.test.ts, asserted on observed tmux arguments.
   */
  it("the attestation is applied only through the shared helper, by the two doors that exist", () => {
    const inlineSpreads = SOURCE.match(/\[POST_CUT_SESSION_ATTESTATION_ENV\]\s*:/g) ?? [];
    expect(inlineSpreads).toHaveLength(0);
    // t-374df3 — this asserted `=== 2` and stopped a third creation door WITHOUT naming it: "3 !== 2"
    // leaves whoever collects the failure unable to tell a new hole from a correct new caller. Stopping
    // is right (a new creation path is new behaviour, not a refactor, and t-e73e54 is why a human must
    // look), so the doors are named instead of counted. A new door still fails here — and says which.
    expect(methodsContaining(/withPostCutAttestation\(/)).toEqual([
      // the owned-session door, and the create/replace helper restart/resume reaches.
      "createOwnedSession",
      "startSessionCommandUnlocked",
    ]);
  });

  it("Pi admission is applied by the shared door, not per caller", () => {
    const body = methodBody("private async createOwnedSession(");
    expect(body).toMatch(/runtime === "pi"/);
    expect(body).toMatch(/withPiAdmission/);
  });
});
