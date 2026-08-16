import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GROK_INTERNAL_PLAN_UPDATES,
  grokInternalChecklistUpdatesPath,
  readGrokInternalChecklist,
} from "@tachyon/engine/runtime/grokInternalChecklistReader.js";

/**
 * t-904de5 — the production Grok plan reader, driven by updates.jsonl a real authenticated
 * session wrote (PoC 2026-08-16, grok 1.0.4, sessions 6bc8226f / 188ca393 / 1202ad7c).
 *
 * These tests import `readGrokInternalChecklist` — the host door. A helper-only parser that
 * the host never calls will not satisfy them. Disconnecting the reader (always mute, or a
 * canned projection that does not open updates.jsonl) turns the suite red.
 */

const FIXTURE_HOME = path.resolve("test/fixtures/grok-internal-plan");

const INDUCE = {
  cwd: "/tmp/t-339e47-grok-plan/m1-induce/cwd",
  sessionId: "6bc8226f-8fba-48d7-bd02-61b9a6eb55d9",
} as const;

const TRIVIAL = {
  cwd: "/tmp/t-339e47-grok-plan/m2-trivial/cwd",
  sessionId: "188ca393-8919-4261-ac9e-843c54c8f564",
} as const;

const EMPTY = {
  cwd: "/tmp/t-339e47-grok-plan/m4-empty/cwd",
  sessionId: "1202ad7c-09b9-4fed-8ec1-128437c17aa4",
} as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-plan-"));
  dirs.push(root);
  return root;
}

function writeUpdates(
  home: string,
  cwd: string,
  sessionId: string,
  lines: readonly unknown[],
): void {
  const file = grokInternalChecklistUpdatesPath({ configHome: home, cwd, sessionId });
  expect(file).toBeTypeOf("string");
  fs.mkdirSync(path.dirname(file!), { recursive: true });
  fs.writeFileSync(file!, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function sessionUpdate(update: Record<string, unknown>): unknown {
  return { method: "session/update", params: { update } };
}

describe("t-904de5 — readGrokInternalChecklist (production door)", () => {
  it("projects the measured authenticated induce session with todo_write ids preserved", () => {
    const plan = readGrokInternalChecklist({
      configHome: FIXTURE_HOME,
      cwd: INDUCE.cwd,
      sessionId: INDUCE.sessionId,
    });
    expect(plan).toEqual({
      state: "snapshot",
      items: [
        { id: "alpha", text: "step one", status: "pending" },
        { id: "beta", text: "step two", status: "pending" },
        { id: "gamma", text: "step three", status: "pending" },
      ],
    });
    if (plan.state === "snapshot") {
      for (const item of plan.items) {
        expect(item).not.toHaveProperty("blockedBy");
      }
    }
  });

  it("is mute when the plan channel never spoke, even if a leftover plan.json exists", () => {
    expect(
      readGrokInternalChecklist({
        configHome: FIXTURE_HOME,
        cwd: TRIVIAL.cwd,
        sessionId: TRIVIAL.sessionId,
      }),
    ).toEqual({ state: "mute" });
    expect(
      readGrokInternalChecklist({
        configHome: tempHome(),
        cwd: INDUCE.cwd,
        sessionId: INDUCE.sessionId,
      }),
    ).toEqual({ state: "mute" });
  });

  it("is an empty snapshot when the channel spoke with zero items, not mute", () => {
    expect(
      readGrokInternalChecklist({
        configHome: FIXTURE_HOME,
        cwd: EMPTY.cwd,
        sessionId: EMPTY.sessionId,
      }),
    ).toEqual({ state: "snapshot", items: [] });

    const home = tempHome();
    const cwd = "/tmp/empty-todos-only";
    const sessionId = "cccccccc-dddd-4eee-8fff-000000000000";
    writeUpdates(home, cwd, sessionId, [
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        status: "completed",
        rawOutput: {
          type: "Todo",
          TodosUpdated: {
            todos: [],
            state: { todos: {} },
            summary_for_prompt: "No tasks currently tracked.",
          },
        },
      }),
    ]);
    expect(readGrokInternalChecklist({ configHome: home, cwd, sessionId })).toEqual({
      state: "snapshot",
      items: [],
    });
  });

  it("fails if the reader does not open updates.jsonl (red proof)", () => {
    const home = tempHome();
    const cwd = "/tmp/red-proof";
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    writeUpdates(home, cwd, sessionId, [
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        status: "completed",
        rawOutput: {
          type: "Todo",
          TodosUpdated: {
            todos: [{ content: "CANARY_UPDATES_READ", status: "completed" }],
            state: {
              todos: {
                canary: { content: "CANARY_UPDATES_READ", status: "completed", priority: "medium" },
              },
            },
          },
        },
      }),
    ]);
    expect(readGrokInternalChecklist({ configHome: home, cwd, sessionId })).toEqual({
      state: "snapshot",
      items: [{ id: "canary", text: "CANARY_UPDATES_READ", status: "completed" }],
    });
  });

  it("does not treat a missing or decoy plan.json as the store", () => {
    const home = tempHome();
    const cwd = "/tmp/plan-json-is-not-the-store";
    const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const sessionDir = path.dirname(
      grokInternalChecklistUpdatesPath({ configHome: home, cwd, sessionId })!,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "plan.json"),
      JSON.stringify({
        todos: { decoy: { content: "WRONG_FROM_PLAN_JSON", status: "completed" } },
      }),
    );
    expect(readGrokInternalChecklist({ configHome: home, cwd, sessionId })).toEqual({ state: "mute" });

    writeUpdates(home, cwd, sessionId, [
      sessionUpdate({
        sessionUpdate: "plan",
        entries: [{ content: "from updates", status: "in_progress" }],
      }),
    ]);
    expect(readGrokInternalChecklist({ configHome: home, cwd, sessionId })).toEqual({
      state: "snapshot",
      items: [{ text: "from updates", status: "in-progress" }],
    });
  });

  it("proves a post-dismiss read is mute — capture has to be live", () => {
    const home = tempHome();
    const cwd = INDUCE.cwd;
    const sessionId = INDUCE.sessionId;
    const src = grokInternalChecklistUpdatesPath({
      configHome: FIXTURE_HOME,
      cwd,
      sessionId,
    });
    const dest = grokInternalChecklistUpdatesPath({ configHome: home, cwd, sessionId });
    expect(src).toBeTypeOf("string");
    expect(dest).toBeTypeOf("string");
    fs.mkdirSync(path.dirname(dest!), { recursive: true });
    fs.copyFileSync(src!, dest!);

    const live = readGrokInternalChecklist({ configHome: home, cwd, sessionId });
    expect(live).toEqual({
      state: "snapshot",
      items: [
        { id: "alpha", text: "step one", status: "pending" },
        { id: "beta", text: "step two", status: "pending" },
        { id: "gamma", text: "step three", status: "pending" },
      ],
    });

    fs.rmSync(path.dirname(dest!), { recursive: true, force: true });
    expect(readGrokInternalChecklist({ configHome: home, cwd, sessionId })).toEqual({ state: "mute" });
  });

  it("this suite calls the production reader, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/grokInternalChecklistReader.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/grokInternalChecklistReader\.js"/);
    expect(source).toMatch(/readGrokInternalChecklist\(/);
    expect(source).not.toMatch(/function readGrokInternalChecklist\(/);
    const reader = fs.readFileSync(
      path.resolve("packages/engine/src/runtime/grokInternalChecklistReader.ts"),
      "utf8",
    );
    expect(reader).toMatch(new RegExp(GROK_INTERNAL_PLAN_UPDATES.replace(".", "\\.")));
    expect(reader).not.toMatch(/plan\.json/);
    expect(reader).not.toMatch(/chat_history\.jsonl/);
    expect(reader).not.toMatch(/resources_state\.json/);
  });
});
