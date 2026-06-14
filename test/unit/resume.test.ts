import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runtimeOf,
  binaryOf,
  adapterFor,
  adapterForRuntime,
  managesOwnSession,
  encodeClaudeCwd,
  type ResumeRuntime,
} from "../../src/resume/adapters.js";
import { SessionLedger, isResumable, type SessionRecord } from "../../src/resume/SessionLedger.js";
import { planResume, autoResumes, offers } from "../../src/resume/planResume.js";
import { resolveCodexId, resolveOpencodeId, resolveCaptureId, resolveClaudeId, resolveCurrentSession } from "../../src/resume/resolvers.js";

describe("runtimeOf / binaryOf", () => {
  it("detects each supported runtime by binary", () => {
    expect(runtimeOf("claude")).toBe("claude");
    expect(runtimeOf("codex --model o3")).toBe("codex");
    expect(runtimeOf("gemini -y")).toBe("gemini");
    expect(runtimeOf("opencode")).toBe("opencode");
    expect(runtimeOf("qwen")).toBe("qwen");
    expect(runtimeOf("cn")).toBe("continue");
  });

  it("sees through launchers and env assignments", () => {
    expect(binaryOf("npx claude")).toBe("claude");
    expect(binaryOf("env FOO=1 codex")).toBe("codex");
    expect(binaryOf("/usr/local/bin/claude --permission-mode plan")).toBe("claude");
  });

  it("returns null for non-agent / unknown commands", () => {
    expect(runtimeOf("npm run dev")).toBeNull();
    expect(runtimeOf("bash")).toBeNull();
    expect(runtimeOf("aider")).toBeNull(); // no real resume -> not adapted
  });
});

describe("ResumeAdapter — mint runtimes (claude, gemini)", () => {
  it("claude: injects --session-id at spawn and --resume on resume, preserving flags", () => {
    const a = adapterFor("claude --permission-mode plan")!;
    expect(a.mintsId).toBe(true);
    expect(a.injectId("claude --permission-mode plan", "uuid-1")).toBe(
      "claude --permission-mode plan --session-id uuid-1",
    );
    expect(a.resumeCommand("claude --permission-mode plan", "uuid-1")).toBe(
      "claude --permission-mode plan --resume uuid-1",
    );
  });

  it("gemini: mints + resumes by flag", () => {
    const a = adapterForRuntime("gemini")!;
    expect(a.mintsId).toBe(true);
    expect(a.injectId("gemini", "g1")).toBe("gemini --session-id g1");
    expect(a.resumeCommand("gemini", "g1")).toBe("gemini --resume g1");
  });

  it("claude: a self-resuming cmd (--resume/--continue) is run VERBATIM — no --session-id/--resume layered (else exit 1)", () => {
    const a = adapterForRuntime("claude")!;
    // user already manages the session — injecting our flags would conflict
    expect(a.injectId("claude --resume tachyon", "uuid-1")).toBe("claude --resume tachyon");
    expect(a.resumeCommand("claude --resume tachyon", "uuid-1")).toBe("claude --resume tachyon");
    expect(a.injectId("claude --continue", "uuid-1")).toBe("claude --continue");
    expect(a.injectId("claude -r abc", "uuid-1")).toBe("claude -r abc");
    // a plain claude cmd still mints normally
    expect(a.injectId("claude", "uuid-1")).toBe("claude --session-id uuid-1");
  });

  it("managesOwnSession detects session flags by exact token (not substring)", () => {
    expect(managesOwnSession("claude --resume x")).toBe(true);
    expect(managesOwnSession("claude --continue")).toBe(true);
    expect(managesOwnSession("claude -c")).toBe(true);
    expect(managesOwnSession("claude --session-id u")).toBe(true);
    expect(managesOwnSession("claude --permission-mode plan")).toBe(false);
    expect(managesOwnSession("claude --resumexyz")).toBe(false); // not a real flag
  });

  it("claude transcript path uses the cwd-encoding", () => {
    const a = adapterForRuntime("claude")!;
    expect(a.transcriptPath!("/home/me", "/home/me/proj.api", "u1")).toBe(
      "/home/me/.claude/projects/-home-me-proj-api/u1.jsonl",
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

  it("capture runtimes have no deterministic transcript path", () => {
    for (const rt of ["codex", "gemini", "opencode", "qwen", "continue"] as ResumeRuntime[]) {
      // gemini mints but its path is not derivable either
      if (rt === "claude") continue;
      expect(adapterForRuntime(rt)!.transcriptPath).toBeUndefined();
    }
  });
});

describe("encodeClaudeCwd", () => {
  it("collapses / and . to -", () => {
    expect(encodeClaudeCwd("/home/goat/Agent0")).toBe("-home-goat-Agent0");
    expect(encodeClaudeCwd("/a/b.c/d")).toBe("-a-b-c-d");
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

  it("resolveCodexId returns null when no codex dir / no match", () => {
    expect(resolveCodexId("/ws", { home: tmpHome() })).toBeNull();
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

  it("resolveCurrentSession: claude→newest transcript; gemini/qwen/continue→null (no wrong guess)", async () => {
    const home = tmpHome();
    const dir = path.join(home, ".claude", "projects", "-ws-p");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sess-x.jsonl"), "{}", "utf8");
    expect(await resolveCurrentSession("claude", "/ws/p", { home })).toBe("sess-x");
    expect(await resolveCurrentSession("gemini", "/ws/p", { home })).toBeNull();
    expect(await resolveCurrentSession("qwen", "/ws/p", { home })).toBeNull();
    expect(await resolveCurrentSession("continue", "/ws/p", { home })).toBeNull();
  });

  it("resolveCaptureId dispatches by runtime and returns null for unsupported", async () => {
    const home = tmpHome();
    expect(await resolveCaptureId("qwen", "/ws", { home })).toBeNull();
    expect(await resolveCaptureId("continue", "/ws", { home })).toBeNull();
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
