#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { visitSpecifiers, walk } from "./research/monorepo-imports.mjs";

export const ROOT_SHELL_ALLOW = Object.freeze([
  {
    prefix: "src/webview/",
    reason: "Root-owned fixture hosts and compatibility shims are VS Code shell/test surfaces, not engine or browser-package code.",
  },
]);

export function checkVscodeImportBoundaries(root = process.cwd(), shellAllow = ROOT_SHELL_ALLOW) {
  const scopes = [
    { directory: "src", allowShell: true },
    { directory: "packages/engine/src", allowShell: false },
    { directory: "packages/webview-ui/src", allowShell: false },
  ];
  const filesByScope = scopes.map((scope) => ({
    ...scope,
    files: walk(path.join(root, scope.directory)).filter((file) => /\.tsx?$/.test(file)).sort(),
  }));
  const rootFiles = filesByScope[0].files.map((file) => relative(root, file));
  const staleAllowEntries = shellAllow.filter((entry) => !rootFiles.some((file) => file.startsWith(entry.prefix)));
  const offenders = [];

  for (const scope of filesByScope) {
    for (const file of scope.files) {
      const rel = relative(root, file);
      if (scope.allowShell && shellAllow.some((entry) => rel.startsWith(entry.prefix))) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const kinds = new Set();
      visitSpecifiers(source, (specifier, kind) => {
        if (specifier === "vscode") kinds.add(kind);
      });
      if (kinds.size) offenders.push({ file: rel, kinds: [...kinds].sort() });
    }
  }

  return { offenders, staleAllowEntries };
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function main() {
  const result = checkVscodeImportBoundaries();
  if (result.staleAllowEntries.length) {
    process.stderr.write("engine-boundary: FAIL — shell allowlist entries match zero root source files:\n");
    for (const entry of result.staleAllowEntries) {
      process.stderr.write(`  ${entry.prefix}: ${entry.reason}\n`);
    }
  }
  if (result.offenders.length) {
    process.stderr.write("engine-boundary: FAIL — vscode imports outside the live root shell allowlist:\n");
    for (const offender of result.offenders) {
      process.stderr.write(`  ${offender.file} (${offender.kinds.join("+")})\n`);
    }
  }
  if (result.staleAllowEntries.length || result.offenders.length) {
    process.stderr.write("Move the VS Code touchpoint into the app shell or behind an engine protocol/port. packages/engine and packages/webview-ui allow zero vscode imports, including type-only imports.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("engine-boundary: OK — root allowlist is live; engine and webview-ui have zero vscode imports (value or type)\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
