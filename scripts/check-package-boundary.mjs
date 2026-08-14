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

export const PACKAGE_BOUNDARY_EXCEPTIONS = [];

export function checkPackageBoundaries(root = process.cwd()) {
  const packagesRoot = path.join(root, "packages");
  const packageRoots = fs.existsSync(packagesRoot)
    ? fs.readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesRoot, entry.name))
      .sort()
    : [];
  const runtimeFiles = packageRoots.flatMap((packageRoot) => walk(packageRoot))
    .filter((file) => /\.(?:tsx?|cjs)$/.test(file))
    .sort();
  const fileSet = new Set(runtimeFiles);
  const violations = [];
  const unresolved = [];
  const packageNames = new Map(packageRoots.map((packageRoot) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return [manifest.name, { packageRoot, manifest }];
  }));

  for (const importer of runtimeFiles) {
    const packageRoot = packageRoots.find((candidate) => importer.startsWith(`${candidate}${path.sep}`));
    if (!packageRoot) continue;
    const source = ts.createSourceFile(importer, fs.readFileSync(importer, "utf8"), ts.ScriptTarget.Latest, true);
    visitSpecifiers(source, (specifier) => {
      const workspaceName = [...packageNames.keys()].find((name) => specifier === name || specifier.startsWith(`${name}/`));
      if (workspaceName) {
        const targetPackage = packageNames.get(workspaceName);
        if (targetPackage.packageRoot !== packageRoot) {
          const manifest = packageNames.get(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).name).manifest;
          const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
          if (!declared[workspaceName]) {
            violations.push({
              importer: relative(root, importer),
              specifier,
              target: relative(root, targetPackage.packageRoot),
              packageRoot: relative(root, packageRoot),
              reason: `workspace dependency ${workspaceName} is not declared`,
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
      if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) {
        violations.push({
          importer: relative(root, importer),
          specifier,
          target: relative(root, target),
          packageRoot: relative(root, packageRoot),
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
