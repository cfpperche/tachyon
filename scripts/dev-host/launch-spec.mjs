/**
 * t-6bc30d — one description of how the Dev Host is launched.
 *
 * The human presses F5, which reads `.vscode/launch.json`. The headless harness spawned VS Code from
 * a command line it assembled itself and never looked at that file. Two hand-maintained descriptions
 * of the same launch: a green headless run said nothing about the path the maintainer actually uses,
 * and the two were free to drift silently. That already happened — spec 448 inverted the dev-host
 * root, headless went green (`{"ok":true}`, the extension host activated), and the maintainer's F5
 * opened an empty phantom workspace.
 *
 * This module owns the shared half. The headless harness builds its command from here, and a test
 * asserts `launch.json` declares the same environment and arguments. Neither replaces the other:
 * F5 stays the real path, headless stays automatable, and they can no longer disagree quietly.
 */

import path from "node:path";

/**
 * Environment the extension host needs, identical on both paths. `slotRoot` is the armed dev-host
 * directory — `${workspaceFolder}/.tachyon/dev-host` for F5, the pointer-resolved slot for headless.
 */
export function devHostEnv(slotRoot) {
  return {
    TACHYON_DEV_HOST: "1",
    TACHYON_DEV_HOST_ENGINE_RUNTIME: path.join(slotRoot, "runtime"),
    TACHYON_DEV_HOST_PROFILE_HOME: path.join(slotRoot, "profile-home"),
    XDG_CACHE_HOME: path.join(slotRoot, "cache"),
    XDG_STATE_HOME: path.join(slotRoot, "state"),
    XDG_DATA_HOME: path.join(slotRoot, "data"),
  };
}

/**
 * The arguments that DEFINE what is being run: which workspace, which extension, and the trust
 * prompt that would otherwise block an unattended start.
 *
 * Deliberately not included: headless-only plumbing (--user-data-dir, --remote-debugging-port,
 * --disable-gpu, …). Those exist because nobody is watching, and requiring launch.json to carry them
 * would be forcing the human path to look like the robot one instead of the reverse.
 */
export function devHostArgs({ workspaceDir, extensionPath }) {
  return [workspaceDir, `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust"];
}

/** The env keys F5 and headless must agree on — the comparison's own subject, kept in one place. */
export const DEV_HOST_ENV_KEYS = Object.keys(devHostEnv("/x"));
