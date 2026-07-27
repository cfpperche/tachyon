import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { EDITOR_HUMAN_ACTOR, type ValidationActor } from "../../src/validations/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function store(): ValidationStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-validation-actor-"));
  roots.push(root);
  return new ValidationStore(root);
}

const AGENT: ValidationActor = { kind: "agent", name: "codex" };

describe("who may close a validation (t-98256c)", () => {
  it("refuses an agent closing work reserved for a human, and says who can", async () => {
    const s = store();
    const reserved = await s.create({ title: "Install dogfood", author: "human", executor: "human" });

    await expect(s.closeRound(reserved.id, { actor: AGENT, outcome: "passed", result_note: "looks fine to me" }))
      .rejects.toThrow(/reserved for a human .*an agent cannot close it/s);
    // Refused means refused: no round was recorded and the validation is still open.
    expect(s.get(reserved.id)).toMatchObject({ status: "pending", rounds: [] });

    // The obvious bypass — hand it to myself first — is the same refusal.
    await expect(s.update(reserved.id, { actor: AGENT, executor: "agent" }))
      .rejects.toThrow(/reserved for a human .*an agent cannot change its executor/s);
    expect(s.get(reserved.id).executor).toBe("human");
  });

  it("lets the human close their own work, and the fleet close work meant for it", async () => {
    const s = store();
    const reserved = await s.create({ title: "Install dogfood", author: "human", executor: "human" });
    const closed = await s.closeRound(reserved.id, { actor: EDITOR_HUMAN_ACTOR, outcome: "passed", result_note: "ran the installed build" });
    expect(closed.rounds.at(-1)).toMatchObject({ outcome: "passed", closedBy: { kind: "human", name: "vscode" } });

    const forFleet = await s.create({ title: "Regenerate fixtures", author: "human", executor: "agent" });
    const byAgent = await s.closeRound(forFleet.id, { actor: AGENT, outcome: "passed", result_note: "regenerated and diffed" });
    expect(byAgent.rounds.at(-1)?.closedBy).toEqual({ kind: "agent", name: "codex" });

    const either = await s.create({ title: "Spot check", author: "human", executor: "either" });
    await expect(s.closeRound(either.id, { actor: AGENT, outcome: "skipped", result_note: "covered by the suite" })).resolves.toBeTruthy();

    // A human may still hand reserved work to the fleet, and then the fleet may close it.
    const handed = await s.create({ title: "Second pass", author: "human", executor: "human" });
    await s.update(handed.id, { actor: EDITOR_HUMAN_ACTOR, executor: "either" });
    await expect(s.closeRound(handed.id, { actor: AGENT, outcome: "passed", result_note: "done" })).resolves.toBeTruthy();
  });

  it("records provenance that survives a reload, and leaves pre-t-98256c rounds alone", async () => {
    const s = store();
    const v = await s.create({ title: "Check", author: "human", executor: "agent" });
    await s.closeRound(v.id, { actor: AGENT, outcome: "failed", result_note: "crashed on start" });
    // Read back from disk, not from the returned object.
    expect(s.get(v.id).rounds.at(-1)?.closedBy).toEqual({ kind: "agent", name: "codex" });

    const file = path.join(s.dir, `${v.id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    delete stored.rounds[0].closedBy;
    fs.writeFileSync(file, JSON.stringify(stored, null, 2), "utf8");
    const legacy = s.get(v.id);
    expect(legacy.rounds).toHaveLength(1);
    expect(legacy.rounds[0]?.closedBy).toBeUndefined();

    // A reopened legacy round still closes, and the new round carries provenance.
    await s.update(v.id, { actor: EDITOR_HUMAN_ACTOR, status: "triaged" });
    const reclosed = await s.closeRound(v.id, { actor: EDITOR_HUMAN_ACTOR, outcome: "passed", result_note: "fixed" });
    expect(reclosed.rounds.map((round) => round.closedBy?.kind)).toEqual([undefined, "human"]);
  });

  it("takes no actor it could be told — the kind must be one Tachyon resolves", async () => {
    const s = store();
    const v = await s.create({ title: "Check", author: "human", executor: "agent" });
    await expect(s.closeRound(v.id, { actor: { kind: "wizard" } as unknown as ValidationActor, outcome: "passed", result_note: "n/a" }))
      .rejects.toThrow("invalid validation actor kind");
  });
});
