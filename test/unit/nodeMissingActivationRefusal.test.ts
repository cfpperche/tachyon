/**
 * t-30af3e — the VSIX smoke `node-missing` door matches `extension.activate()` throwing
 * `EngineBundleError` whose message says the host needs Node on PATH
 * (`test/vsix-smoke/probe/suite.js`). That throw is raised by `resolveEngineRuntimeSource`.
 *
 * SDD 504 (`t-6e7d8a`) taught the activation attach loop to swallow folder-level failures so a
 * multi-root window can still render "startup fails". Swallowing `NODE_RUNTIME_NOT_FOUND` with
 * them is what made the packaged 0.93.3 door go red: activate() succeeded in 0ms on a host
 * with no Node. Retry cannot install Node; this is a host refusal, not a folder one.
 *
 * This file watches THE LOOP, not a helper. A helper that classifies the error while
 * `catch { continue }` still sits in `activate()` is the shape this repository already paid
 * for twice today.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EngineBundleError,
  isHostEngineRefusal,
} from "@tachyon/engine/engine-service/engineBundleStore.js";

const EXTENSION = path.resolve("apps/vscode-extension/src/extension.ts");

function activationAttachLoop(source: string): string {
  const start = source.indexOf(
    "for (const folder of folders.filter((f) => shouldActivateFolder",
  );
  expect(start, "activation attach loop is missing from extension.ts").toBeGreaterThan(-1);
  // The loop is short; cutting past the next top-level statement keeps a comment mentioning
  // the helper elsewhere from counting as the door.
  const sliced = source.slice(start, start + 1_200);
  const end = sliced.indexOf("void checkTachyonBuildProvenance");
  expect(end, "activation attach loop no longer sits before provenance check").toBeGreaterThan(-1);
  return sliced.slice(0, end);
}

describe("t-30af3e — node-missing refuses at the activation boundary", () => {
  it("the activate() attach loop rethrows a host engine refusal instead of swallowing every error", () => {
    const loop = activationAttachLoop(fs.readFileSync(EXTENSION, "utf8"));
    expect(loop).toContain("await addWorkspace(folder.uri.fsPath, true)");
    expect(loop).toMatch(
      /\} catch \(error\) \{\s*if \(isHostEngineRefusal\(error\)\) throw error;\s*continue;\s*\}/,
    );
    expect(loop).not.toMatch(/catch \{\s*continue;\s*\}/);
  });

  it("isHostEngineRefusal names only NODE_RUNTIME_NOT_FOUND", () => {
    expect(isHostEngineRefusal(new EngineBundleError(
      "NODE_RUNTIME_NOT_FOUND",
      "the local Electron Extension Host requires a real Node executable on PATH",
    ))).toBe(true);
    // A folder-level attach failure must still be swallowable — SDD 504's multi-root contract.
    expect(isHostEngineRefusal(new EngineBundleError("DIRTY_BUILD", "dirty"))).toBe(false);
    expect(isHostEngineRefusal(new Error("requires a real Node executable on PATH"))).toBe(false);
    expect(isHostEngineRefusal({ name: "EngineBundleError", code: "NODE_RUNTIME_NOT_FOUND" })).toBe(true);
    expect(isHostEngineRefusal(null)).toBe(false);
  });
});
