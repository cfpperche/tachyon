import { describe, expect, it } from "vitest";
import { buildEnvironmentCheck } from "@tachyon/engine/onboarding/environmentCheck.js";
import { ATTESTED_RUNTIMES } from "@tachyon/shared/runtime/attestedRuntimes.js";
import type { DoctorResult } from "@tachyon/engine/tmux/TmuxService.js";

/**
 * t-505f13 — the pure environment projection. The DONE_WHEN the card names is here at the unit
 * layer: "a checagem afirma o que FALTA, nao so o que existe" — with a requirement absent, the
 * projection must NAME it and say what to do, which today is a comment inside a generated yml.
 */

const tmuxOk: DoctorResult = { ok: true, version: "tmux 3.4" };
const nodeOk = { ok: true as const, source: "/usr/bin/node" };

describe("buildEnvironmentCheck", () => {
  it("a missing agent CLI is NAMED, with a remedy that lists every attested runtime", () => {
    const check = buildEnvironmentCheck({ tmux: tmuxOk, node: nodeOk, clis: ["make", "git"] });
    const cli = check.items.find((i) => i.id === "agent-cli")!;
    expect(cli.status).toBe("missing");
    // Not "install claude" — the user with a grok login must not be told to install claude.
    for (const runtime of ATTESTED_RUNTIMES) expect(cli.remedy).toContain(runtime);
    expect(check.ready).toBe(false);
  });

  it("an attested CLI on PATH makes the row ok even when unattested AI CLIs are present", () => {
    const check = buildEnvironmentCheck({ tmux: tmuxOk, node: nodeOk, clis: ["gemini", "grok"] });
    const cli = check.items.find((i) => i.id === "agent-cli")!;
    expect(cli.status).toBe("ok");
    expect(cli.detail).toContain("grok");
    expect(cli.detail).not.toContain("gemini");
    expect(check.ready).toBe(true);
  });

  it("reuses doctor()'s install hint verbatim as the tmux remedy", () => {
    const message = "Tachyon requires tmux, which was not found on PATH. Install it with your package manager, e.g.: sudo apt install tmux";
    const check = buildEnvironmentCheck({ tmux: { ok: false, reason: "tmux-missing", message }, node: nodeOk, clis: ["claude"] });
    const tmux = check.items.find((i) => i.id === "tmux")!;
    expect(tmux.status).toBe("missing");
    expect(tmux.remedy).toBe(message);
    expect(check.ready).toBe(false);
  });

  it("a missing Node reports the engine's own refusal message", () => {
    const message = "the local Electron Extension Host requires a real Node executable on PATH.";
    const check = buildEnvironmentCheck({
      tmux: tmuxOk,
      node: { ok: false, message },
      clis: ["claude"],
    });
    const node = check.items.find((i) => i.id === "node")!;
    expect(node.status).toBe("missing");
    expect(node.remedy).toBe(message);
    expect(check.ready).toBe(false);
  });

  it("credentials are an honest 'info' before any workspace exists — never a fake pass or fail", () => {
    const check = buildEnvironmentCheck({ tmux: tmuxOk, node: nodeOk, clis: ["claude"] });
    const credential = check.items.find((i) => i.id === "credential")!;
    expect(credential.status).toBe("info");
    // The gate excludes credentials on purpose: not checkable yet must not block bootstrap.
    expect(check.ready).toBe(true);
  });

  it("a declared-but-missing credential is named per agent with a remedy pointing at Keys", () => {
    const check = buildEnvironmentCheck({
      tmux: tmuxOk,
      node: nodeOk,
      clis: ["claude"],
      credentials: {
        storedCount: 1,
        missing: [{ agent: "reviewer", name: "coding", provider: "zai", id: "glm-5.3" }],
      },
    });
    const credential = check.items.find((i) => i.id === "credential")!;
    expect(credential.status).toBe("missing");
    expect(credential.detail).toContain("zai/glm-5.3");
    expect(credential.detail).toContain("reviewer");
    expect(credential.remedy).toContain("Keys");
  });

  it("a healthy machine with stored credentials is ready with every required row ok", () => {
    const check = buildEnvironmentCheck({
      tmux: tmuxOk,
      node: nodeOk,
      clis: ["claude", "codex"],
      credentials: { storedCount: 2, missing: [] },
    });
    expect(check.ready).toBe(true);
    expect(check.items.filter((i) => i.status === "missing")).toEqual([]);
  });
});
