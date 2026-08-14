import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  engineWorkspaceKey,
  engineSystemdUnitName,
  engineRuntimeDir,
  engineStorageRoot,
} from "@tachyon/engine/engine-service/engineSupervisor.js";
import { TMUX_SOCKET_ENV, resolveSocketName, DEFAULT_SOCKET_NAME } from "@tachyon/engine/tmux/TmuxService.js";

/**
 * t-05097f — an engine that runs against an isolated tmux server must BE a different engine.
 *
 * Every durable handle hangs off `engineWorkspaceKey`: control socket, state dir, systemd unit.
 * Isolating only the unit name did nothing, because `ensure` finds a healthy engine by control
 * socket and attaches before the unit name is ever consulted — measured across a whole gate run,
 * where no isolated unit existed at any instant while the shared one kept serving.
 */
describe("t-05097f engine identity carries tmux isolation", () => {
  const root = makeTempDir("engine-identity-");

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

  /**
   * The doc above promises the three durable handles "move together". Nothing was checking that they
   * do: the tests reached only the key and the unit name, and three of the four derivation sites were
   * in fact asking for the key WITHOUT the env they had been handed — so `engineRuntimeDir(root, iso)`
   * returned production's control socket while `engineSystemdUnitName(root, iso)` returned the
   * isolated unit. Every caller happens to pass `process.env` today, which is why it never showed;
   * the parameter was a promise the function did not keep, and the first caller to hand over an
   * explicit env would have adopted the fleet's engine while believing it was isolated.
   */
  describe("every durable handle moves with the identity, not just the unit name", () => {
    const iso = {
      [TMUX_SOCKET_ENV]: "gate-together",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_STATE_HOME: "/home/someone/.local/state",
    };
    const prod = { XDG_RUNTIME_DIR: "/run/user/1000", XDG_STATE_HOME: "/home/someone/.local/state" };

    it("puts the isolated key in the runtime dir, the storage root and the unit alike", () => {
      const key = engineWorkspaceKey(root, iso);

      expect(engineRuntimeDir(root, iso)).toContain(key);
      expect(engineStorageRoot(root, "linux", iso, "/home/someone")).toContain(key);
      expect(engineSystemdUnitName(root, iso)).toContain(key);
    });

    it("keeps all of them on production's key when no override is given", () => {
      const key = engineWorkspaceKey(root, prod);

      expect(engineRuntimeDir(root, prod)).toContain(key);
      expect(engineStorageRoot(root, "linux", prod, "/home/someone")).toContain(key);
      expect(engineSystemdUnitName(root, prod)).toContain(key);
    });

    it("never lets an isolated handle collide with a production one", () => {
      expect(engineRuntimeDir(root, iso)).not.toBe(engineRuntimeDir(root, prod));
      expect(engineStorageRoot(root, "linux", iso, "/home/someone"))
        .not.toBe(engineStorageRoot(root, "linux", prod, "/home/someone"));
    });
  });
});
