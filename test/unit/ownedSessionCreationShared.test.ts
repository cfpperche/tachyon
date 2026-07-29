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
 * The ordering being protected: the minted execution env is merged LAST, after agent-declared and
 * bridge env. Everywhere else the agent's own env wins. Here it must not, because a forgeable
 * execution id lets a pane claim an attribution it was never given.
 */
const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../src/agents/AgentManager.ts"),
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

  it("the minted execution env is merged last, in one place", () => {
    const body = methodBody("private async createOwnedSession(");
    // Spread order is the whole invariant: caller env first, minted second.
    expect(body).toMatch(/env:\s*\{\s*\.\.\.input\.env,\s*\.\.\.input\.minted\.env\s*\}/);
    // And no caller may re-merge minted env itself, which would reintroduce the drift.
    expect(SOURCE).not.toMatch(/\.\.\.spawnBridge\.env,\s*\.\.\.minted\.env/);
    expect(SOURCE).not.toMatch(/\.\.\.forkBridge\.env,\s*\.\.\.forkMinted\.env/);
  });

  it("Pi admission is applied by the shared door, not per caller", () => {
    const body = methodBody("private async createOwnedSession(");
    expect(body).toMatch(/runtime === "pi"/);
    expect(body).toMatch(/withPiAdmission/);
  });
});
