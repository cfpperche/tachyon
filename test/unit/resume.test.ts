import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runtimeOf,
  binaryOf,
  adapterFor,
  adapterForRuntime,
  forkable,
  managesOwnSession,
  encodeClaudeCwd,
  encodeGrokCwd,
  grokTranscriptPath,
  type ResumeRuntime,
} from "../../src/resume/adapters.js";
import {
  SessionLedger,
  hasDeliveryMarker,
  isInvalidDeliveryMarker,
  isResumable,
  isValidDeliveryBinding,
  type SessionRecord,
} from "../../src/resume/SessionLedger.js";
import { EVIDENCE_SCHEMA_VERSION, VERIFY_PRODUCER, STEP_RESULT_KIND, type WorktreeEvidence } from "../../src/worktree/evidence.js";
import { planResume, autoResumes, offers } from "../../src/resume/planResume.js";
import { resolveCodexId, resolveCodexSession, resolveOpencodeId, resolveAntigravityId, resolveCaptureId, resolveCaptureSession, resolveClaudeId, resolveClaudeIdByTitle, resolveCurrentSession, resolveHermesId } from "../../src/resume/resolvers.js";

describe("runtimeOf / binaryOf", () => {
  it("detects each supported runtime by binary", () => {
    expect(runtimeOf("claude")).toBe("claude");
    expect(runtimeOf("codex --model o3")).toBe("codex");
    expect(runtimeOf("agy")).toBe("antigravity");
    expect(runtimeOf("gemini -y")).toBe("gemini");
    expect(runtimeOf("opencode")).toBe("opencode");
    expect(runtimeOf("qwen")).toBe("qwen");
    expect(runtimeOf("cn")).toBe("continue");
    expect(runtimeOf("grok")).toBe("grok");
    expect(runtimeOf("hermes")).toBe("hermes");
    expect(runtimeOf("pi")).toBe("pi");
  });

  it("sees through launchers and env assignments", () => {
    expect(binaryOf("npx claude")).toBe("claude");
    expect(binaryOf("env FOO=1 codex")).toBe("codex");
    expect(binaryOf("env -u TOKEN codex")).toBe("codex");
    expect(binaryOf("env --chdir /repo hermes")).toBe("hermes");
    expect(binaryOf("/usr/local/bin/claude --permission-mode plan")).toBe("claude");
  });

  it("returns null for non-agent / unknown commands", () => {
    expect(runtimeOf("npm run dev")).toBeNull();
    expect(runtimeOf("bash")).toBeNull();
    expect(runtimeOf("aider")).toBeNull(); // no real resume -> not adapted
  });
});

describe("ResumeAdapter — mint runtimes (claude, gemini, grok, pi)", () => {
  it("claude: spawns a NAMED session (-n) and resumes by id/name, preserving flags (spec 220)", () => {
    const a = adapterFor("claude --permission-mode plan")!;
    expect(a.mintsId).toBe(true);
    expect(a.nameMint).toBe(true); // minted id is a deterministic name, not a random uuid
    expect(a.injectId("claude --permission-mode plan", "tachyon-Demo-claude")).toBe(
      "claude --permission-mode plan -n tachyon-Demo-claude",
    );
    // resume targets the captured uuid (or the name fallback) — same flag either way
    expect(a.resumeCommand("claude --permission-mode plan", "real-uuid")).toBe(
      "claude --permission-mode plan --resume real-uuid",
    );
  });

  it("gemini: mints + resumes by flag", () => {
    const a = adapterForRuntime("gemini")!;
    expect(a.mintsId).toBe(true);
    expect(a.injectId("gemini", "g1")).toBe("gemini --session-id g1");
    expect(a.resumeCommand("gemini", "g1")).toBe("gemini --resume g1");
  });

  it("pi: mints an exact id and resumes that id without deriving a timestamped path", () => {
    const a = adapterForRuntime("pi")!;
    expect(a.mintsId).toBe(true);
    expect(a.injectId("pi --model sonnet", "p1")).toBe("pi --model sonnet --session-id p1");
    expect(a.resumeCommand("pi --model sonnet", "p1")).toBe("pi --model sonnet --session p1");
    expect(a.transcriptPath).toBeUndefined();
  });

  it("grok: mints with -s, resumes with -r, and preserves self-managed commands", () => {
    const a = adapterForRuntime("grok")!;
    expect(a.mintsId).toBe(true);
    expect(a.injectId("grok --permission-mode plan", "g1")).toBe("grok --permission-mode plan -s g1");
    expect(a.resumeCommand("grok --permission-mode plan", "g1")).toBe("grok --permission-mode plan -r g1");
    expect(a.injectId("grok -s existing", "g1")).toBe("grok -s existing");
    expect(a.resumeCommand("grok -r existing", "g1")).toBe("grok -r existing");
  });

  it("claude: a self-resuming cmd (--resume/--continue) is run VERBATIM — no --session-id/--resume layered (else exit 1)", () => {
    const a = adapterForRuntime("claude")!;
    // user already manages the session — injecting our flags would conflict
    expect(a.injectId("claude --resume tachyon", "uuid-1")).toBe("claude --resume tachyon");
    expect(a.resumeCommand("claude --resume tachyon", "uuid-1")).toBe("claude --resume tachyon");
    expect(a.injectId("claude --continue", "uuid-1")).toBe("claude --continue");
    expect(a.injectId("claude -r abc", "uuid-1")).toBe("claude -r abc");
    // a plain claude cmd still mints normally — now a named session (spec 220)
    expect(a.injectId("claude", "tachyon-Demo-claude")).toBe("claude -n tachyon-Demo-claude");
  });

  it("spec 225/t-4891dd/t-7e3cba: runtimes with native fork commands are forkable", () => {
    const claude = adapterForRuntime("claude")!;
    expect(forkable(claude)).toBe(true);
    // the caller injects -n <fork-name> first; forkCommand appends the resume+fork flags
    expect(claude.forkCommand!("claude -n tachyon-Demo-claude-fork-1", "real-uuid")).toBe(
      "claude -n tachyon-Demo-claude-fork-1 --resume real-uuid --fork-session",
    );
    const grok = adapterForRuntime("grok")!;
    expect(forkable(grok)).toBe(true);
    expect(grok.forkCommand!("grok -s fork-uuid", "source-uuid")).toBe("grok -s fork-uuid -r source-uuid --fork-session");
    const opencode = adapterForRuntime("opencode")!;
    expect(forkable(opencode)).toBe(true);
    expect(opencode.forkCommand!("opencode", "source-id")).toBe("opencode -s source-id --fork");
    const pi = adapterForRuntime("pi")!;
    expect(forkable(pi)).toBe(true);
    expect(pi.forkCommand!(pi.injectId("pi --thinking high", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "/private/a session/source's.jsonl"))
      .toBe("pi --thinking high --session-id bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb --fork '/private/a session/source'\\''s.jsonl'");
    for (const rt of ["codex", "gemini", "antigravity", "qwen", "continue"] as const) {
      expect(forkable(adapterForRuntime(rt))).toBe(false);
    }
    expect(forkable(null)).toBe(false);
  });

  it("managesOwnSession detects session flags by exact token (not substring)", () => {
    expect(managesOwnSession("claude --resume x")).toBe(true);
    expect(managesOwnSession("claude --continue")).toBe(true);
    expect(managesOwnSession("claude -c")).toBe(true);
    expect(managesOwnSession("claude --session-id u")).toBe(true);
    expect(managesOwnSession("grok -s u")).toBe(true);
    expect(managesOwnSession("opencode --session u")).toBe(true);
    for (const command of [
      "pi --session u", "pi --session-id u", "pi --continue", "pi -c", "pi --resume", "pi -r",
      "pi --fork u", "pi --no-session", "pi --session=u", "pi --session-dir /tmp/s", "pi --session-dir=/tmp/s",
    ]) expect(managesOwnSession(command)).toBe(true);
    expect(managesOwnSession("pi --model sonnet")).toBe(false);
    expect(managesOwnSession("claude --permission-mode plan")).toBe(false);
    expect(managesOwnSession("claude --resumexyz")).toBe(false); // not a real flag
  });

  it("t-1a808e: distinguishes Codex config/sandbox flags from its resume subcommand", () => {
    expect(managesOwnSession("codex -c model=gpt-5.6-sol -c model_reasoning_effort=xhigh")).toBe(false);
    expect(managesOwnSession("codex -s danger-full-access")).toBe(false);
    expect(managesOwnSession("npx codex -c model=gpt-5.6-terra")).toBe(false);
    expect(managesOwnSession("codex resume thread-1")).toBe(true);
    expect(managesOwnSession("codex exec resume thread-1")).toBe(true);
    expect(managesOwnSession("env -u TOKEN codex resume thread-1")).toBe(true);
  });

  it("claude transcript path uses the cwd-encoding under the config home (spec 226: configHome arg)", () => {
    const a = adapterForRuntime("claude")!;
    // normal: configHome = ~/.claude
    expect(a.transcriptPath!("/home/me/.claude", "/home/me/proj.api", "u1")).toBe(
      "/home/me/.claude/projects/-home-me-proj-api/u1.jsonl",
    );
    // harness: configHome = a redirected CLAUDE_CONFIG_DIR (no implicit .claude segment)
    expect(a.transcriptPath!("/ws/.tachyon/harness/researcher", "/ws", "u2")).toBe(
      "/ws/.tachyon/harness/researcher/projects/-ws/u2.jsonl",
    );
  });
});

describe("ResumeAdapter — capture runtimes", () => {
  it("codex: no mint, resume is a subcommand right after the binary", () => {
    const a = adapterForRuntime("codex")!;
    expect(a.mintsId).toBe(false);
    expect(a.injectId("codex --model o3", "c1")).toBe("codex --model o3"); // identity
    expect(a.resumeCommand("codex", "c1")).toBe("codex resume c1");
    expect(a.resumeCommand("codex --model o3", "c1")).toBe("codex resume c1 --model o3");
    expect(a.resumeCommand("npx codex", "c1")).toBe("npx codex resume c1");
  });

  it("opencode: resumes with -s", () => {
    expect(adapterForRuntime("opencode")!.resumeCommand("opencode", "ses_x")).toBe("opencode -s ses_x");
  });

  it("antigravity: no mint, resumes by conversation id or cwd-scoped continue", () => {
    const a = adapterForRuntime("antigravity")!;
    expect(a.mintsId).toBe(false);
    expect(a.resumesWithoutId).toBe(true);
    expect(a.injectId("agy --model gemini-3-pro", "a1")).toBe("agy --model gemini-3-pro");
    expect(a.resumeCommand("agy", "conv-1")).toBe("agy --conversation conv-1");
    expect(a.resumeCommand("agy --model gemini-3-pro", "conv-1")).toBe("agy --model gemini-3-pro --conversation conv-1");
    expect(a.resumeCommand("agy", "")).toBe("agy --continue");
  });

  it("qwen: resumes the cwd's last session via --continue when no id, --resume <id> when known", () => {
    const a = adapterForRuntime("qwen")!;
    expect(a.mintsId).toBe(false);
    expect(a.resumesWithoutId).toBe(true);
    expect(a.resumeCommand("qwen", "")).toBe("qwen --continue");
    expect(a.resumeCommand("qwen", "q1")).toBe("qwen --resume q1");
  });

  it("continue: resume by flag, no mint, requires an id (not resumesWithoutId)", () => {
    const a = adapterForRuntime("continue")!;
    expect(a.resumeCommand("cn", "k1")).toBe("cn --resume k1");
    expect(a.resumesWithoutId).toBeFalsy();
  });

  it("hermes: capture resume via --resume / --continue, harness shape, no fork", () => {
    const a = adapterForRuntime("hermes")!;
    expect(a.mintsId).toBe(false);
    expect(a.resumesWithoutId).toBe(true);
    expect(a.injectId("hermes", "s1")).toBe("hermes");
    expect(a.resumeCommand("hermes", "20260713_185208_da5df2")).toBe("hermes --resume 20260713_185208_da5df2");
    expect(a.resumeCommand("hermes --tui", "")).toBe("hermes --tui --continue");
    expect(a.forkCommand).toBeUndefined();
    expect(a.harness?.configHomeEnv).toBe("HERMES_HOME");
    expect(a.harness?.mcp).toMatchObject({ mode: "home-config", fileName: "config.yaml" });
    expect(a.transcriptPath!("/ws/.tachyon/bridge-mcp/h.hermes", "/ws", "sid")).toBe(
      "/ws/.tachyon/bridge-mcp/h.hermes/state.db",
    );
  });

  it("capture runtimes have no deterministic transcript path (except hermes state.db locator)", () => {
    for (const rt of ["codex", "gemini", "antigravity", "opencode", "qwen", "continue", "pi"] as ResumeRuntime[]) {
      // gemini mints but its path is not derivable either
      if (rt === "claude" || rt === "grok" || rt === "hermes") continue;
      expect(adapterForRuntime(rt)!.transcriptPath).toBeUndefined();
    }
  });

  it("grok: deterministic chat_history path under GROK_HOME/sessions (t-9874be)", () => {
    const a = adapterForRuntime("grok")!;
    expect(a.mintsId).toBe(true);
    expect(a.transcriptPath!("/ws/.tachyon/bridge-mcp/agent.grok", "/home/goat/tachyon", "c1446c1e-57f6-4efa-95ca-7526a1880287"))
      .toBe("/ws/.tachyon/bridge-mcp/agent.grok/sessions/%2Fhome%2Fgoat%2Ftachyon/c1446c1e-57f6-4efa-95ca-7526a1880287/chat_history.jsonl");
    expect(a.transcriptPath!("/ws/.tachyon/harness/g/.grok", "/ws", "uuid-1"))
      .toBe(grokTranscriptPath("/ws/.tachyon/harness/g/.grok", "/ws", "uuid-1"));
  });
});

describe("encodeClaudeCwd", () => {
  it("collapses / and . to -", () => {
    expect(encodeClaudeCwd("/home/goat/Demo")).toBe("-home-goat-Demo");
    expect(encodeClaudeCwd("/a/b.c/d")).toBe("-a-b-c-d");
  });
});

describe("encodeGrokCwd / grokTranscriptPath (t-9874be)", () => {
  it("URL-encodes the cwd (slashes become %2F)", () => {
    expect(encodeGrokCwd("/home/goat/tachyon")).toBe("%2Fhome%2Fgoat%2Ftachyon");
    expect(encodeGrokCwd("/a/b.c/d")).toBe("%2Fa%2Fb.c%2Fd");
  });
});

describe("SessionLedger", () => {
  const dirs: string[] = [];
  const tmpWs = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ledger-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("is empty before anything is written", () => {
    expect(new SessionLedger(tmpWs()).all().size).toBe(0);
  });

  it("records, reads back, and overwrites by agent name", () => {
    const ws = tmpWs();
    const l = new SessionLedger(ws);
    l.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u1" }, cwd: ws, declared: true });
    expect(fs.existsSync(path.join(ws, ".tachyon", "sessions.json"))).toBe(true);
    expect(l.get("claude")).toMatchObject({ resume: { sessionId: "u1", runtime: "claude" }, declared: true });
    expect(typeof l.get("claude")!.updatedAt).toBe("string");

    l.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u2" }, cwd: ws, declared: true });
    expect(l.get("claude")!.resume!.sessionId).toBe("u2");
    expect(l.all().size).toBe(1);
  });

  it("removes a record", () => {
    const ws = tmpWs();
    const l = new SessionLedger(ws);
    l.record("a", { def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "c1" }, cwd: ws, declared: false });
    l.remove("a");
    expect(l.get("a")).toBeUndefined();
  });

  it("treats a corrupt or wrong-shape file as empty (never throws)", () => {
    const ws = tmpWs();
    const p = path.join(ws, ".tachyon");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "sessions.json"), "{ not json", "utf8");
    expect(new SessionLedger(ws).all().size).toBe(0);
    fs.writeFileSync(path.join(p, "sessions.json"), JSON.stringify({ sessions: [] }), "utf8");
    expect(new SessionLedger(ws).all().size).toBe(0);
  });

  it.each([
    [{ deliverable: "a committed patch" }, "deliverable"],
    [{ doneWhen: "the focused tests pass" }, "doneWhen"],
  ] as const)("restores a persisted contract with exactly one %s completion", (completion, expectedKey) => {
    const ws = tmpWs();
    const dir = path.join(ws, ".tachyon");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({
      sessions: {
        worker: {
          def: {
            cmd: "codex",
            kind: "agent",
            contract: { task: "implement fix", context: "persisted context", constraints: "stay scoped", ...completion },
          },
          cwd: ws,
          declared: false,
          updatedAt: "2026-07-19T00:00:00.000Z",
        },
      },
    }), "utf8");

    const def = new SessionLedger(ws).get("worker")?.def;
    expect(def?.contract).toMatchObject(completion);
    expect(def?.contractInvalid).toBeUndefined();
    expect(Object.hasOwn(def?.contract ?? {}, expectedKey)).toBe(true);
  });

  it.each([
    {},
    { deliverable: "a committed patch", doneWhen: "the focused tests pass" },
  ])("retains a content-free invalid marker for malformed persisted completion %#", (completion) => {
    const ws = tmpWs();
    const dir = path.join(ws, ".tachyon");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({
      sessions: {
        worker: {
          def: {
            cmd: "codex",
            kind: "agent",
            contract: {
              task: "SENSITIVE_TASK_BODY",
              context: "SENSITIVE_CONTEXT_BODY",
              constraints: "SENSITIVE_CONSTRAINTS_BODY",
              ...completion,
            },
          },
          cwd: ws,
          declared: false,
          updatedAt: "2026-07-19T00:00:00.000Z",
        },
      },
    }), "utf8");

    const def = new SessionLedger(ws).get("worker")?.def;
    expect(def?.contract).toBeUndefined();
    expect(def?.contractInvalid).toBe("invalid-shape");

    // Any later ledger write sanitizes away the malformed body but must preserve the fail-closed marker.
    const ledger = new SessionLedger(ws);
    ledger.record("other", { def: { cmd: "sh", kind: "terminal" }, cwd: ws, declared: false });
    const reparsed = new SessionLedger(ws).get("worker")?.def;
    expect(reparsed?.contract).toBeUndefined();
    expect(reparsed?.contractInvalid).toBe("invalid-shape");
    expect(fs.readFileSync(ledger.path, "utf8")).not.toContain("SENSITIVE_");
  });

  // spec 214 — verify-gate state persisted on the worktree block
  it("recordVerify updates the worktree's verify block and round-trips", () => {
    const ws = tmpWs();
    const l = new SessionLedger(ws);
    const worktree = { path: "/wt/rev", branch: "tachyon/rev", tachyonCreatedBranch: true, baseRef: "base", baseBranch: "develop", createdAt: "t0" };
    l.record("rev", { def: { cmd: "claude", kind: "agent" }, worktree, cwd: "/wt/rev", declared: true });
    l.recordVerify("rev", { command: "npm test", passed: true, atCommit: "abc123", ranAt: "2026-06-14T00:00:00Z" });

    const back = new SessionLedger(ws).get("rev");
    expect(back?.worktree?.verify).toEqual({ command: "npm test", passed: true, atCommit: "abc123", ranAt: "2026-06-14T00:00:00Z" });
    expect(back?.worktree?.branch).toBe("tachyon/rev"); // rest of the record untouched
    expect(back?.worktree?.baseBranch).toBe("develop"); // spec 223 — PR base persists across reload
  });

  it("recordVerify is a no-op for an agent with no worktree (verify is worktree-scoped)", () => {
    const ws = tmpWs();
    const l = new SessionLedger(ws);
    l.record("plain", { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: true });
    l.recordVerify("plain", { command: "npm test", passed: false, atCommit: "x", ranAt: "t" });
    expect(l.get("plain")?.worktree).toBeUndefined();
  });

  // spec 273 — the evidence channel persisted on the worktree block
  describe("evidence channel (spec 273)", () => {
    let evSeq = 0;
    const evi = (e: Partial<WorktreeEvidence> = {}): WorktreeEvidence => ({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      id: `e${evSeq++}`,
      targetAgent: "rev",
      producer: "claude",
      atCommit: "abc",
      producedAt: `2026-06-27T00:00:${String(evSeq).padStart(2, "0")}Z`,
      kind: "advisory",
      severity: "info",
      summary: "note",
      ...e,
    });
    const withWorktree = (l: SessionLedger, name = "rev") =>
      l.record(name, { def: { cmd: "claude", kind: "agent" }, worktree: { path: "/wt/rev", branch: "b", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t0" }, cwd: "/wt/rev", declared: true });

    it("appendEvidence persists + round-trips; getEvidence reads back", () => {
      const ws = tmpWs();
      const l = new SessionLedger(ws);
      withWorktree(l);
      l.appendEvidence("rev", evi({ id: "x", summary: "first", data: { exitCode: 0 }, artifacts: ["shot.png"] }));
      const back = new SessionLedger(ws).getEvidence("rev");
      expect(back).toHaveLength(1);
      expect(back[0]).toMatchObject({ id: "x", summary: "first", data: { exitCode: 0 }, artifacts: ["shot.png"] });
    });

    it("appendEvidence is a no-op without a worktree", () => {
      const ws = tmpWs();
      const l = new SessionLedger(ws);
      l.record("plain", { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: true });
      l.appendEvidence("plain", evi({ targetAgent: "plain" }));
      expect(l.getEvidence("plain")).toEqual([]);
    });

    it("synchronous appends never lose a write (no racy RMW)", () => {
      const ws = tmpWs();
      const l = new SessionLedger(ws);
      withWorktree(l);
      for (let i = 0; i < 5; i++) l.appendEvidence("rev", evi({ id: `a${i}` }));
      expect(new SessionLedger(ws).getEvidence("rev")).toHaveLength(5);
    });

    it("replaceVerifyEvidence swaps the verify step-set, preserves other evidence", () => {
      const ws = tmpWs();
      const l = new SessionLedger(ws);
      withWorktree(l);
      l.appendEvidence("rev", evi({ id: "judg", producer: "claude", kind: "judgment", summary: "looks right" }));
      l.replaceVerifyEvidence("rev", [evi({ id: "s1", producer: VERIFY_PRODUCER, kind: STEP_RESULT_KIND })]);
      l.replaceVerifyEvidence("rev", [evi({ id: "s2", producer: VERIFY_PRODUCER, kind: STEP_RESULT_KIND }), evi({ id: "s3", producer: VERIFY_PRODUCER, kind: STEP_RESULT_KIND })]);
      const back = new SessionLedger(ws).getEvidence("rev").map((r) => r.id);
      expect(back).toContain("judg"); // non-verify preserved
      expect(back).not.toContain("s1"); // first verify set replaced
      expect(back).toEqual(expect.arrayContaining(["s2", "s3"]));
    });

    it("drops a malformed evidence record on read (defensive parse), keeps valid ones", () => {
      const ws = tmpWs();
      const l = new SessionLedger(ws);
      withWorktree(l);
      l.appendEvidence("rev", evi({ id: "good" }));
      // hand-corrupt one record on disk (missing required 'summary')
      const p = path.join(ws, ".tachyon", "sessions.json");
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      raw.sessions.rev.worktree.evidence.push({ id: "bad", targetAgent: "rev", producer: "x", atCommit: "abc", producedAt: "t", kind: "advisory", severity: "info" });
      fs.writeFileSync(p, JSON.stringify(raw), "utf8");
      const back = new SessionLedger(ws).getEvidence("rev");
      expect(back.map((r) => r.id)).toEqual(["good"]); // bad dropped, good kept
    });
  });

  // SDD 368 T14 — durable Delivery reverse binding
  describe("Delivery reverse binding (SDD 368 T14)", () => {
    it("round-trips a valid binding and is idempotent on exact re-bind", () => {
      const ws = tmpWs();
      const l = new SessionLedger(ws);
      l.record("holder", {
        def: { cmd: "claude", kind: "agent" },
        resume: { runtime: "claude", sessionId: "s1" },
        cwd: "/wt/d",
        declared: false,
        bridgeClient: { boundGeneration: 2, wired: true },
      });
      const binding = { deliveryId: "d-1", segmentId: "seg-1", executionNonce: "nonce-1" };
      l.bindDelivery("holder", binding);
      expect(l.get("holder")?.delivery).toEqual(binding);
      l.bindDelivery("holder", binding); // idempotent
      const back = new SessionLedger(ws).get("holder");
      expect(back?.delivery).toEqual(binding);
      // preserves def/resume/cwd/declared/bridge
      expect(back).toMatchObject({
        def: { cmd: "claude", kind: "agent" },
        resume: { runtime: "claude", sessionId: "s1" },
        cwd: "/wt/d",
        declared: false,
        bridgeClient: { boundGeneration: 2, wired: true },
      });
      expect(isValidDeliveryBinding(back?.delivery)).toBe(true);
      expect(hasDeliveryMarker(back)).toBe(true);
    });

    it("refuses conflicting bind and refuses overwrite of an invalid marker", () => {
      const ws = tmpWs();
      const l = new SessionLedger(ws);
      l.record("holder", { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: false });
      l.bindDelivery("holder", { deliveryId: "d-1", segmentId: "seg-1", executionNonce: "n1" });
      expect(() => l.bindDelivery("holder", { deliveryId: "d-2", segmentId: "seg-1", executionNonce: "n1" }))
        .toThrow(/existing binding differs/);
      // hand-corrupt to invalid sentinel
      const p = path.join(ws, ".tachyon", "sessions.json");
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      raw.sessions.holder.delivery = { deliveryId: "", segmentId: "x" };
      fs.writeFileSync(p, JSON.stringify(raw), "utf8");
      const re = new SessionLedger(ws);
      expect(isInvalidDeliveryMarker(re.get("holder")?.delivery)).toBe(true);
      expect(() => re.bindDelivery("holder", { deliveryId: "d-1", segmentId: "seg-1" }))
        .toThrow(/invalid/);
    });

    it("clear requires the exact expected binding (no name-only clear)", () => {
      const ws = tmpWs();
      const l = new SessionLedger(ws);
      l.record("holder", { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: false });
      l.bindDelivery("holder", { deliveryId: "d-1", segmentId: "seg-1", executionNonce: "n1" });
      expect(() => l.clearDelivery("holder", { deliveryId: "d-1", segmentId: "seg-OTHER", executionNonce: "n1" }))
        .toThrow(/does not match/);
      expect(l.get("holder")?.delivery).toEqual({ deliveryId: "d-1", segmentId: "seg-1", executionNonce: "n1" });
      l.clearDelivery("holder", { deliveryId: "d-1", segmentId: "seg-1", executionNonce: "n1" });
      expect(l.get("holder")?.delivery).toBeUndefined();
    });

    it("malformed persisted marker survives as invalid sentinel alongside resume fields", () => {
      const ws = tmpWs();
      const p = path.join(ws, ".tachyon");
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, "sessions.json"), JSON.stringify({
        sessions: {
          holder: {
            def: { cmd: "claude", kind: "agent" },
            resume: { runtime: "claude", sessionId: "s" },
            cwd: "/wt",
            declared: false,
            delivery: { deliveryId: 99 }, // malformed
            updatedAt: "t",
          },
        },
      }), "utf8");
      const rec = new SessionLedger(ws).get("holder");
      expect(rec?.resume?.sessionId).toBe("s");
      expect(isInvalidDeliveryMarker(rec?.delivery)).toBe(true);
      expect(hasDeliveryMarker(rec)).toBe(true);
    });
  });
});

describe("planResume", () => {
  const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    def: { cmd: "claude", kind: "agent" },
    resume: { runtime: "claude", sessionId: "id" },
    cwd: "/ws",
    declared: true,
    updatedAt: "t",
    ...over,
  });

  it("reattaches a live session, auto-resumes a dead declared-autostart, offers the rest", () => {
    const ledger = new Map<string, SessionRecord>([
      ["alive", rec()],
      ["deadDeclared", rec()],
      ["deadAdhoc", rec({ declared: false })],
      ["deadDeclaredNoAutostart", rec()],
    ]);
    const plan = planResume({
      ledger,
      declaredAutostart: new Set(["alive", "deadDeclared"]),
      liveSessions: new Set(["alive"]),
    });
    const byName = Object.fromEntries(plan.map((p) => [p.name, p.action]));
    expect(byName).toEqual({
      alive: "reattach",
      deadDeclared: "auto-resume",
      deadAdhoc: "offer",
      deadDeclaredNoAutostart: "offer",
    });
    expect(autoResumes(plan).map((p) => p.name)).toEqual(["deadDeclared"]);
    expect(offers(plan).map((p) => p.name).sort()).toEqual(["deadAdhoc", "deadDeclaredNoAutostart"]);
  });

  it("is empty when the ledger is empty", () => {
    expect(planResume({ ledger: new Map(), declaredAutostart: new Set(), liveSessions: new Set() })).toEqual([]);
  });

  it("SDD 368 T14 excludes valid and invalid Delivery-bound rows from auto-resume and offer", () => {
    const ledger = new Map<string, SessionRecord>([
      ["boundLive", rec({ delivery: { deliveryId: "d-1", segmentId: "seg-1", executionNonce: "n" } })],
      ["boundDead", rec({ delivery: { deliveryId: "d-1", segmentId: "seg-1", executionNonce: "n" } })],
      ["invalidBound", rec({ delivery: { invalid: true } })],
      ["ordinary", rec()],
    ]);
    const plan = planResume({
      ledger,
      declaredAutostart: new Set(["boundDead", "ordinary", "invalidBound"]),
      liveSessions: new Set(["boundLive"]),
    });
    const byName = Object.fromEntries(plan.map((p) => [p.name, p.action]));
    // Delivery markers excluded entirely (even live ones are not reattach via generic plan —
    // rehydrate still surfaces them; live tmux is discovered separately).
    expect(byName).toEqual({ ordinary: "auto-resume" });
    expect(autoResumes(plan).map((p) => p.name)).toEqual(["ordinary"]);
    expect(offers(plan)).toEqual([]);
  });

  it("SDD 368 T14 excludes marker-less snapshot-denied agents (crash window)", () => {
    const ledger = new Map<string, SessionRecord>([
      ["crash-holder", rec()], // no delivery marker
      ["ordinary", rec()],
    ]);
    const plan = planResume({
      ledger,
      declaredAutostart: new Set(["crash-holder", "ordinary"]),
      liveSessions: new Set(),
      deliveryUnavailableAgents: new Set(["crash-holder"]),
    });
    expect(plan.map((p) => p.name)).toEqual(["ordinary"]);
    expect(autoResumes(plan).map((p) => p.name)).toEqual(["ordinary"]);
  });

  it("SDD 368 T14/R3 denies every generic plan action when reload snapshot is not ready", () => {
    const ledger = new Map<string, SessionRecord>([
      ["ordinary", rec()],
      ["offered", { ...rec(), declared: false }],
      ["live", rec()],
    ]);
    const plan = planResume({
      ledger,
      declaredAutostart: new Set(["ordinary"]),
      liveSessions: new Set(["live"]),
      deliveryReloadSnapshotReady: false,
    });
    expect(plan).toEqual([]);
    expect(autoResumes(plan)).toEqual([]);
    expect(offers(plan)).toEqual([]);
  });
});

describe("capture-id resolvers (spec 209 task 6)", () => {
  const homes: string[] = [];
  const tmpHome = (): string => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-home-"));
    homes.push(h);
    return h;
  };
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  it("resolveCodexId matches a rollout by session_meta.cwd, newest first", () => {
    const home = tmpHome();
    const dir = path.join(home, ".codex", "sessions", "2026", "06", "11");
    fs.mkdirSync(dir, { recursive: true });
    const write = (file: string, id: string, cwd: string) =>
      fs.writeFileSync(
        path.join(dir, file),
        JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n" + '{"type":"turn"}\n',
        "utf8",
      );
    write("rollout-2026-06-11T10-00-00-aaaa.jsonl", "aaaa", "/ws/other");
    write("rollout-2026-06-11T11-00-00-bbbb.jsonl", "bbbb", "/ws/proj");
    expect(resolveCodexId("/ws/proj", { home })).toBe("bbbb");
    expect(resolveCodexId("/ws/none", { home })).toBeNull();
  });

  it("spec 305: resolveCodexSession returns the rollout path and can require a stored id", () => {
    const home = tmpHome();
    const dir = path.join(home, ".codex", "sessions", "2026", "06", "30");
    fs.mkdirSync(dir, { recursive: true });
    const oldFile = path.join(dir, "rollout-2026-06-30T10-00-00-old.jsonl");
    const newFile = path.join(dir, "rollout-2026-06-30T11-00-00-new.jsonl");
    fs.writeFileSync(oldFile, JSON.stringify({ type: "session_meta", payload: { id: "old", cwd: "/ws/proj" } }) + "\n", "utf8");
    fs.writeFileSync(newFile, JSON.stringify({ type: "session_meta", payload: { id: "new", cwd: "/ws/proj" } }) + "\n", "utf8");
    fs.utimesSync(oldFile, new Date("2026-06-30T10:00:00Z"), new Date("2026-06-30T10:00:00Z"));
    fs.utimesSync(newFile, new Date("2026-06-30T11:00:00Z"), new Date("2026-06-30T11:00:00Z"));

    expect(resolveCodexSession("/ws/proj", { home })).toEqual({ id: "new", path: newFile });
    expect(resolveCodexSession("/ws/proj", { home }, "old")).toEqual({ id: "old", path: oldFile });
    expect(resolveCodexSession("/ws/proj", { home }, "missing")).toBeNull();
  });

  it("spec 298: resolveCodexId honors a redirected codexHome", () => {
    const home = tmpHome();
    const codexHome = path.join(home, "private-codex");
    const dir = path.join(codexHome, "sessions", "2026", "06", "30");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rollout-2026-06-30T10-00-00-private.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "private", cwd: "/ws/proj" } }) + "\n",
      "utf8",
    );
    expect(resolveCodexId("/ws/proj", { home, codexHome })).toBe("private");
    expect(resolveCodexId("/ws/proj", { home })).toBeNull();
  });

  it("resolveCodexId returns null when no codex dir / no match", () => {
    expect(resolveCodexId("/ws", { home: tmpHome() })).toBeNull();
  });

  it("resolveHermesId reads newest session for cwd from state.db", () => {
    const home = tmpHome();
    const hermesHome = path.join(home, ".hermes");
    fs.mkdirSync(hermesHome, { recursive: true });
    const dbPath = path.join(hermesHome, "state.db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        started_at REAL,
        ended_at REAL
      );
    `);
    db.prepare("INSERT INTO sessions (id, cwd, started_at, ended_at) VALUES (?, ?, ?, ?)").run(
      "20260713_old",
      "/ws/proj",
      1000,
      null,
    );
    db.prepare("INSERT INTO sessions (id, cwd, started_at, ended_at) VALUES (?, ?, ?, ?)").run(
      "20260713_new",
      "/ws/proj",
      2000,
      null,
    );
    db.prepare("INSERT INTO sessions (id, cwd, started_at, ended_at) VALUES (?, ?, ?, ?)").run(
      "other",
      "/ws/other",
      3000,
      null,
    );
    db.close();
    expect(resolveHermesId("/ws/proj", { home })).toBe("20260713_new");
    expect(resolveHermesId("/ws/other", { home })).toBe("other");
    expect(resolveHermesId("/ws/proj", { home }, "20260713_old")).toBe("20260713_old");
    expect(resolveHermesId("/ws/none", { home })).toBeNull();
    expect(resolveHermesId("/ws/proj", { home: tmpHome() })).toBeNull();
  });

  it("resolveHermesId prefers the active session with the most recent persisted message", () => {
    const home = tmpHome();
    const hermesHome = path.join(home, ".hermes");
    fs.mkdirSync(hermesHome, { recursive: true });
    const dbPath = path.join(hermesHome, "state.db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, ended_at REAL);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        content TEXT,
        active INTEGER DEFAULT 1
      );
    `);
    const addSession = db.prepare("INSERT INTO sessions (id, cwd, started_at, ended_at) VALUES (?, ?, ?, ?)");
    addSession.run("resumed-old", "/ws/proj", 1000, null);
    addSession.run("newer-active", "/ws/proj", 2000, null);
    addSession.run("newest-closed", "/ws/proj", 3000, 4000);
    const addMessage = db.prepare("INSERT INTO messages (session_id, content) VALUES (?, ?)");
    addMessage.run("newer-active", "earlier activity");
    addMessage.run("resumed-old", "latest activity after /resume");
    addMessage.run("newest-closed", "closed session activity");
    db.close();

    expect(resolveHermesId("/ws/proj", { home })).toBe("resumed-old");
  });

  it("resolveOpencodeId maps worktree->hash then picks the newest ses_*", () => {
    const home = tmpHome();
    const storage = path.join(home, ".local", "share", "opencode", "storage");
    fs.mkdirSync(path.join(storage, "project"), { recursive: true });
    fs.writeFileSync(
      path.join(storage, "project", "h1.json"),
      JSON.stringify({ id: "h1", worktree: "/ws/proj" }),
      "utf8",
    );
    const sdir = path.join(storage, "session", "h1");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "ses_old.json"), "{}", "utf8");
    fs.writeFileSync(path.join(sdir, "ses_new.json"), "{}", "utf8");
    // make ses_new newer
    const future = Date.now() / 1000 + 100;
    fs.utimesSync(path.join(sdir, "ses_new.json"), future, future);
    expect(resolveOpencodeId("/ws/proj", { home })).toBe("ses_new");
    expect(resolveOpencodeId("/ws/absent", { home })).toBeNull();
  });

  it("resolveClaudeId picks the newest transcript for a cwd (spec 212 / A3)", () => {
    const home = tmpHome();
    const dir = path.join(home, ".claude", "projects", "-ws-proj"); // encodeClaudeCwd('/ws/proj')
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old-session.jsonl"), "{}", "utf8");
    fs.writeFileSync(path.join(dir, "new-session.jsonl"), "{}", "utf8");
    const future = Date.now() / 1000 + 100;
    fs.utimesSync(path.join(dir, "new-session.jsonl"), future, future);
    expect(resolveClaudeId("/ws/proj", { home })).toBe("new-session");
    expect(resolveClaudeId("/ws/absent", { home })).toBeNull();
  });

  it("resolveClaudeIdByTitle maps a unique customTitle → real uuid, newest wins, even on a shared cwd (spec 220)", () => {
    const home = tmpHome();
    const dir = path.join(home, ".claude", "projects", "-ws-proj"); // encodeClaudeCwd('/ws/proj')
    fs.mkdirSync(dir, { recursive: true });
    // two agents share this cwd; each transcript is named by claude's own uuid with its title in the header
    fs.writeFileSync(path.join(dir, "uuid-A.jsonl"), JSON.stringify({ customTitle: "tachyon-proj-claude", sessionId: "uuid-A", type: "summary" }) + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "uuid-B.jsonl"), JSON.stringify({ customTitle: "tachyon-proj-claude2", sessionId: "uuid-B", type: "summary" }) + "\n", "utf8");
    // a SECOND session with the same title (e.g. a repeated ▶-fresh) — newest must win
    fs.writeFileSync(path.join(dir, "uuid-A2.jsonl"), JSON.stringify({ customTitle: "tachyon-proj-claude", sessionId: "uuid-A2", type: "summary" }) + "\n", "utf8");
    const future = Date.now() / 1000 + 100;
    fs.utimesSync(path.join(dir, "uuid-A2.jsonl"), future, future);
    expect(resolveClaudeIdByTitle("/ws/proj", "tachyon-proj-claude", { home })).toBe("uuid-A2"); // newest of the title
    expect(resolveClaudeIdByTitle("/ws/proj", "tachyon-proj-claude2", { home })).toBe("uuid-B"); // sibling, unambiguous
    expect(resolveClaudeIdByTitle("/ws/proj", "no-such-title", { home })).toBeNull();
  });

  it("resolveClaudeIdByTitle reads only the header of a HUGE transcript (no whole-file load — leak fix)", () => {
    const home = tmpHome();
    const dir = path.join(home, ".claude", "projects", "-ws-big");
    fs.mkdirSync(dir, { recursive: true });
    // header line 1, then a multi-MB body (a real transcript can be hundreds of MB). The resolver must
    // match the header without loading the body (the spec-221 regression read the whole file per scan).
    const header = JSON.stringify({ customTitle: "tachyon-big-claude", sessionId: "uuid-BIG", type: "summary" });
    const body = "\n" + "x".repeat(4 * 1024 * 1024); // 4 MiB after the first newline
    fs.writeFileSync(path.join(dir, "uuid-BIG.jsonl"), header + body, "utf8");
    expect(resolveClaudeIdByTitle("/ws/big", "tachyon-big-claude", { home })).toBe("uuid-BIG");
  });

  it("resolveClaudeIdByTitle finds the customTitle when it's NOT line 0 (claude 2.1.178 header preamble — dogfood 2026-06-16)", () => {
    const home = tmpHome();
    const dir = path.join(home, ".claude", "projects", "-ws-pre");
    fs.mkdirSync(dir, { recursive: true });
    // claude writes a metadata preamble in no fixed order; the custom-title record can be line 1+, after
    // last-prompt/agent-name. Reading only line 0 missed it → "not forkable yet" / failed resume-by-title.
    const lines = [
      JSON.stringify({ type: "last-prompt", leafUuid: "leaf-1", sessionId: "uuid-PRE" }),
      JSON.stringify({ type: "custom-title", customTitle: "tachyon-pre-claude", sessionId: "uuid-PRE" }),
      JSON.stringify({ type: "agent-name", agentName: "x", sessionId: "uuid-PRE" }),
    ];
    fs.writeFileSync(path.join(dir, "uuid-PRE.jsonl"), lines.join("\n") + "\n", "utf8");
    expect(resolveClaudeIdByTitle("/ws/pre", "tachyon-pre-claude", { home })).toBe("uuid-PRE");
  });

  it("resolveAntigravityId reads the cwd's last conversation cache and fails closed", () => {
    const home = tmpHome();
    const cache = path.join(home, ".gemini", "antigravity-cli", "cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "last_conversations.json"), JSON.stringify({ "/ws/a": "conv-a", "/ws/empty": "" }), "utf8");
    expect(resolveAntigravityId("/ws/a", { home })).toBe("conv-a");
    expect(resolveAntigravityId("/ws/missing", { home })).toBeNull();
    expect(resolveAntigravityId("/ws/empty", { home })).toBeNull();
    fs.writeFileSync(path.join(cache, "last_conversations.json"), "{", "utf8");
    expect(resolveAntigravityId("/ws/a", { home })).toBeNull();
  });

  it("resolveCurrentSession: claude→by-title when given (else newest); antigravity→cache; gemini/qwen/continue→null", async () => {
    const home = tmpHome();
    const dir = path.join(home, ".claude", "projects", "-ws-p");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sess-x.jsonl"), JSON.stringify({ customTitle: "tachyon-p-claude", sessionId: "real-uuid" }) + "\n", "utf8");
    const agyCache = path.join(home, ".gemini", "antigravity-cli", "cache");
    fs.mkdirSync(agyCache, { recursive: true });
    fs.writeFileSync(path.join(agyCache, "last_conversations.json"), JSON.stringify({ "/ws/p": "agy-p" }), "utf8");
    expect(await resolveCurrentSession("claude", "/ws/p", { home })).toBe("sess-x"); // no title → newest-by-cwd (legacy)
    expect(await resolveCurrentSession("claude", "/ws/p", { home }, "tachyon-p-claude")).toBe("real-uuid"); // title → exact uuid
    expect(await resolveCurrentSession("antigravity", "/ws/p", { home })).toBe("agy-p");
    expect(await resolveCurrentSession("gemini", "/ws/p", { home })).toBeNull();
    expect(await resolveCurrentSession("qwen", "/ws/p", { home })).toBeNull();
    expect(await resolveCurrentSession("continue", "/ws/p", { home })).toBeNull();
  });

  it("resolveCaptureId dispatches by runtime and returns null for unsupported", async () => {
    const home = tmpHome();
    const agyCache = path.join(home, ".gemini", "antigravity-cli", "cache");
    fs.mkdirSync(agyCache, { recursive: true });
    fs.writeFileSync(path.join(agyCache, "last_conversations.json"), JSON.stringify({ "/ws": "agy-ws" }), "utf8");
    expect(await resolveCaptureId("antigravity", "/ws", { home })).toBe("agy-ws");
    expect(await resolveCaptureId("qwen", "/ws", { home })).toBeNull();
    expect(await resolveCaptureId("continue", "/ws", { home })).toBeNull();
  });

  it("spec 305: resolveCaptureSession dispatches Codex to a path-returning resolver", async () => {
    const home = tmpHome();
    const dir = path.join(home, ".codex", "sessions", "2026", "06", "30");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout-2026-06-30T10-00-00-codex.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "codex", cwd: "/ws" } }) + "\n", "utf8");
    await expect(resolveCaptureSession("codex", "/ws", { home }, "codex")).resolves.toEqual({ id: "codex", path: file });
    await expect(resolveCaptureSession("opencode", "/ws", { home })).resolves.toBeNull();
  });
});

describe("isResumable + def-only rows are never offered (spec 211)", () => {
  it("isResumable: true for an adapter-backed runtime (even with empty id), false for def-only", () => {
    const base = { cwd: "/ws", declared: false, updatedAt: "t" };
    expect(isResumable({ ...base, def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "x" } })).toBe(true);
    expect(isResumable({ ...base, def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "" } })).toBe(true);
    expect(isResumable({ ...base, def: { cmd: "sh", kind: "terminal" } })).toBe(false); // def-only, no resume block
  });

  it("planResume never auto-resumes/offers a def-only (sh) row", () => {
    const recs = new Map<string, SessionRecord>([
      ["ai", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "1" }, cwd: "/ws", declared: false, updatedAt: "t" }],
      ["sh", { def: { cmd: "sh", kind: "terminal" }, cwd: "/ws", declared: false, updatedAt: "t" }],
    ]);
    const plan = planResume({ ledger: recs, declaredAutostart: new Set(), liveSessions: new Set() });
    expect(offers(plan).map((p) => p.name)).toEqual(["ai"]); // sh row excluded
  });
});
