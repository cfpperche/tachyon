import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { composeInstructions, withBridgeGuidance, buildRoleDoc } from "../../src/roles/templates.js";
import { composeSpawnContractBrief } from "../../src/bridge/spawnContract.js";
import { BRIEF_FILE_THRESHOLD, briefFilePath, deliverableBody } from "../../src/agents/briefFile.js";
import { adapterFor } from "../../src/resume/adapters.js";

const BASE_SHA = "6885becd72dbd1a4eed270a3233f5d8e0a3e310e";
const fixtureRoot = path.resolve("test/fixtures/agent-soul-legacy");

describe("immutable BASE_SHA agent-soul legacy parity provenance", () => {
  it("fails closed unless the manifest, every fixture, and captured production seams are from the exact base", () => {
    const manifest = JSON.parse(readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8")) as {
      baseSha: string; fixtures: string[]; productionSeams: Record<string, string>;
    };
    expect(manifest.baseSha).toBe(BASE_SHA);
    expect(execFileSync("git", ["rev-parse", `${BASE_SHA}^{commit}`], { encoding: "utf8" }).trim()).toBe(BASE_SHA);
    for (const fixture of manifest.fixtures) {
      const value = JSON.parse(readFileSync(path.join(fixtureRoot, fixture), "utf8")) as { baseSha?: string };
      expect(value.baseSha, fixture).toBe(BASE_SHA);
    }
    for (const [seam, digest] of Object.entries(manifest.productionSeams)) {
      const bytes = execFileSync("git", ["show", `${BASE_SHA}:${seam}`]);
      expect(createHash("sha256").update(bytes).digest("hex"), seam).toBe(digest);
    }
  });

  it("byte-compares unchanged legacy seams while retaining the superseded long-pointer oracle", () => {
    const fixture = JSON.parse(readFileSync(path.join(fixtureRoot, "prompt-command-cases.json"), "utf8")) as {
      cases: Array<{ baseSha: string; name: string; bytes: string; sha256: string; sendKeys: string[] }>;
    };
    const task = "Current task: fix the parser.";
    const contract = composeSpawnContractBrief("child", {
      task: "Implement parser correction",
      context: "Existing parser mishandles quoted values",
      constraints: "Keep the public format byte-compatible",
      doneWhen: "Focused parser tests pass",
    }, undefined, "parent");
    const root = mkdtempSync(path.join(tmpdir(), "tachyon-legacy-parity-"));
    try {
      const actual = new Map<string, string | undefined>([
        ["role-only", composeInstructions("reviewer", undefined)],
        ["instructions-only", composeInstructions(undefined, "Persistent specialization.")],
        ["role-and-instructions", composeInstructions("reviewer", "Persistent specialization.")],
        ["bridge-guidance", withBridgeGuidance("Persistent specialization.", true)],
        ["ad-hoc-contract", contract],
        ["bound-delivery-task", withBridgeGuidance(composeInstructions("coder", `Persistent specialization.\n\n${task}`), true)],
        ["pipeline-task", withBridgeGuidance(composeInstructions("tester", `Persistent specialization.\n\n${task}`), true)],
        ["no-soul-reanchor", buildRoleDoc("reviewer", "reviewer", "Persistent specialization.")],
        ["short-body", deliverableBody(root, "capture-short", "short exact body")],
      ]);
      const longBody = "L".repeat(BRIEF_FILE_THRESHOLD + 1);
      // Current main correctly reports UTF-8 transport bytes; the immutable legacy fixture predates
      // that wording. Normalize only this reviewed label so every other legacy byte remains exact.
      actual.set("long-body-pointer", deliverableBody(root, "capture-long", longBody)
        .replaceAll(root, "<WORKSPACE_ROOT>")
        .replace(`(${Buffer.byteLength(longBody, "utf8")} UTF-8 bytes)`, `(${longBody.length} chars)`));
      expect(readFileSync(briefFilePath(root, "capture-long"), "utf8")).toBe(longBody);
      const HISTORICAL_BRIDGE_GUIDANCE_EXCEPTIONS: Record<string, string> = {
        "bridge-guidance": "t-f050af moved repository coordination methods out of product guidance",
        "bound-delivery-task": "t-f050af moved repository coordination methods out of product guidance",
        "pipeline-task": "t-f050af moved repository coordination methods out of product guidance",
      };
      for (const item of fixture.cases) {
        expect(item.baseSha, item.name).toBe(BASE_SHA);
        expect(createHash("sha256").update(item.bytes).digest("hex"), item.name).toBe(item.sha256);
        if (item.name === "long-body-pointer") {
          // SDD 411 intentionally supersedes only this aggregate label. Keep validating the
          // immutable BASE fixture/hash above; the current startup-pointer oracle lives in the
          // focused startup-brief tests and must not rewrite historical provenance.
          expect(actual.get(item.name), item.name).not.toBe(item.bytes);
          expect(actual.get(item.name), item.name).toContain("Your full startup brief is long");
          continue;
        }
        const supersessionReason = HISTORICAL_BRIDGE_GUIDANCE_EXCEPTIONS[item.name];
        if (supersessionReason) {
          // Named SDD 411-style exception: the immutable BASE bytes/hash above remain the oracle,
          // while the live seam intentionally supersedes the repository convention it used to ship.
          expect(supersessionReason, item.name).toContain("t-f050af");
          expect(actual.get(item.name), item.name).not.toContain("A bug you find is a task");
          expect(actual.get(item.name), item.name).not.toContain("declared verify gate");
          continue;
        }
        expect(actual.get(item.name), item.name).toBe(item.bytes);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins exact BASE_SHA resume/rebind/fork commands and send-key payloads", () => {
    const fixture = JSON.parse(readFileSync(path.join(fixtureRoot, "lifecycle-bypass-cases.json"), "utf8")) as {
      cases: Array<{ baseSha: string; name: string; bytes: string; sha256: string; sendKeys: string[] }>;
    };
    const claude = adapterFor("claude")!;
    const actual = new Map([
      ["resume-command", claude.resumeCommand("claude --permission-mode plan", "uuid-1")],
      ["host-rebind-command", claude.resumeCommand("claude --model sonnet", "session-a")],
      ["native-fork-command", claude.forkCommand!(claude.injectId("claude", "<FORK_SESSION>"), "abcdef01-2345-6789-abcd-ef0123456789")],
    ]);
    for (const item of fixture.cases) {
      expect(item.baseSha, item.name).toBe(BASE_SHA);
      expect(actual.get(item.name), item.name).toBe(item.bytes);
      expect(createHash("sha256").update(item.bytes).digest("hex"), item.name).toBe(item.sha256);
      expect(item.sendKeys, item.name).toEqual([]);
    }
  });
});
