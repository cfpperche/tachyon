import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runtimeOf,
  binaryOf,
  adapterFor,
  adapterForRuntime,
  encodeClaudeCwd,
  type ResumeRuntime,
} from "../../src/resume/adapters.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";

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

  it("qwen / continue: resume by flag, no mint", () => {
    expect(adapterForRuntime("qwen")!.resumeCommand("qwen", "q1")).toBe("qwen --resume q1");
    expect(adapterForRuntime("continue")!.resumeCommand("cn", "k1")).toBe("cn --resume k1");
    expect(adapterForRuntime("codex")!.mintsId).toBe(false);
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
    l.record("claude", { runtime: "claude", sessionId: "u1", cwd: ws, cmd: "claude", declared: true });
    expect(fs.existsSync(path.join(ws, ".tachyon", "sessions.json"))).toBe(true);
    expect(l.get("claude")).toMatchObject({ sessionId: "u1", declared: true, runtime: "claude" });
    expect(typeof l.get("claude")!.updatedAt).toBe("string");

    l.record("claude", { runtime: "claude", sessionId: "u2", cwd: ws, cmd: "claude", declared: true });
    expect(l.get("claude")!.sessionId).toBe("u2");
    expect(l.all().size).toBe(1);
  });

  it("removes a record", () => {
    const ws = tmpWs();
    const l = new SessionLedger(ws);
    l.record("a", { runtime: "codex", sessionId: "c1", cwd: ws, cmd: "codex", declared: false });
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
