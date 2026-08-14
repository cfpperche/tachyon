import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export function visitSpecifiers(source, emit) {
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) emit(node.moduleSpecifier.text, "type");
      else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        const values = elements.filter((element) => !element.isTypeOnly);
        const types = elements.filter((element) => element.isTypeOnly);
        if (values.length || clause.name) emit(node.moduleSpecifier.text, "value");
        if (types.length) emit(node.moduleSpecifier.text, "type");
      } else emit(node.moduleSpecifier.text, "value");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      emit(node.moduleSpecifier.text, node.isTypeOnly ? "type" : "value");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      emit(node.argument.literal.text, "type");
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        emit(node.arguments[0].text, "value");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

export function countRelativeSpecifierOccurrences(source) {
  let count = 0;
  visitSpecifiers(source, (specifier) => {
    if (specifier.startsWith(".")) count++;
  });
  return count;
}

export function resolveSource(importer, specifier, fileSet) {
  const raw = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    raw.replace(/\.js$/, ".tsx"),
    raw.replace(/\.jsx$/, ".tsx"),
    `${raw}.ts`,
    `${raw}.tsx`,
    path.join(raw, "index.ts"),
    path.join(raw, "index.tsx"),
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

export function resolveWorkspaceSource(root, specifier, fileSet) {
  const prefix = "@tachyon/shared/";
  if (!specifier.startsWith(prefix)) return undefined;
  const subpath = specifier.slice(prefix.length);
  const raw = subpath.endsWith(".cjs")
    ? path.join(root, "packages", "shared", subpath)
    : path.join(root, "packages", "shared", "src", subpath);
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    raw.replace(/\.js$/, ".tsx"),
    `${raw}.ts`,
    `${raw}.tsx`,
    path.join(raw, "index.ts"),
    path.join(raw, "index.tsx"),
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

export function unresolvedReason(importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier);
  if (path.extname(raw) === ".json" && fs.existsSync(raw)) return "JSON asset intentionally outside the TS/CJS runtime graph";
  return "no matching TS/TSX/CJS runtime source";
}

export function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
