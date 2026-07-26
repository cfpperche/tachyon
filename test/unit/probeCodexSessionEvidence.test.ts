import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectCodexSessionEvidence,
  findRolloutFile,
  humanCodexHome,
  modelsFromRollout,
  parseThreadId,
  prepareCodexHome,
  PRIVATE_HOME_DIRNAME,
  removeCodexHome,
} from "../../src/probe/adapters/codexSessionEvidence.js";

const THREAD = "019fa07e-f2a7-7da1-a3b9-fe2cebc3884c";
const temporary: string[] = [];
function tmp(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  temporary.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

/** Exactly the stream measured on codex-cli 0.145.0 — no model identity anywhere in it. */
function stdoutFor(threadId: string = THREAD): string {
  return [
    `{"type":"thread.started","thread_id":"${threadId}"}`,
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
    '{"type":"turn.completed","usage":{"input_tokens":11755,"output_tokens":5}}',
  ].join("\n");
}

/** A rollout in the measured shape: session_meta first, then one turn_context per turn. */
function rolloutFor(sessionId: string, models: string[]): string {
  return [
    JSON.stringify({ timestamp: "2026-07-26T22:15:02.406Z", type: "session_meta", payload: { session_id: sessionId, id: sessionId, cli_version: "0.145.0" } }),
    ...models.map((model, i) =>
      JSON.stringify({ timestamp: "2026-07-26T22:15:03.077Z", type: "turn_context", payload: { turn_id: `turn-${i}`, model, effort: "medium" } })),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258400 } } }),
  ].join("\n");
}

/** Write a rollout where codex would put it: sessions/<y>/<m>/<d>/rollout-<ts>-<id>.jsonl */
function writeRollout(home: string, sessionId: string, body: string, fileId = sessionId): string {
  const dir = path.join(home, "sessions", "2026", "07", "26");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-26T19-15-02-${fileId}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

describe("codex session evidence — thread id correlation is exact or absent", () => {
  it("reads the single thread.started id", () => {
    expect(parseThreadId(stdoutFor()).sessionId).toBe(THREAD);
  });

  it("no thread.started at all → no session, with a stated reason", () => {
    const r = parseThreadId('{"type":"turn.completed","usage":{}}');
    expect(r.sessionId).toBeUndefined();
    expect(r.unavailable).toContain("no thread.started");
  });

  it("two distinct thread ids → refuses to pick one", () => {
    const r = parseThreadId(`${stdoutFor()}\n{"type":"thread.started","thread_id":"019fa080-84b3-75d0-ae7c-cb911d01f83d"}`);
    expect(r.sessionId).toBeUndefined();
    expect(r.unavailable).toContain("2 distinct thread ids");
  });

  it("the same id repeated is still one session", () => {
    expect(parseThreadId(`${stdoutFor()}\n{"type":"thread.started","thread_id":"${THREAD}"}`).sessionId).toBe(THREAD);
  });

  it("a truncated JSON line is skipped, not treated as a claim", () => {
    expect(parseThreadId(`{"type":"thread.star\n${stdoutFor()}`).sessionId).toBe(THREAD);
  });

  it("a thread id that is not a safe filename segment is refused", () => {
    const r = parseThreadId('{"type":"thread.started","thread_id":"../../etc/passwd"}');
    expect(r.sessionId).toBeUndefined();
    expect(r.unavailable).toContain("safe session identifier");
  });
});

describe("codex session evidence — the rollout must identify itself as this run", () => {
  it("returns every turn_context model, sorted", () => {
    expect(modelsFromRollout(rolloutFor(THREAD, ["gpt-5.6-luna"]), THREAD).models).toEqual(["gpt-5.6-luna"]);
    expect(modelsFromRollout(rolloutFor(THREAD, ["gpt-5.6-sol", "gpt-5.6-luna"]), THREAD).models)
      .toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
  });

  it("a rollout whose session_meta disagrees with the run is refused (filename is not proof)", () => {
    const r = modelsFromRollout(rolloutFor("some-other-session-id", ["gpt-5.6-luna"]), THREAD);
    expect(r.models).toBeUndefined();
    expect(r.unavailable).toContain("different session");
  });

  it("a rollout with no session_meta cannot confirm itself", () => {
    const body = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna" } });
    const r = modelsFromRollout(body, THREAD);
    expect(r.models).toBeUndefined();
    expect(r.unavailable).toContain("no session_meta");
  });

  it("a rollout with no turn_context model yields nothing rather than a guess", () => {
    const r = modelsFromRollout(rolloutFor(THREAD, []), THREAD);
    expect(r.models).toBeUndefined();
    expect(r.unavailable).toContain("no turn_context model");
  });

  it("a trailing partial line does not invalidate the records already read", () => {
    const r = modelsFromRollout(`${rolloutFor(THREAD, ["gpt-5.6-luna"])}\n{"type":"turn_c`, THREAD);
    expect(r.models).toEqual(["gpt-5.6-luna"]);
  });
});

describe("codex session evidence — locating the rollout", () => {
  it("finds the one rollout whose filename ends in the thread id", async () => {
    const home = tmp("tachyon-codex-find-");
    writeRollout(home, THREAD, rolloutFor(THREAD, ["gpt-5.6-luna"]));
    writeRollout(home, "019fa080-84b3-75d0-ae7c-cb911d01f83d", rolloutFor("019fa080-84b3-75d0-ae7c-cb911d01f83d", ["gpt-5.6-sol"]));
    const found = await findRolloutFile(path.join(home, "sessions"), THREAD);
    expect(found.file).toContain(THREAD);
  });

  it("no rollout for this thread → no evidence", async () => {
    const home = tmp("tachyon-codex-none-");
    const found = await findRolloutFile(path.join(home, "sessions"), THREAD);
    expect(found.file).toBeUndefined();
    expect(found.unavailable).toContain("no session rollout");
  });

  it("two rollouts claiming the same thread id → none is trusted", async () => {
    const home = tmp("tachyon-codex-dup-");
    writeRollout(home, THREAD, rolloutFor(THREAD, ["gpt-5.6-luna"]));
    const other = path.join(home, "sessions", "2026", "07", "25");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, `rollout-2026-07-25T10-00-00-${THREAD}.jsonl`), rolloutFor(THREAD, ["gpt-5.6-sol"]));
    const found = await findRolloutFile(path.join(home, "sessions"), THREAD);
    expect(found.file).toBeUndefined();
    expect(found.unavailable).toContain("2 rollouts");
  });
});

describe("codex session evidence — end-to-end correlation", () => {
  it("stream + rollout → the model codex recorded for this run", async () => {
    const home = tmp("tachyon-codex-e2e-");
    writeRollout(home, THREAD, rolloutFor(THREAD, ["gpt-5.6-luna"]));
    expect(await collectCodexSessionEvidence(home, stdoutFor())).toEqual({ sessionId: THREAD, models: ["gpt-5.6-luna"] });
  });

  it("a rollout named for this run but recording another session is refused", async () => {
    const home = tmp("tachyon-codex-tamper-");
    // The file NAME says this run; the contents say otherwise. The contents win.
    writeRollout(home, "019fa080-84b3-75d0-ae7c-cb911d01f83d", rolloutFor("019fa080-84b3-75d0-ae7c-cb911d01f83d", ["gpt-5.6-sol"]), THREAD);
    const evidence = await collectCodexSessionEvidence(home, stdoutFor());
    expect(evidence.models).toBeUndefined();
    expect(evidence.sessionId).toBe(THREAD);
    expect(evidence.unavailable).toContain("different session");
  });

  it("an empty home (codex crashed before writing) yields no evidence, not a throw", async () => {
    const home = tmp("tachyon-codex-crash-");
    const evidence = await collectCodexSessionEvidence(home, stdoutFor());
    expect(evidence.models).toBeUndefined();
    expect(evidence.unavailable).toContain("no session rollout");
  });

  it("an oversized rollout is refused rather than read in part", async () => {
    const home = tmp("tachyon-codex-huge-");
    const padded = `${rolloutFor(THREAD, ["gpt-5.6-luna"])}\n${JSON.stringify({ type: "pad", payload: { text: "x".repeat(9 * 1024 * 1024) } })}`;
    writeRollout(home, THREAD, padded);
    const evidence = await collectCodexSessionEvidence(home, stdoutFor());
    expect(evidence.models).toBeUndefined();
    expect(evidence.unavailable).toContain("too large");
  });
});

describe("codex session evidence — private home lifecycle", () => {
  it("prepares a private home under the scratch dir and links the credential", async () => {
    const scratch = tmp("tachyon-codex-home-");
    const fakeHumanHome = tmp("tachyon-codex-human-");
    fs.writeFileSync(path.join(fakeHumanHome, "auth.json"), '{"token":"secret"}');
    const home = await prepareCodexHome(scratch, { CODEX_HOME: fakeHumanHome } as NodeJS.ProcessEnv);
    expect(home).toBe(path.join(scratch, PRIVATE_HOME_DIRNAME));
    expect(fs.lstatSync(path.join(home, "auth.json")).isSymbolicLink()).toBe(true);
    // A symlink, not a copy: no secret bytes were duplicated onto disk.
    expect(fs.readlinkSync(path.join(home, "auth.json"))).toBe(path.join(fakeHumanHome, "auth.json"));
  });

  it("a missing credential is not an error — an API-key setup authenticates from the env", async () => {
    const scratch = tmp("tachyon-codex-noauth-");
    const home = await prepareCodexHome(scratch, { CODEX_HOME: tmp("tachyon-codex-empty-") } as NodeJS.ProcessEnv);
    expect(fs.existsSync(home)).toBe(true);
    expect(fs.existsSync(path.join(home, "auth.json"))).toBe(false);
  });

  it("removes the private home completely", async () => {
    const scratch = tmp("tachyon-codex-rm-");
    const home = await prepareCodexHome(scratch, { CODEX_HOME: tmp("tachyon-codex-empty2-") } as NodeJS.ProcessEnv);
    writeRollout(home, THREAD, rolloutFor(THREAD, ["gpt-5.6-luna"]));
    await removeCodexHome(home);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(scratch)).toBe(true); // the run's own artifacts survive
  });

  it("refuses to remove anything that is not a private home directory", async () => {
    const victim = tmp("tachyon-codex-victim-");
    fs.writeFileSync(path.join(victim, "auth.json"), "precious");
    await removeCodexHome(victim);
    await removeCodexHome(undefined);
    expect(fs.existsSync(path.join(victim, "auth.json"))).toBe(true);
  });

  it("resolves the human home from CODEX_HOME, else ~/.codex", () => {
    expect(humanCodexHome({ CODEX_HOME: "/custom/codex" } as NodeJS.ProcessEnv)).toBe("/custom/codex");
    expect(humanCodexHome({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), ".codex"));
  });
});
