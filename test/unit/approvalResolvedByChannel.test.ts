/**
 * t-86e59a — the guard: NO resolution path records a value that asserts an ACTOR.
 *
 * `resolvedBy` used to hold `"vscode"` or `"companion"`, server-side constants naming someone the host
 * has no way to observe. Three doors reach resolution with no human gesture (approvalRequest.ts,
 * invariant (3)), so a human auditing a record read their own name for a decision they never made. The
 * fix was not to close the doors — that is the capability fix, t-5313dc, still open — but to stop
 * claiming what is not proven. `resolvedBy` now names the CHANNEL.
 *
 * This file fails if that regresses, and it guards three different ways to regress, because no single
 * one of them covers the others:
 *
 *  (1) THE VALUE — a declared channel that reads like an actor. Caught by shape assertions below.
 *  (2) A NEW CALL SITE — someone wires a fourth door with `resolvedBy: "whatever"`. Caught by the
 *      source enumeration: every `resolvedBy:` in src/ outside the resolver module must name one of the
 *      exported channel constants, never a literal. The TYPE (`ApprovalResolutionChannel`) already
 *      refuses an undeclared literal at compile time; the enumeration is what catches the cast that
 *      talks its way past the type, and the type is what catches a spelling this scan cannot see. They
 *      are deliberately redundant — a static scan that is the only guard is a guard nobody rechecks.
 *  (3) THE TWO DURABLE PLACES DRIFTING APART — the record and the `.tachyon/approvals.jsonl` ledger
 *      repeat the same claim, which is why the false trail was durable twice. Asserted behaviourally,
 *      through `resolveApproval` itself.
 *
 * What this file does NOT claim: that the doors are closed. They are open, on purpose, and the two
 * characterization tests (approvalResolveSocketReachability, companionPairApprovalReachability) still
 * walk through them end to end. This only proves that walking through one no longer forges a name.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVAL_CHANNEL_COMPANION_HTTP,
  APPROVAL_CHANNEL_VSCODE_COMMAND,
  APPROVAL_RESOLUTION_CHANNELS,
  APPROVALS_WITNESS_REL_PATH,
  buildApprovalRequest,
  readApprovalRequest,
  resolveApproval,
  writeApprovalRequest,
} from "../../src/bridge/approvalRequest.js";

/** The values the product used to write. They are history in old records, and never legal again. */
const RETIRED_ACTOR_CLAIMS = ["vscode", "companion", "vscode-user", "human", "user"];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-approval-channel-"));
  roots.push(root);
  return root;
}

/** Every `.ts` under src/, so a new call site cannot hide in a directory this test predates. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx")) ? [full] : [];
  });
}

describe("t-86e59a — `resolvedBy` names a channel, never an actor", () => {
  it("every declared channel names a door and cannot be read as a proven actor", () => {
    expect(APPROVAL_RESOLUTION_CHANNELS.length).toBeGreaterThan(0);
    for (const channel of APPROVAL_RESOLUTION_CHANNELS) {
      // The prefix is the whole point: the FIELD is still called `resolvedBy`, so the VALUE has to be
      // what stops a glance from reading it as a person.
      expect(channel, `channel '${channel}' must declare that no actor is attributed`).toMatch(
        /^unattributed:/,
      );
      // Distinguishable from the old values, so history stays legible as "written before we knew".
      expect(RETIRED_ACTOR_CLAIMS, `channel '${channel}' is a retired actor claim`).not.toContain(channel);
      // And not merely prefixed: `unattributed:vscode` would still hand an auditor a bare product name.
      expect(channel.slice("unattributed:".length).length).toBeGreaterThan(0);
    }
    // A regression that "fixes" this test by widening the allowed set is the regression.
    for (const retired of RETIRED_ACTOR_CLAIMS) {
      expect(APPROVAL_RESOLUTION_CHANNELS as readonly string[]).not.toContain(retired);
    }
  });

  it("no call site in src/ passes a `resolvedBy` literal — every one names a declared channel constant", () => {
    const allowed = ["APPROVAL_CHANNEL_VSCODE_COMMAND", "APPROVAL_CHANNEL_COMPANION_HTTP"];
    // The resolver module is excluded because it DECLARES the field and plumbs it (`input.resolvedBy`);
    // it is asserted separately below, so the exclusion cannot become a hiding place.
    const resolverModule = path.join(process.cwd(), "src/bridge/approvalRequest.ts");
    const offenders: string[] = [];
    const callSites: string[] = [];
    for (const file of sourceFiles(path.join(process.cwd(), "src"))) {
      if (file === resolverModule) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        // Skip comment lines: prose ABOUT the field is not a call site, and the doc comments deliberately
        // quote it. A trailing comment on a real call site is stripped from the value instead.
        if (/^\s*(\*|\/\/)/.test(line)) return;
        const match = /\bresolvedBy\s*:\s*([^,}]+)/.exec(line);
        if (!match) return;
        const value = match[1].replace(/\/\/.*$/, "").trim();
        const where = `${path.relative(process.cwd(), file)}:${index + 1}`;
        callSites.push(`${where} -> ${value}`);
        if (!allowed.includes(value)) offenders.push(`${where} -> ${value}`);
      });
    }
    // Fail LOUD with the offending site, so the next reader sees which door regressed.
    expect(offenders, `resolvedBy must name a channel constant, not a literal:\n${offenders.join("\n")}`)
      .toEqual([]);
    // Both known doors are still wired — an enumeration that silently matches nothing proves nothing.
    expect(callSites.length).toBe(2);
    expect(callSites.some((site) => site.includes("extensionOperationService.ts"))).toBe(true);
    expect(callSites.some((site) => site.includes("Workspace.ts"))).toBe(true);
  });

  it("the resolver module never hard-codes a resolution actor of its own", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/bridge/approvalRequest.ts"), "utf8");
    const lines = source.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line));
    for (const line of lines) {
      // `resolvedBy: "anything"` — the resolver must only ever pass through what a call site handed it.
      expect(line, `resolver assigns a literal resolvedBy: ${line.trim()}`).not.toMatch(
        /\bresolvedBy\s*:\s*["'`]/,
      );
    }
  });

  it.each([
    ["door 1 — control-socket named action", APPROVAL_CHANNEL_VSCODE_COMMAND],
    ["door 2 — Companion HTTP", APPROVAL_CHANNEL_COMPANION_HTTP],
  ] as const)("%s: the record and the ledger record the CHANNEL, and record it identically", async (_door, channel) => {
    const workspaceRoot = tempWorkspace();
    const request = buildApprovalRequest({
      requester: "requesteragent",
      session: "tachyon-requesteragent",
      reason: "needs a human to authorize removing a safety guard",
      proposedAction: "remove the guard",
      risk: "high",
      exactPrompt: "may I remove it?",
      id: "a-ddd444",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    writeApprovalRequest(workspaceRoot, request);

    await resolveApproval({
      workspaceRoot,
      id: "a-ddd444",
      decision: "approved",
      resolvedBy: channel,
      now: "2026-08-05T00:00:01.000Z",
      inject: async () => ({ receipt: "typed" }),
    });

    const record = readApprovalRequest(workspaceRoot, "a-ddd444");
    expect(record.resolution?.resolvedBy).toBe(channel);
    for (const retired of RETIRED_ACTOR_CLAIMS) {
      expect(record.resolution?.resolvedBy).not.toBe(retired);
    }

    // The ledger is the second durable place, and it is why the old trail was false TWICE. It has to
    // carry the same value, and the assertion is on equality with the record rather than on the literal
    // so the two can never be updated apart.
    const witness = fs.readFileSync(path.join(workspaceRoot, APPROVALS_WITNESS_REL_PATH), "utf8");
    const resolvedLine = witness
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { kind: string; by?: string })
      .find((event) => event.kind === "resolved");
    expect(resolvedLine?.by).toBe(record.resolution?.resolvedBy);
  });
});
