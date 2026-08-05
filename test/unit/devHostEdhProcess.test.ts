import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { electronBinaryFor, pickEdhPid, readProcessTable } from "../../scripts/dev-host/edh-process.mjs";

/**
 * t-5fc17d — which process is the Dev Host?
 *
 * The harness used to answer "the pid I spawned", and that pid is never the EDH: `bin/code` is a
 * shell wrapper around `cli.js`, which spawns the real Electron DETACHED and exits. Measured on
 * 2026-08-05, `headless-session.mjs up` recorded 969784 while the process serving CDP on 9405 was
 * 969804 — so `status` answered {"live":false} about a healthy window, before any reload had been
 * issued, and that false negative is what got read as "the extension host dies on reload".
 *
 * Three processes carry our command line during a launch and only one of them is the app, so the
 * argv rows below are the real measured shapes rather than invented ones.
 */

const INSTALL = "/home/goat/tachyon/.vscode-test/vscode-linux-x64-1.128.0";
const ELECTRON = `${INSTALL}/code`;
const LAUNCHER = `${INSTALL}/bin/code`;
const PORT = 9405;

/** The arguments every one of the three processes inherits. */
const COMMON = [
  "--extensionDevelopmentPath=/home/goat/.cache/tachyon/worktrees/b349073a/reloadcross",
  "--disable-workspace-trust",
  `--remote-debugging-port=${PORT}`,
  "--new-window",
];

/** `#!/usr/bin/env sh` — the kernel hands the script to the interpreter. */
const shWrapper = { pid: 969784, argv: ["sh", LAUNCHER, ...COMMON] };
/** `ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"` — same argv[0] as the app, but it is the shim. */
const cliShim = { pid: 969790, argv: [ELECTRON, `${INSTALL}/resources/app/out/cli.js`, ...COMMON] };
/** The detached app; reparented to init, and the one that owns the CDP socket. */
const electronMain = { pid: 969804, argv: [ELECTRON, ...COMMON] };

describe("dev-host EDH process resolution", () => {
  it("picks the detached Electron app, not the launcher shims that carry the same argv", () => {
    const table = [shWrapper, cliShim, electronMain];
    expect(pickEdhPid(table, { port: PORT, electronBin: ELECTRON })).toBe(969804);
  });

  it("rejects the cli.js shim even though its argv[0] IS the electron binary", () => {
    // Without the shim check, preferring an exact argv[0] match would select cli.js — the one
    // candidate that looks most like the app and is guaranteed to be gone moments later.
    expect(pickEdhPid([cliShim, electronMain], { port: PORT, electronBin: ELECTRON })).toBe(969804);
    expect(pickEdhPid([cliShim], { port: PORT, electronBin: ELECTRON })).toBeUndefined();
  });

  it("still resolves when the electron path is unknown, by discarding the shims", () => {
    expect(pickEdhPid([shWrapper, cliShim, electronMain], { port: PORT })).toBe(969804);
  });

  it("ignores renderer/gpu/utility children, which inherit the port switch", () => {
    const renderer = { pid: 969880, argv: [ELECTRON, "--type=renderer", ...COMMON] };
    const gpu = { pid: 969825, argv: [ELECTRON, "--type=gpu-process", ...COMMON] };
    const utility = { pid: 969950, argv: [ELECTRON, "--type=utility", "--utility-sub-type=node.mojom.NodeService", ...COMMON] };
    const table = [renderer, gpu, utility, electronMain];
    expect(pickEdhPid(table, { port: PORT, electronBin: ELECTRON })).toBe(969804);
    // …and with no main present it reports nothing rather than nominating a child.
    expect(pickEdhPid([renderer, gpu, utility], { port: PORT, electronBin: ELECTRON })).toBeUndefined();
  });

  it("matches the port as a whole argument, so 9405 never selects 94050", () => {
    const decoy = { pid: 111, argv: [ELECTRON, "--remote-debugging-port=94050"] };
    expect(pickEdhPid([decoy], { port: PORT, electronBin: ELECTRON })).toBeUndefined();
    expect(pickEdhPid([decoy, electronMain], { port: PORT, electronBin: ELECTRON })).toBe(969804);
    expect(pickEdhPid([decoy], { port: 94050, electronBin: ELECTRON })).toBe(111);
  });

  it("reports nothing when no process owns the port", () => {
    expect(pickEdhPid([], { port: PORT })).toBeUndefined();
    expect(pickEdhPid([electronMain], { port: 9999 })).toBeUndefined();
  });

  it("requires a port rather than silently matching everything", () => {
    expect(() => pickEdhPid([electronMain], { port: 0 } as never)).toThrow(/port is required/);
  });

  it("maps the bin/code launcher to the app binary one directory up", () => {
    expect(electronBinaryFor(LAUNCHER)).toBe(ELECTRON);
    // An explicit binary (TACHYON_DEV_HOST_CODE) is already the app.
    expect(electronBinaryFor(ELECTRON)).toBe(ELECTRON);
    expect(electronBinaryFor(undefined)).toBeUndefined();
  });

  it("reads argv arrays out of a /proc-shaped tree, NUL-separated and without empty tails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "edh-proc-"));
    try {
      fs.mkdirSync(path.join(root, "4242"));
      fs.writeFileSync(path.join(root, "4242", "cmdline"), `${ELECTRON}\0--remote-debugging-port=${PORT}\0`);
      fs.mkdirSync(path.join(root, "self"));            // non-numeric entries are not processes
      fs.writeFileSync(path.join(root, "self", "cmdline"), "ignored\0");
      fs.mkdirSync(path.join(root, "77"));              // kernel threads have an empty cmdline
      fs.writeFileSync(path.join(root, "77", "cmdline"), "");

      const table = readProcessTable(root);
      expect(table).toEqual([{ pid: 4242, argv: [ELECTRON, `--remote-debugging-port=${PORT}`] }]);
      expect(pickEdhPid(table, { port: PORT, electronBin: ELECTRON })).toBe(4242);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
