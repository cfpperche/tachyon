import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const entry = path.join(repoRoot, "src", "engine-service", "engineService.ts");
const visited = new Set();
const parent = new Map();
const queue = [entry];

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
    if (!specifier.startsWith(".")) continue;
    const resolved = resolveSource(file, specifier);
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

function resolveSource(importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    raw.replace(/\.jsx$/, ".tsx"),
    `${raw}.ts`,
    `${raw}.tsx`,
    path.join(raw, "index.ts"),
  ];
  return candidates.find((candidate) => candidate.startsWith(path.join(repoRoot, "src") + path.sep)
    && fs.existsSync(candidate)
    && fs.statSync(candidate).isFile());
}
