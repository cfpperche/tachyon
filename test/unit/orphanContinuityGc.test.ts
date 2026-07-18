import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteActivityLog, agentLogId } from "../../src/activity/logStore.js";
import {
  gcOrphanAgentFootprints,
  isOrphanAgent,
  listContinuityAgentNames,
} from "../../src/continuity/orphanGc.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-orphan-gc-"));
}

describe("t-8310ca orphan continuity/activity GC", () => {
  it("lists agents from brief and state filenames", () => {
    const root = tmpRoot();
    const dir = path.join(root, ".tachyon", "continuity");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hermes.md"), "x");
    fs.writeFileSync(path.join(dir, "dead.state.json"), "{}");
    fs.writeFileSync(path.join(dir, "both.md"), "x");
    fs.writeFileSync(path.join(dir, "both.state.json"), "{}");
    fs.writeFileSync(path.join(dir, "ignore.txt"), "x");
    expect(listContinuityAgentNames(dir)).toEqual(["both", "dead", "hermes"]);
  });

  it("keeps known agents and removes only orphans", () => {
    const root = tmpRoot();
    const cont = path.join(root, ".tachyon", "continuity");
    const act = path.join(root, ".tachyon", "activity");
    fs.mkdirSync(cont, { recursive: true });
    fs.mkdirSync(act, { recursive: true });
    for (const name of ["hermes", "orphan-a", "orphan-b"]) {
      fs.writeFileSync(path.join(cont, `${name}.md`), `# ${name}\n`);
      fs.writeFileSync(path.join(cont, `${name}.state.json`), "{}\n");
      const base = path.join(act, agentLogId(name));
      fs.writeFileSync(`${base}.jsonl`, "{}\n");
      fs.writeFileSync(`${base}.state.json`, "{}\n");
    }

    const result = gcOrphanAgentFootprints({
      workspaceRoot: root,
      knownAgents: new Set(["hermes"]),
      dryRun: false,
      activity: true,
    });

    expect(result.orphans).toEqual(["orphan-a", "orphan-b"]);
    expect(fs.existsSync(path.join(cont, "hermes.md"))).toBe(true);
    expect(fs.existsSync(path.join(cont, "orphan-a.md"))).toBe(false);
    expect(fs.existsSync(path.join(cont, "orphan-b.state.json"))).toBe(false);
    expect(fs.existsSync(path.join(act, `${agentLogId("hermes")}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(act, `${agentLogId("orphan-a")}.jsonl`))).toBe(false);
  });

  it("dry-run reports without deleting", () => {
    const root = tmpRoot();
    const cont = path.join(root, ".tachyon", "continuity");
    fs.mkdirSync(cont, { recursive: true });
    fs.writeFileSync(path.join(cont, "gone.md"), "x");
    const result = gcOrphanAgentFootprints({
      workspaceRoot: root,
      knownAgents: new Set(),
      dryRun: true,
    });
    expect(result.orphans).toEqual(["gone"]);
    expect(result.removedContinuity).toEqual(["gone"]);
    expect(fs.existsSync(path.join(cont, "gone.md"))).toBe(true);
  });

  it("isOrphanAgent is false for known names", () => {
    expect(isOrphanAgent("hermes", new Set(["hermes"]))).toBe(false);
    expect(isOrphanAgent("x", new Set(["hermes"]))).toBe(true);
  });

  it("activity-only path uses deleteActivityLog shape", () => {
    const root = tmpRoot();
    const act = path.join(root, ".tachyon", "activity");
    fs.mkdirSync(act, { recursive: true });
    const name = "temp";
    const base = path.join(act, agentLogId(name));
    fs.writeFileSync(`${base}.jsonl`, "1\n");
    deleteActivityLog(act, name);
    expect(fs.existsSync(`${base}.jsonl`)).toBe(false);
  });
});
