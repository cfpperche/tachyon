import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  resolveSource,
  unresolvedReason,
  visitSpecifiers,
  walk,
} from "./research/monorepo-imports.mjs";
import { workspaceDirectories } from "./workspace-layout.mjs";

export const PACKAGE_BOUNDARY_EXCEPTIONS = [];

export function checkPackageBoundaries(root = process.cwd()) {
  const workspaceRoots = workspaceDirectories(root);
  const runtimeFiles = workspaceRoots.flatMap((workspaceRoot) => walk(workspaceRoot))
    .filter((file) => /\.(?:tsx?|cjs)$/.test(file))
    .sort();
  const fileSet = new Set(runtimeFiles);
  const violations = [];
  const unresolved = [];
  const workspaceNames = new Map(workspaceRoots.map((workspaceRoot) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    return [manifest.name, { workspaceRoot, manifest }];
  }));

  for (const importer of runtimeFiles) {
    const workspaceRoot = workspaceRoots.find((candidate) => importer.startsWith(`${candidate}${path.sep}`));
    if (!workspaceRoot) continue;
    const manifest = workspaceNames.get(JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")).name).manifest;
    const source = ts.createSourceFile(importer, fs.readFileSync(importer, "utf8"), ts.ScriptTarget.Latest, true);
    visitSpecifiers(source, (specifier) => {
      const dependencyName = [...workspaceNames.keys()].find((name) => specifier === name || specifier.startsWith(`${name}/`));
      if (dependencyName) {
        const targetWorkspace = workspaceNames.get(dependencyName);
        if (targetWorkspace.workspaceRoot !== workspaceRoot) {
          const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
          if (!declared[dependencyName]) {
            violations.push({
              importer: relative(root, importer),
              specifier,
              target: relative(root, targetWorkspace.workspaceRoot),
              packageRoot: relative(root, workspaceRoot),
              reason: `workspace dependency ${dependencyName} is not declared`,
            });
          }
        }
        return;
      }
      if (!specifier.startsWith(".")) return;
      const lexicalTarget = path.resolve(path.dirname(importer), specifier);
      const resolved = resolveSource(importer, specifier, fileSet);
      if (!resolved) {
        unresolved.push({ importer: relative(root, importer), specifier, reason: unresolvedReason(importer, specifier) });
      }
      const target = resolved ?? lexicalTarget;
      if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
        violations.push({
          importer: relative(root, importer),
          specifier,
          target: relative(root, target),
          packageRoot: relative(root, workspaceRoot),
        });
      }
    });
  }
  return { violations, unresolved };
}

function relative(root, file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function printReport(result) {
  if (result.unresolved.length) {
    console.log(`package boundary: ${result.unresolved.length} unresolved relative import(s):`);
    for (const edge of result.unresolved) console.log(`  ${edge.importer} -> ${edge.specifier}: ${edge.reason}`);
  }
  if (result.violations.length) {
    console.error(`package boundary: ${result.violations.length} relative import(s) cross a package boundary:`);
    for (const edge of result.violations) {
      console.error(`  ${edge.importer} -> ${edge.specifier}: ${edge.reason ?? `resolves to ${edge.target}, outside ${edge.packageRoot}`}`);
    }
    return 1;
  }
  console.log(`package boundary: ok (${result.unresolved.length} unresolved relative import(s) reported)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1]) : process.cwd();
  process.exitCode = printReport(checkPackageBoundaries(root));
}
