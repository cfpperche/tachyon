import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { engineWorkspaceKey, engineSystemdUnitName } from "../../src/engine-service/engineSupervisor.js";
import { TMUX_SOCKET_ENV, resolveSocketName, DEFAULT_SOCKET_NAME } from "../../src/tmux/TmuxService.js";

/**
 * t-05097f — an engine that runs against an isolated tmux server must BE a different engine.
 *
 * Every durable handle hangs off `engineWorkspaceKey`: control socket, state dir, systemd unit.
 * Isolating only the unit name did nothing, because `ensure` finds a healthy engine by control
 * socket and attaches before the unit name is ever consulted — measured across a whole gate run,
 * where no isolated unit existed at any instant while the shared one kept serving.
 */
describe("t-05097f engine identity carries tmux isolation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-identity-"));

  it("is byte-identical to today's key when no override is set", () => {
    const withoutEnv = engineWorkspaceKey(root, {});
    const withUnrelatedEnv = engineWorkspaceKey(root, { HOME: "/somewhere" });

    expect(withoutEnv).toBe(withUnrelatedEnv);
    expect(withoutEnv).toMatch(/^[0-9a-f]{32}$/);
    expect(engineSystemdUnitName(root, {})).toBe(`tachyon-engine-${withoutEnv}.service`);
  });

  it("changes identity when a tmux socket override is present", () => {
    const production = engineWorkspaceKey(root, {});
    const isolated = engineWorkspaceKey(root, { [TMUX_SOCKET_ENV]: "tachyon-gate-1" });

    expect(isolated).not.toBe(production);
    expect(engineSystemdUnitName(root, { [TMUX_SOCKET_ENV]: "tachyon-gate-1" }))
      .toBe(`tachyon-engine-${isolated}.service`);
  });

  it("is deterministic per socket and distinct between sockets", () => {
    const a1 = engineWorkspaceKey(root, { [TMUX_SOCKET_ENV]: "gate-a" });
    const a2 = engineWorkspaceKey(root, { [TMUX_SOCKET_ENV]: "gate-a" });
    const b = engineWorkspaceKey(root, { [TMUX_SOCKET_ENV]: "gate-b" });

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("keeps the unit name a legal unit name whatever the override contains", () => {
    const hostile = engineSystemdUnitName(root, { [TMUX_SOCKET_ENV]: "../../etc/passwd nasty name" });

    expect(hostile).toMatch(/^tachyon-engine-[0-9a-f]{32}\.service$/);
  });

  it("treats a blank override as no override, so a stray empty env cannot fork production", () => {
    expect(engineWorkspaceKey(root, { [TMUX_SOCKET_ENV]: "   " })).toBe(engineWorkspaceKey(root, {}));
    expect(resolveSocketName({ [TMUX_SOCKET_ENV]: "   " })).toBe(DEFAULT_SOCKET_NAME);
  });

  it("resolves the socket name from the same env seam", () => {
    expect(resolveSocketName({})).toBe(DEFAULT_SOCKET_NAME);
    expect(resolveSocketName({ [TMUX_SOCKET_ENV]: "gate-x" })).toBe("gate-x");
  });
});
