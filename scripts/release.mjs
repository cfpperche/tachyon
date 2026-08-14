#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restoreDevelopmentManifest, withProductManifest } from "./prepare-package.mjs";
import { extensionWorkspace } from "./workspace-layout.mjs";

function runCommand(command, args, cwd = process.cwd()) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/**
 * Build, validate, package, and smoke one release as a single aborting operation.
 *
 * Keep the packaging binary inside this process instead of exposing it as an npm script: if any
 * precondition exits non-zero, execFileSync throws and neither `vsce package` nor the smoke can run.
 */
export function runRelease({ args = [], run = runCommand, root = process.cwd() } = {}) {
  const extensionRoot = extensionWorkspace(root).directory;
  restoreDevelopmentManifest(extensionRoot);
  run("npm", ["run", "build:stable"]);
  run("npm", ["run", "package:assert"]);
  withProductManifest(
    extensionRoot,
    () => run("vsce", ["package", "--no-dependencies", ...args], extensionRoot),
    { repositoryRoot: root },
  );
  run("npm", ["run", "smoke:vsix"]);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runRelease({ args: process.argv.slice(2) });
}
