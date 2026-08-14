import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveSource, resolveWorkspaceSource, walk } from "./research/monorepo-imports.mjs";

const repoRoot = process.cwd();
const engineRoot = path.join(repoRoot, "packages", "engine", "src");
const entries = ["engineService.ts", "daemonMain.ts"].map((name) => path.join(engineRoot, "engine-service", name));
const sourceFiles = [
  ...walk(engineRoot),
  ...walk(path.join(repoRoot, "packages", "shared")),
].filter((file) => /\.(?:tsx?|cjs)$/.test(file));
const fileSet = new Set(sourceFiles);
const visited = new Set();
const parent = new Map();
const queue = [...entries];

while (queue.length > 0) {
  const file = queue.shift();
  if (!file || visited.has(file)) continue;
  visited.add(file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const specifier of runtimeSpecifiers(source)) {
    if (specifier === "vscode") {
      const chain = [file];
      while (parent.has(chain[0])) chain.unshift(parent.get(chain[0]));
      process.stderr.write("engine-boundary: FAIL — persistent engine transitively imports 'vscode':\n");
      process.stderr.write(`${chain.map((item) => path.relative(repoRoot, item)).join(" -> ")} -> vscode\n`);
      process.exit(1);
    }
    const resolved = specifier.startsWith(".")
      ? resolveSource(file, specifier, fileSet)
      : resolveWorkspaceSource(repoRoot, specifier, fileSet);
    if (!resolved || visited.has(resolved)) continue;
    if (!parent.has(resolved)) parent.set(resolved, file);
    queue.push(resolved);
  }
}

process.stdout.write(`engine-boundary: OK — daemon import closure is vscode-free (${visited.size} files)\n`);

function runtimeSpecifiers(source) {
  const output = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const onlyTypeSpecifiers = named && ts.isNamedImports(named)
        && named.elements.length > 0
        && named.elements.every((element) => element.isTypeOnly);
      if (!clause?.isTypeOnly && !onlyTypeSpecifiers) output.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) output.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        output.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return output;
}
