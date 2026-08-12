import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Owned ESM CLI; Vitest loads it directly while the repo typecheck target is CommonJS.
// @ts-expect-error -- static ESM import is intentional for this executable module test (same as pointer.mjs).
import { electronBinaryFor, pickEdhPid, readProcessTable, tokenizeCmdline } from "../../scripts/dev-host/edh-process.mjs";

/**
 * t-5fc17d — which process is the Dev Host?
 *
 * The harness used to answer "the pid I spawned", and that pid is never the EDH: `bin/code` is a
 * shell wrapper around `cli.js`, which spawns the real Electron DETACHED and exits. Measured on
 * 2026-08-05, `headless-session.mjs up` recorded 969784 while the process serving CDP on 9405 was
 * 969804 — so `status` answered {"live":false} about a healthy window, before any reload had been
 * issued, and that false negative is what got read as "the extension host dies on reload".
 *
 * Every argv below was CAPTURED from a real launch (port 9407, pids 1384234/1384238/1384251/
 * 1384318), not imagined. That distinction is not decoration: the first version of this file
 * assumed every process reports an ordinary NUL-separated argv, passed all of its cases, and the
 * fix it was guarding did not work at all — Electron rewrites its process title, so the app and its
 * `--type=` children report the whole command line as ONE blob. The invented fixture agreed with
 * the code and both were wrong about the machine.
 */

const INSTALL = "/home/goat/tachyon/.vscode-test/vscode-linux-x64-1.128.0";
const ELECTRON = `${INSTALL}/code`;
const LAUNCHER = `${INSTALL}/bin/code`;
const PORT = 9407;

const APP_ARGS = [
  "--extensionDevelopmentPath=/home/goat/.cache/tachyon/worktrees/b349073a/reloadcross",
  "--disable-workspace-trust",
  `--remote-debugging-port=${PORT}`,
  "--new-window",
];

/** `#!/usr/bin/env sh` — ordinary argv, argv[0] is the interpreter. */
const shWrapper = { pid: 1384234, argv: ["sh", LAUNCHER, ...APP_ARGS] };
/** `ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" …` — ordinary argv, and note the `bin/..` path form. */
const cliShim = {
  pid: 1384238,
  argv: [`${INSTALL}/bin/../code`, `${INSTALL}/bin/../resources/app/out/cli.js`, ...APP_ARGS],
};
/** The detached app. Its whole command line arrives as a single blob (see tokenizeCmdline). */
const electronMain = { pid: 1384251, argv: [ELECTRON, ...APP_ARGS] };

describe("dev-host EDH process resolution", () => {
  it("splits Electron's rewritten process title, which arrives as one blob", () => {
    // Captured shape: one NUL-terminated entry holding the entire command line.
    const blob = `${ELECTRON} --extensionDevelopmentPath=/x --remote-debugging-port=${PORT} --new-window /ws\0`;
    expect(tokenizeCmdline(blob)).toEqual([
      ELECTRON, "--extensionDevelopmentPath=/x", `--remote-debugging-port=${PORT}`, "--new-window", "/ws",
    ]);
    // …while an ordinary NUL-separated argv is left exactly as it is.
    expect(tokenizeCmdline(`sh\0${LAUNCHER}\0--new-window\0`)).toEqual(["sh", LAUNCHER, "--new-window"]);
    // A single argument with no spaces is still just that argument.
    expect(tokenizeCmdline("Xvfb\0")).toEqual(["Xvfb"]);
  });

  it("resolves the app from a blob cmdline, the shape that actually ships", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "edh-proc-blob-"));
    try {
      const write = (pid: number, cmdline: string) => {
        fs.mkdirSync(path.join(root, String(pid)));
        fs.writeFileSync(path.join(root, String(pid), "cmdline"), cmdline);
      };
      write(1384234, ["sh", LAUNCHER, ...APP_ARGS].join("\0") + "\0");
      write(1384238, cliShim.argv.join("\0") + "\0");
      write(1384251, `${[ELECTRON, ...APP_ARGS].join(" ")}\0`);                       // blob
      write(1384318, `${[ELECTRON, "--type=renderer", ...APP_ARGS].join(" ")}\0`);    // blob child

      expect(pickEdhPid(readProcessTable(root), { port: PORT, electronBin: ELECTRON })).toBe(1384251);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("picks the detached app, not the launcher shims that carry the same argv", () => {
    expect(pickEdhPid([shWrapper, cliShim, electronMain], { port: PORT, electronBin: ELECTRON })).toBe(1384251);
  });

  it("rejects the cli.js shim even though its argv[0] resolves to the electron binary", () => {
    // Without the shim check, preferring an exact argv[0] match could select cli.js — the candidate
    // that looks most like the app and is guaranteed to be gone moments later.
    expect(pickEdhPid([cliShim, electronMain], { port: PORT, electronBin: ELECTRON })).toBe(1384251);
    expect(pickEdhPid([cliShim], { port: PORT, electronBin: ELECTRON })).toBeUndefined();
    expect(pickEdhPid([shWrapper], { port: PORT, electronBin: ELECTRON })).toBeUndefined();
  });

  it("still resolves when the electron path is unknown, by discarding the shims", () => {
    expect(pickEdhPid([shWrapper, cliShim, electronMain], { port: PORT })).toBe(1384251);
  });

  it("ignores renderer/gpu/utility children, which DO inherit the port switch", () => {
    // Measured: the renderers really do carry --remote-debugging-port, so this filter is load-bearing.
    const renderer = { pid: 1384318, argv: [ELECTRON, "--type=renderer", ...APP_ARGS] };
    const gpu = { pid: 1384260, argv: [ELECTRON, "--type=gpu-process", ...APP_ARGS] };
    const utility = { pid: 1384400, argv: [ELECTRON, "--type=utility", "--utility-sub-type=node.mojom.NodeService", ...APP_ARGS] };
    expect(pickEdhPid([renderer, gpu, utility, electronMain], { port: PORT, electronBin: ELECTRON })).toBe(1384251);
    // …and with no main present it reports nothing rather than nominating a child.
    expect(pickEdhPid([renderer, gpu, utility], { port: PORT, electronBin: ELECTRON })).toBeUndefined();
  });

  it("matches the port as a whole token, so 9407 never selects 94070", () => {
    const decoy = { pid: 111, argv: [ELECTRON, "--remote-debugging-port=94070"] };
    expect(pickEdhPid([decoy], { port: PORT, electronBin: ELECTRON })).toBeUndefined();
    expect(pickEdhPid([decoy, electronMain], { port: PORT, electronBin: ELECTRON })).toBe(1384251);
    expect(pickEdhPid([decoy], { port: 94070, electronBin: ELECTRON })).toBe(111);
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

  it("skips non-numeric /proc entries and kernel threads with an empty cmdline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "edh-proc-"));
    try {
      fs.mkdirSync(path.join(root, "4242"));
      fs.writeFileSync(path.join(root, "4242", "cmdline"), `${ELECTRON}\0--remote-debugging-port=${PORT}\0`);
      fs.mkdirSync(path.join(root, "self"));
      fs.writeFileSync(path.join(root, "self", "cmdline"), "ignored\0");
      fs.mkdirSync(path.join(root, "77"));
      fs.writeFileSync(path.join(root, "77", "cmdline"), "");

      expect(readProcessTable(root)).toEqual([
        {
          pid: 4242,
          argv: [ELECTRON, `--remote-debugging-port=${PORT}`],
          rawCmdline: `${ELECTRON}\0--remote-debugging-port=${PORT}\0`,
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
